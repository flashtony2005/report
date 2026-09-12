/**
 * PrintMath —— 数学公式控件（类比 PrintChart）
 *
 * 与 PrintChart 同属【方案 A】：**视觉**完全交给 HTML overlay（MathViewLayer.vue），
 * 本 Fabric 对象退化为「透明宿主」——只承担选中 / 拖拽 / 缩放手柄 / 层级 / 序列化，
 * 位图上仅画一圈极淡虚线轮廓作为兜底。KaTeX HTML 由 mathkit 生成，
 * 设计期 overlay 渲染真实公式，导出走和正文相同的栅格化路径（高清不糊）。
 */
import { FabricImage } from 'fabric'
import type { MathControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'

/** overlay 兜底轮廓色（极淡，正常情况下被 overlay 的真实公式完全覆盖） */
const GHOST_COLOR = 'rgba(120,130,145,0.35)'

export class PrintMath extends FabricImage implements IPrintObject {
  controlId: string
  controlType = 'math' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  latex: string
  displayMode: boolean
  fontSize: number
  color: string

  /** true = 视觉交给 HTML overlay，位图只画兜底轮廓 */
  htmlPreview = true

  constructor(control: MathControl) {
    super(document.createElement('canvas'), {
      left: mm(control.left),
      top: mm(control.top),
      angle: control.angle ?? 0,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.latex = control.latex ?? ''
    this.displayMode = control.displayMode ?? true
    this.fontSize = control.fontSize ?? 16
    this.color = control.color ?? '#000000'
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
    this.drawGhost(ctx, w, h)
    // setElement 会重置 width/height 为位图像素尺寸，缩放须在 setElement 之后按新尺寸计算
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

  toControl(): MathControl {
    return {
      ...readBaseGeometry(this),
      id: this.controlId,
      type: 'math',
      latex: this.latex,
      displayMode: this.displayMode,
      fontSize: this.fontSize,
      color: this.color,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: MathControl): void {
    this.latex = control.latex ?? ''
    this.displayMode = control.displayMode ?? true
    this.fontSize = control.fontSize ?? 16
    this.color = control.color ?? '#000000'
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
