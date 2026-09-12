/**
 * PrintLabelGrid —— 标签网格控件（一张纸平铺 N 张标签卡）
 *
 * 设计期表现：容器虚线框 + 若干张卡片格位。**只设计第 1 张（白底主卡，蓝"可编辑"
 * 角标）**——首卡子组件以**真实 Fabric 对象**渲染在画布上（可选中/拖动/编辑，见
 * CanvasDesigner.syncGridChildren）；其余格位以浅灰底 + "复制"锁形角标呈现，仅用于
 * 布局占位，提示"运行期自动复制主卡"。
 * 运行期不认识本控件 —— 分页引擎在入口把它展开成一批普通控件（label-grid.ts），
 * 所以渲染 / 导出 / 打印链路零改动。
 *
 * 与 PrintTable 一致，本对象是 FabricImage 宿主：承担选中 / 拖拽 / 缩放 / 层级 / 序列化。
 *
 * 【序列化铁律】新增字段必须同步加到：实例字段 → constructor → toControl() → applyControlProps()
 * 四处，否则保存/加载会静默丢字段（历史坑：PrintTable.data）。
 */
import { FabricImage } from 'fabric'
import type { AnyControl, LabelGridControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'
import { ptToPx } from '@/core/units'
import { resolveGridGeometry, visibleCardRows } from '@/core/layout-engine/label-grid'

/** 容器虚线（品牌蓝，提示"这是一个网格容器"） */
const GRID_COLOR = 'rgba(37, 99, 235, 0.55)'
/** 卡片格位虚线 */
const CARD_COLOR = 'rgba(120, 130, 145, 0.75)'
const CARD_BG = '#ffffff'
const HINT_COLOR = '#8a9099'
const FONT_STACK = '"Source Han Sans CN", "PingFang SC", sans-serif'

/** 非首卡（锁定占位）配色：浅灰底 + 灰虚线框 */
const LOCKED_BG = 'rgba(148, 158, 172, 0.10)'
const LOCKED_BORDER = 'rgba(140, 150, 165, 0.55)'

/** 设计期最多画多少个格位（超大数据不必在画布上全画，避免卡顿） */
const MAX_PREVIEW_CARDS = 120

export class PrintLabelGrid extends FabricImage implements IPrintObject {
  controlId: string
  controlType = 'labelgrid' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  columns?: number
  gapX?: number
  gapY?: number
  cardWidth?: number
  cardHeight?: number
  showLines = true
  lineStyle?: 'solid' | 'dashed'
  /** 可选逐卡数据源数组路径（如 items），见 LabelGridControl.dataSource */
  dataSource?: string
  children: AnyControl[]

  constructor(control: LabelGridControl) {
    super(document.createElement('canvas'), {
      left: mm(control.left),
      top: mm(control.top),
      angle: control.angle ?? 0,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.columns = control.columns
    this.gapX = control.gapX
    this.gapY = control.gapY
    this.cardWidth = control.cardWidth
    this.cardHeight = control.cardHeight
    this.showLines = control.showLines ?? true
    this.lineStyle = control.lineStyle
    this.dataSource = control.dataSource
    this.children = control.children ?? []
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.set({ width: mm(control.width), height: mm(control.height) })
    this.regenerate()
  }

  /* ------------------------------ 设计期预览 ------------------------------ */

  regenerate(): void {
    const w = Math.max(this.width || 1, 10)
    const h = Math.max(this.height || 1, 10)
    const ratio = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(w * ratio)
    canvas.height = Math.ceil(h * ratio)
    const ctx = canvas.getContext('2d')!
    ctx.scale(ratio, ratio)

    this.draw(ctx, w, h)

    // setElement 会把 width/height 重置为位图像素尺寸，缩放必须在其后按新尺寸计算
    this.setElement(canvas)
    this.set({ scaleX: w / canvas.width, scaleY: h / canvas.height })
    this.setCoords()
    this.canvas?.requestRenderAll()
  }

  private draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.clearRect(0, 0, w, h)

    // 几何解析与渲染引擎共用同一函数，保证设计即打印
    const geo = resolveGridGeometry({
      width: this.widthMm,
      height: this.heightMm,
      columns: this.columns,
      gapX: this.gapX,
      gapY: this.gapY,
      cardWidth: this.cardWidth,
      cardHeight: this.cardHeight,
      children: this.children,
    })

    const cardW = mm(geo.cardWidth)
    const cardH = mm(geo.cardHeight)
    const gapX = mm(geo.gapX)
    const gapY = mm(geo.gapY)
    const rows = visibleCardRows(this.heightMm, geo)

    // 容器边框（默认实线；虚线由 lineStyle 决定；可关闭：showLines=false 时只留卡片底色）
    if (this.showLines) {
      ctx.strokeStyle = GRID_COLOR
      ctx.lineWidth = 0.75
      ctx.setLineDash(this.lineDash)
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
      ctx.setLineDash([])
    }

    let drawn = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < geo.columns; c++) {
        if (drawn >= MAX_PREVIEW_CARDS) return
        const x = c * (cardW + gapX)
        const y = r * (cardH + gapY)
        // 明显越界的格位不画（宽度被手动改小的情况）
        if (x >= w - 1 || y >= h - 1) continue
        // 第 1 张（drawn===0）是可编辑主卡；其余为自动复制的锁定占位卡
        this.drawCard(ctx, x, y, cardW, cardH, w, h, drawn === 0)
        drawn++
      }
    }

    if (this.children.length === 0) {
      ctx.fillStyle = HINT_COLOR
      ctx.font = `${ptToPx(9)}px ${FONT_STACK}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('空标签网格：从控件库拖入组件即可设计首卡', w / 2, h / 2)
      ctx.textAlign = 'left'
    }
  }

  /**
   * 画一个格位。
   * - active（第 1 张）= 可编辑主卡：白底 + 蓝虚线 + children 全彩 + "可编辑"角标。
   * - 其余 = 锁定占位卡：浅灰底 + 灰虚线 + children 淡化（alpha 0.38）+ "复制"锁形角标，
   *   提示"这部分只用于布局，运行期自动复制主卡内容"。
   */
  private drawCard(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    cardW: number,
    cardH: number,
    boundW: number,
    boundH: number,
    active: boolean,
  ): void {
    ctx.save()
    // 裁剪到容器与格位的交集，避免示意图画到网格外面
    ctx.beginPath()
    ctx.rect(0, 0, boundW, boundH)
    ctx.clip()

    // 背景：首卡白底，其余浅灰锁定
    ctx.fillStyle = active ? CARD_BG : LOCKED_BG
    ctx.fillRect(x, y, cardW, cardH)

    // 边框：首卡品牌蓝，其余灰（线型随 lineStyle；showLines=false 时统一不画框线）
    if (this.showLines) {
      ctx.strokeStyle = active ? CARD_COLOR : LOCKED_BORDER
      ctx.lineWidth = 0.5
      ctx.setLineDash(this.lineDash)
      ctx.strokeRect(x + 0.25, y + 0.25, cardW - 0.5, cardH - 0.5)
      ctx.setLineDash([])
    }

    // 首卡子组件以**真实 Fabric 对象**渲染在画布上（可选中/拖动/编辑），这里不再画示意图；
    // 非首卡为锁定占位，仅背景 + 角标提示"运行期自动复制主卡"。

    // 角标：首卡=可编辑，其余=复制/锁定
    this.drawCellTag(ctx, x, y, cardW, active)

    ctx.restore()
  }

  /** 格位角标：首卡蓝"可编辑"药丸，其余灰"复制"药丸 + 锁形 */
  private drawCellTag(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    cardW: number,
    active: boolean,
  ): void {
    ctx.save()
    const fs = 8
    ctx.font = `${fs}px ${FONT_STACK}`
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    const padX = 4
    const bh = fs + 4
    if (active) {
      const label = '可编辑'
      const tw = ctx.measureText(label).width
      const bw = tw + padX * 2
      ctx.fillStyle = GRID_COLOR
      ctx.fillRect(x + 2, y + 2, bw, bh)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, x + 2 + padX, y + 2 + 2)
    } else {
      const label = '复制'
      const lockW = 6
      const tw = ctx.measureText(label).width
      const bw = lockW + 3 + tw + padX * 2
      ctx.fillStyle = 'rgba(140, 150, 165, 0.9)'
      ctx.fillRect(x + cardW - bw - 2, y + 2, bw, bh)
      ctx.fillStyle = '#ffffff'
      drawLockGlyph(ctx, x + cardW - bw - 2 + padX + lockW / 2, y + 2 + bh / 2, lockW)
      ctx.fillText(label, x + cardW - bw - 2 + padX + lockW + 3, y + 2 + 2)
    }
    ctx.restore()
  }

  /* -------------------------------- 换算 -------------------------------- */

  /** 线型：实线为空数组，虚线为 [4,3] */
  private get lineDash(): number[] {
    return this.lineStyle === 'dashed' ? [4, 3] : []
  }

  private get widthMm(): number {
    return (this.width || 0) / mm(1)
  }

  private get heightMm(): number {
    return (this.height || 0) / mm(1)
  }

  /* ------------------------------- 序列化 ------------------------------- */

  toControl(): LabelGridControl {
    return {
      ...readBaseGeometry(this),
      type: 'labelgrid',
      columns: this.columns,
      gapX: this.gapX,
      gapY: this.gapY,
      cardWidth: this.cardWidth,
      cardHeight: this.cardHeight,
      showLines: this.showLines,
      lineStyle: this.lineStyle,
      dataSource: this.dataSource,
      children: this.children,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: LabelGridControl): void {
    this.columns = control.columns
    this.gapX = control.gapX
    this.gapY = control.gapY
    this.cardWidth = control.cardWidth
    this.cardHeight = control.cardHeight
    this.showLines = control.showLines ?? true
    this.lineStyle = control.lineStyle
    this.dataSource = control.dataSource
    this.children = control.children ?? []
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

/* ============================ 子控件示意图绘制 ============================ */

/** 极简挂锁图标（白色），用于锁定占位卡的"复制"角标 */
function drawLockGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const bodyW = s * 0.95
  const bodyH = s * 0.7
  const bodyX = cx - bodyW / 2
  const bodyY = cy - bodyH / 2 + s * 0.12
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(bodyX, bodyY, bodyW, bodyH)
  ctx.lineWidth = Math.max(0.7, s * 0.16)
  ctx.strokeStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(cx, bodyY, bodyW * 0.34, Math.PI, 0)
  ctx.stroke()
}

