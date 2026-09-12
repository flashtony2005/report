/**
 * PrintLine —— 线条控件
 * Fabric Line 用 x1/y1/x2/y2 四点 + left/top 定位；
 * 协议层只存外接框（left/top/width/height），MVP 仅支持水平/垂直线。
 */
import { Line } from 'fabric'
import type { LineControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'

export class PrintLine extends Line implements IPrintObject {
  controlId: string
  controlType = 'line' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  constructor(control: LineControl) {
    // 水平线：width 有效、height≈0；垂直线反之（MVP）
    const w = mm(control.width)
    const h = mm(control.height)
    const horizontal = h <= 1
    super([0, 0, horizontal ? w : 0, horizontal ? 0 : h], {
      left: mm(control.left),
      top: mm(control.top),
      angle: control.angle ?? 0,
      stroke: control.stroke ?? '#000000',
      strokeWidth: control.strokeWidth ?? 1,
      strokeDashArray: control.strokeDashArray,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
  }

  toControl(): LineControl {
    const geo = readBaseGeometry(this)
    return {
      ...geo,
      type: 'line',
      stroke: typeof this.stroke === 'string' ? this.stroke : undefined,
      strokeWidth: this.strokeWidth,
      strokeDashArray: this.strokeDashArray ?? undefined,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: LineControl): void {
    this.set({
      stroke: control.stroke ?? '#000000',
      strokeWidth: control.strokeWidth ?? 1,
      strokeDashArray: control.strokeDashArray,
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
