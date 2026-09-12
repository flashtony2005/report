/**
 * PrintBarcode —— 条形码控件（§5.7，bwip-js 离屏渲染）
 * 设计期用绑定路径占位文本渲染，运行期由渲染引擎注入真实值。
 */
import { FabricImage } from 'fabric'
import type { BarcodeControl } from '@/types/control'
import { mm, px, readBaseGeometry, type IPrintObject } from './PrintObject'
import { drawBarcode } from '../barcode-draw'

export class PrintBarcode extends FabricImage implements IPrintObject {
  controlId: string
  controlType = 'barcode' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  binding?: string
  textValue?: string
  exprValue?: string
  contentType?: 'fixed' | 'variable' | 'expression'
  format = 'CODE128'
  showText = true

  constructor(control: BarcodeControl) {
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
    this.format = control.format ?? 'CODE128'
    this.showText = control.showText ?? true
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    // 初始尺寸（未缩放），regenerate 会按它换算 scale
    this.set({ width: mm(control.width), height: mm(control.height) })
    void this.regenerate()
  }

  /** 设计期占位显示文本：按 contentType 取对应字段，未设置时保持原绑定优先 */
  private displayValue(): string | undefined {
    const m = this.contentType
    if (m === 'expression') return this.exprValue
    if (m === 'variable') return this.binding ? `{{${this.binding}}}` : undefined
    if (m === 'fixed') return this.textValue
    return this.textValue ?? (this.binding ? `{{${this.binding}}}` : undefined)
  }

  /** 重新渲染条码位图，并按控件几何缩放显示 */
  async regenerate(): Promise<void> {
    const w = this.width || 1
    const h = this.height || 1
    const text = this.displayValue() ?? '0123456789'
    // 绑定占位符含中文/大括号无法编码，设计期用示例码代替
    const encodable = /[{}\u4e00-\u9fa5]/.test(text) ? 'DEMO123456' : text
    // 按控件几何反算条码条高度（mm）：条码条占 60%，剩 40% 留给文字行（textsize=12）+ 上下留白。
    // 这样 bwip-js 直接按目标尺寸渲染，canvas 自然高度 ≈ 控件高度，scaleY ≈ 1，文字不被压扁。
    const controlHeightMM = px(h)
    const barHeightMM = Math.max(2, controlHeightMM * 0.6)
    const paddingMM = Math.max(0.5, controlHeightMM * 0.04)
    // 目标宽度（mm）：bwip-js 以 72dpi 换算像素（输出px = width_mm × 2.8346 × scale），
    // 而画布是 96dpi。传「控件宽mm × 96/72 ÷ scale」使输出自然宽 ≈ 控件 px 宽，
    // 于是 scaleX ≈ 1，条码条与数字都不被拉伸变形，且宽度独立可调。
    const widthMM = px(w) * (96 / 72) / 2
    const canvas = await drawBarcode({
      format: this.format,
      text: encodable,
      showText: this.showText,
      barHeightMM,
      paddingMM,
      widthMM,
    })
    if (canvas) {
      this.setElement(canvas)
      // 宽高独立填满控件框（所见即所得）：
      // - scaleX = w/natW：宽度精确跟随控件（缩窄即变窄，regenerate 不弹回）
      // - scaleY = h/natH：高度精确跟随控件（拉高即变高，行为与之前一致）
      // 由于 width/barHeight 已让自然尺寸 ≈ 控件尺寸，两个 scale 均 ≈ 1，变形可忽略。
      const natW = canvas.width || 1
      const natH = canvas.height || 1
      this.set({ scaleX: w / natW, scaleY: h / natH })
    }
    this.setCoords()
    this.canvas?.requestRenderAll()
  }

  toControl(): BarcodeControl {
    return {
      ...readBaseGeometry(this),
      type: 'barcode',
      contentType: this.contentType,
      binding: this.binding,
      value: this.textValue,
      expression: this.exprValue,
      format: this.format,
      showText: this.showText,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: BarcodeControl): void {
    this.contentType = control.contentType
    this.binding = control.binding
    this.textValue = control.value
    this.exprValue = control.expression
    this.format = control.format ?? 'CODE128'
    this.showText = control.showText ?? true
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
