/**
 * PrintCircle —— 圆形控件（复用 rect 协议模型，shape:'circle' 时以 Ellipse 渲染）
 */
import { Ellipse } from 'fabric'
import type { RectControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'

export class PrintCircle extends Ellipse implements IPrintObject {
  controlId: string
  controlType = 'rect' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  constructor(control: RectControl) {
    super({
      left: mm(control.left),
      top: mm(control.top),
      rx: mm(control.width) / 2,
      ry: mm(control.height) / 2,
      angle: control.angle ?? 0,
      fill: control.fill ?? 'transparent',
      stroke: control.stroke ?? '#000000',
      strokeWidth: control.strokeWidth ?? 1,
      strokeDashArray: control.strokeDashArray ?? undefined,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
  }

  toControl(): RectControl {
    return {
      ...readBaseGeometry(this),
      type: 'rect',
      shape: 'circle',
      fill: typeof this.fill === 'string' ? this.fill : undefined,
      stroke: typeof this.stroke === 'string' ? this.stroke : undefined,
      strokeWidth: this.strokeWidth,
      strokeDashArray: this.strokeDashArray as number[] | undefined,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: RectControl): void {
    this.set({
      rx: mm(control.width) / 2,
      ry: mm(control.height) / 2,
      fill: control.fill ?? 'transparent',
      stroke: control.stroke ?? '#000000',
      strokeWidth: control.strokeWidth ?? 1,
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
