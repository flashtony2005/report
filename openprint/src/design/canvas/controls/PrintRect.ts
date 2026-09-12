/**
 * PrintRect —— 矩形控件
 *
 * 圆角走「四角独立半径」绘制：Fabric 原生 Rect 仅支持统一 rx/ry，
 * 这里重写 `_render`，用 arcTo 画出四角各自独立的圆角矩形路径，
 * 单位 px（与协议 cornerRadius* 一致）。
 */
import { Rect } from 'fabric'
import type { RectControl } from '@/types/control'
import { mm, px, readBaseGeometry, type IPrintObject } from './PrintObject'

/**
 * 以对象中心为原点绘制四角独立圆角的矩形路径。
 * ctx 进入时已被 Fabric 平移到对象中心（坐标范围 -w/2 ~ w/2），
 * 半径单位为对象本地像素（drawing space，未乘 scaleX/scaleY）。
 */
export function traceRoundRectPath(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
): void {
  const x = -w / 2
  const y = -h / 2
  // 单角半径上限取短边一半，避免相邻圆角重叠产生扭曲
  const maxR = Math.min(w, h) / 2
  const clamp = (r: number): number => Math.max(0, Math.min(Math.round(r), maxR))
  const a = clamp(tl)
  const b = clamp(tr)
  const c = clamp(br)
  const d = clamp(bl)
  ctx.beginPath()
  ctx.moveTo(x + a, y)
  ctx.lineTo(x + w - b, y)
  if (b > 0) ctx.arcTo(x + w, y, x + w, y + b, b)
  ctx.lineTo(x + w, y + h - c)
  if (c > 0) ctx.arcTo(x + w, y + h, x + w - c, y + h, c)
  ctx.lineTo(x + d, y + h)
  if (d > 0) ctx.arcTo(x, y + h, x, y + h - d, d)
  ctx.lineTo(x, y + a)
  if (a > 0) ctx.arcTo(x, y, x + a, y, a)
  ctx.closePath()
}

export class PrintRect extends Rect implements IPrintObject {
  controlId: string
  controlType = 'rect' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  /** 四角独立圆角（px），绘制时优先于 rx/ry */
  cornerRadiusTL = 0
  cornerRadiusTR = 0
  cornerRadiusBR = 0
  cornerRadiusBL = 0
  /** 统一圆角（px），四角独立值统一回落基准 */
  cornerRadius = 0

  constructor(control: RectControl) {
    const cr = control.cornerRadius ?? 0
    super({
      left: mm(control.left),
      top: mm(control.top),
      width: mm(control.width),
      height: mm(control.height),
      angle: control.angle ?? 0,
      fill: control.fill ?? 'transparent',
      stroke: control.stroke ?? '#000000',
      strokeWidth: control.strokeWidth ?? 1,
      rx: cr,
      ry: cr,
      strokeDashArray: control.strokeDashArray ?? undefined,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.cornerRadiusTL = control.cornerRadiusTL ?? cr
    this.cornerRadiusTR = control.cornerRadiusTR ?? cr
    this.cornerRadiusBR = control.cornerRadiusBR ?? cr
    this.cornerRadiusBL = control.cornerRadiusBL ?? cr
    this.cornerRadius = cr
  }

  /** 四角独立圆角路径绘制（覆盖 Fabric 原生统一 rx/ry） */
  _render(ctx: CanvasRenderingContext2D): void {
    traceRoundRectPath(
      ctx,
      this.width,
      this.height,
      this.cornerRadiusTL,
      this.cornerRadiusTR,
      this.cornerRadiusBR,
      this.cornerRadiusBL,
    )
    this._renderFill(ctx)
    this._renderStroke(ctx)
  }

  toControl(): RectControl {
    const cr = this.cornerRadius ?? 0
    const out: RectControl = {
      ...readBaseGeometry(this),
      type: 'rect',
      fill: typeof this.fill === 'string' ? this.fill : undefined,
      stroke: typeof this.stroke === 'string' ? this.stroke : undefined,
      strokeWidth: this.strokeWidth,
      cornerRadius: cr || undefined,
      strokeDashArray: this.strokeDashArray as number[] | undefined,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
    // 仅当某角与统一值不一致时才落盘为独立覆盖值，保持 JSON 干净
    if (this.cornerRadiusTL !== cr) out.cornerRadiusTL = this.cornerRadiusTL || undefined
    if (this.cornerRadiusTR !== cr) out.cornerRadiusTR = this.cornerRadiusTR || undefined
    if (this.cornerRadiusBR !== cr) out.cornerRadiusBR = this.cornerRadiusBR || undefined
    if (this.cornerRadiusBL !== cr) out.cornerRadiusBL = this.cornerRadiusBL || undefined
    return out
  }

  applyControlProps(control: RectControl): void {
    const cr = control.cornerRadius ?? 0
    this.cornerRadiusTL = control.cornerRadiusTL ?? cr
    this.cornerRadiusTR = control.cornerRadiusTR ?? cr
    this.cornerRadiusBR = control.cornerRadiusBR ?? cr
    this.cornerRadiusBL = control.cornerRadiusBL ?? cr
    this.cornerRadius = cr
    this.set({
      fill: control.fill ?? 'transparent',
      stroke: control.stroke ?? '#000000',
      strokeWidth: control.strokeWidth ?? 1,
      rx: cr,
      ry: cr,
      strokeDashArray: control.strokeDashArray ?? undefined,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.setCoords()
    this.canvas?.requestRenderAll()
  }
}
