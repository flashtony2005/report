/**
 * PrintTable —— 表格控件（《设计方案》§5.4）
 *
 * 【方案 A】表格的**视觉**由 HTML overlay（TableViewLayer.vue + table-design-render.ts）负责，
 * 与运行期 html-renderer 共用同一套类名与样式语义，做到设计即打印、零漂移。
 * 本 Fabric 对象退化为「透明宿主」：只承担选中 / 拖拽 / 缩放手柄 / 层级 / 序列化，
 * 位图上仅画一圈极淡的虚线轮廓，作为 overlay 未就绪时的兜底提示。
 *
 * 若把 `htmlPreview` 置为 false（单测 / 降级），则回落到旧的 Fabric 2D 预览。
 */
import { FabricImage } from 'fabric'
import type { TableCell, TableControl, TableColumn } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'
import { ptToPx } from '@/core/units'

const BORDER_COLOR = '#333333'
const HEADER_BG = '#F5F7FA'
const TEXT_COLOR = '#1f2329'
const PLACEHOLDER_COLOR = '#606266'
/** overlay 兜底轮廓色（极淡，正常情况下被 overlay 的真实边框完全覆盖） */
const GHOST_COLOR = 'rgba(120,130,145,0.35)'

export class PrintTable extends FabricImage implements IPrintObject {
  controlId: string
  controlType = 'table' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  dataSource?: string
  /** 内嵌数据行（导入数据场景；与 dataSource 解耦，运行期直接作为表格数据） */
  data?: Array<Record<string, unknown>>
  columns: TableColumn[]
  options: TableControl['options']
  /** 分组字段（§5.5 分组统计） */
  groupBy?: string
  /** 遗留合计配置（新模板统一走 options.summaryRow，保存时仍序列化以便回滚） */
  summary?: TableControl['summary']

  /** 设计期单元格网格（方案 A：双击可编辑的内容与样式载体） */
  cells?: TableCell[][]
  headerRows?: number
  staticRows?: number
  designRows?: number

  /** true = 视觉交给 HTML overlay，位图只画兜底轮廓 */
  htmlPreview = true

  constructor(control: TableControl) {
    super(document.createElement('canvas'), {
      left: mm(control.left),
      top: mm(control.top),
      angle: control.angle ?? 0,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.dataSource = control.dataSource
    this.data = control.data
    this.columns = control.columns
    this.options = control.options
    this.groupBy = control.groupBy
    this.summary = control.summary
    this.cells = control.cells
    this.headerRows = control.headerRows
    this.staticRows = control.staticRows
    this.designRows = control.designRows
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.set({ width: mm(control.width), height: mm(control.height) })
    this.regenerate()
  }

  /** 重绘设计期预览（2x 分辨率保证缩放清晰） */
  regenerate(): void {
    const w = Math.max(this.width || 1, 10)
    const h = Math.max(this.height || 1, 10)
    const ratio = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(w * ratio)
    canvas.height = Math.ceil(h * ratio)
    const ctx = canvas.getContext('2d')!
    ctx.scale(ratio, ratio)

    if (this.htmlPreview) {
      this.drawGhost(ctx, w, h)
    } else {
      this.drawLegacyPreview(ctx, w, h, ratio)
    }

    // 注意：setElement 会把 width/height 重置为位图像素尺寸，缩放必须在 setElement 之后按新尺寸计算
    this.setElement(canvas)
    this.set({ scaleX: w / canvas.width, scaleY: h / canvas.height })
    this.setCoords()
    this.canvas?.requestRenderAll()
  }

  /** overlay 模式：透明底 + 一圈极淡虚线，保证控件"存在感"且不与 overlay 抢像素 */
  private drawGhost(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = GHOST_COLOR
    ctx.lineWidth = 0.5
    ctx.setLineDash([3, 3])
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
    ctx.setLineDash([])
  }

  /** 旧版 Fabric 2D 预览（降级路径，行为与方案 A 之前一致） */
  private drawLegacyPreview(ctx: CanvasRenderingContext2D, w: number, h: number, ratio: number): void {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    const headerH = Math.min(28, h * 0.3)
    const dataRowH = Math.min(24, (h - headerH) / 4)
    const fontSize = ptToPx(9)

    // 列宽按比例分配（协议列宽是 mm，控件宽是 px，归一化即可）
    const totalColMm = this.columns.reduce((s, c) => s + c.width, 0) || 1
    const colXs: number[] = [0]
    for (const col of this.columns) {
      colXs.push(colXs[colXs.length - 1]! + (col.width / totalColMm) * w)
    }

    // 表头
    ctx.fillStyle = HEADER_BG
    ctx.fillRect(0, 0, w, headerH)
    ctx.font = `bold ${fontSize}px "Source Han Sans CN", "PingFang SC", sans-serif`
    ctx.fillStyle = TEXT_COLOR
    ctx.textBaseline = 'middle'
    this.columns.forEach((col, i) => {
      const x0 = colXs[i]!
      const cw = colXs[i + 1]! - x0
      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, 0, cw, headerH)
      ctx.clip()
      const tx = col.headerAlign === 'center' || (!col.headerAlign && col.align === 'center')
        ? x0 + cw / 2
        : col.headerAlign === 'right' || (!col.headerAlign && col.align === 'right')
          ? x0 + cw - 4
          : x0 + 4
      ctx.textAlign = col.headerAlign ?? col.align ?? 'left'
      ctx.fillText(col.title || '　', tx, headerH / 2)
      ctx.restore()
    })

    // 示例数据行（绑定字段占位符）
    ctx.font = `${fontSize}px "Source Han Sans CN", "PingFang SC", sans-serif`
    this.columns.forEach((col, i) => {
      const x0 = colXs[i]!
      const cw = colXs[i + 1]! - x0
      const cellText = col.expression ?? (col.field ? `{{item.${col.field}}}` : '')
      if (!cellText) return
      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, headerH, cw, dataRowH)
      ctx.clip()
      ctx.fillStyle = PLACEHOLDER_COLOR
      ctx.textAlign = col.align ?? 'left'
      const tx = col.align === 'center' ? x0 + cw / 2 : col.align === 'right' ? x0 + cw - 4 : x0 + 4
      ctx.fillText(cellText, tx, headerH + dataRowH / 2)
      ctx.restore()
    })

    // 边框线
    const borders = this.options?.borders ?? 'all'
    ctx.strokeStyle = BORDER_COLOR
    ctx.lineWidth = 1 / ratio > 0.5 ? 1 : 0.75
    if (borders !== 'none') {
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
      ctx.beginPath()
      ctx.moveTo(0, headerH)
      ctx.lineTo(w, headerH)
      ctx.stroke()
      if (borders === 'all') {
        for (let i = 1; i < colXs.length - 1; i++) {
          ctx.beginPath()
          ctx.moveTo(colXs[i]!, 0)
          ctx.lineTo(colXs[i]!, h)
          ctx.stroke()
        }
        for (let r = 1; r <= 2; r++) {
          const y = headerH + dataRowH * r
          if (y < h) {
            ctx.beginPath()
            ctx.moveTo(0, y)
            ctx.lineTo(w, y)
            ctx.stroke()
          }
        }
      }
    }
  }

  toControl(): TableControl {
    return {
      ...readBaseGeometry(this),
      type: 'table',
      dataSource: this.dataSource,
      data: this.data,
      columns: this.columns,
      options: this.options,
      groupBy: this.groupBy,
      summary: this.summary,
      cells: this.cells,
      headerRows: this.headerRows,
      staticRows: this.staticRows,
      designRows: this.designRows,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: TableControl): void {
    this.dataSource = control.dataSource
    this.data = control.data
    this.columns = control.columns
    this.options = control.options
    this.groupBy = control.groupBy
    this.summary = control.summary
    this.cells = control.cells
    this.headerRows = control.headerRows
    this.staticRows = control.staticRows
    this.designRows = control.designRows
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.set({
      lockMovementX: control.locked,
      lockMovementY: control.locked,
      scaleX: 1,
      scaleY: 1,
      width: mm(control.width),
      height: mm(control.height),
    })
    this.regenerate()
  }
}
