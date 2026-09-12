/**
 * PrintQrcode —— 二维码控件（§5.7，qrcode 库离屏渲染）
 */
import { FabricImage } from 'fabric'
import QRCode from 'qrcode'
import type { QrcodeControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'

export class PrintQrcode extends FabricImage implements IPrintObject {
  controlId: string
  controlType = 'qrcode' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  binding?: string
  textValue?: string
  exprValue?: string
  contentType?: 'fixed' | 'variable' | 'expression'
  errorLevel: 'L' | 'M' | 'Q' | 'H' = 'M'

  constructor(control: QrcodeControl) {
    super(document.createElement('canvas'), {
      left: mm(control.left),
      top: mm(control.top),
      angle: control.angle ?? 0,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.contentType = control.contentType
    this.binding = control.binding
    this.textValue = control.value
    this.exprValue = control.expression
    this.errorLevel = control.errorLevel ?? 'M'
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.set({ width: mm(control.width), height: mm(control.height) })
    void this.regenerate()
  }

  /** 设计期占位文本：按 contentType 取对应字段 */
  private displayValue(): string | undefined {
    const m = this.contentType
    if (m === 'expression') return this.exprValue
    if (m === 'variable') return this.binding ? `{{${this.binding}}}` : undefined
    if (m === 'fixed') return this.textValue
    return this.textValue ?? (this.binding ? `{{${this.binding}}}` : undefined)
  }

  async regenerate(): Promise<void> {
    // 目标显示尺寸（逻辑 px）；setElement 会重置 width/height，先保存
    const targetW = this.getScaledWidth() || 1
    const targetH = this.getScaledHeight() || 1
    const text = this.displayValue() ?? 'https://open-print.dev'
    const canvas = document.createElement('canvas')
    try {
      await QRCode.toCanvas(canvas, text, {
        width: Math.ceil(Math.max(targetW, targetH) * 2), // 2x 渲染保证缩放清晰
        margin: 1,
        errorCorrectionLevel: this.errorLevel,
      })
      this.setElement(canvas)
      // 等比缩放（meet 居中）填满控件框：二维码模块与人眼可读内容保持宽高比，
      // 避免拉宽/拉高时变形（变形二维码可能无法扫描）。与预览端 svg meet 行为一致。
      const natW = canvas.width || 1
      const natH = canvas.height || 1
      const s = Math.min(targetW / natW, targetH / natH)
      this.set({ scaleX: s, scaleY: s })
    } catch {
      // 内容过长等异常：保持空白占位
    }
    this.setCoords()
    this.canvas?.requestRenderAll()
  }

  toControl(): QrcodeControl {
    return {
      ...readBaseGeometry(this),
      type: 'qrcode',
      contentType: this.contentType,
      binding: this.binding,
      value: this.textValue,
      expression: this.exprValue,
      errorLevel: this.errorLevel,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: QrcodeControl): void {
    this.contentType = control.contentType
    this.binding = control.binding
    this.textValue = control.value
    this.exprValue = control.expression
    this.errorLevel = control.errorLevel ?? 'M'
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
    void this.regenerate()
  }
}
