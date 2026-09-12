/**
 * PrintText —— 文本控件（《设计方案》§5.2 / §5.3）
 * 基于 fabric.Textbox：对齐/字体/颜色均为原生属性。
 * 字号协议层是 pt，Fabric 用 px，此处统一换算。
 */
import { Textbox } from 'fabric'
import type { TextControl, TextStyle } from '@/types/control'
import { ptToPx, pxToPt } from '@/core/units'
import { mm, px, readBaseGeometry, round2, type IPrintObject } from './PrintObject'

export class PrintText extends Textbox implements IPrintObject {
  controlId: string
  controlType = 'text' as const
  zoneId?: string

  /** 协议 extras（设计期保留，显示文本只是占位） */
  binding?: string
  expression?: string
  contentType?: TextControl['contentType']
  controlFormat?: TextControl['format']
  printable = true
  visibleIf?: string
  controlName?: string

  constructor(control: TextControl) {
    super(displayText(control), {
      left: mm(control.left),
      top: mm(control.top),
      width: mm(control.width),
      angle: control.angle ?? 0,
      ...styleToFabric(control.style),
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.zoneId = undefined
    this.binding = control.binding
    this.expression = control.expression
    this.contentType = control.contentType
    this.controlFormat = control.format
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
  }

  /** 序列化回协议模型（px → mm / px → pt） */
  toControl(): TextControl {
    return {
      ...readBaseGeometry(this),
      type: 'text',
      contentType: this.contentType,
      value: this.binding || this.expression ? undefined : this.text,
      binding: this.binding,
      expression: this.expression,
      format: this.controlFormat,
      printable: this.printable,
      visibleIf: this.visibleIf,
      locked: this.lockMovementX && this.lockMovementY ? true : undefined,
      name: this.controlName,
      style: {
        fontSize: round2(pxToPt(this.fontSize)),
        fill: typeof this.fill === 'string' ? this.fill : undefined,
        fontFamily: this.fontFamily,
        fontWeight: (this.fontWeight as 'normal' | 'bold') || undefined,
        fontStyle: this.fontStyle === 'italic' ? 'italic' : undefined,
        textDecoration: this.underline ? 'underline' : undefined,
        textAlign: (this.textAlign as TextStyle['textAlign']) || undefined,
        lineHeight: this.lineHeight,
        letterSpacing: this.charSpacing ? round2(pxToPt(this.charSpacing / 1000 * this.fontSize)) : undefined,
      },
    }
  }

  /** 属性面板编辑后回写（不触发 object:modified） */
  applyControlProps(control: TextControl): void {
    this.set({
      ...styleToFabric(control.style),
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.binding = control.binding
    this.expression = control.expression
    this.contentType = control.contentType
    this.controlFormat = control.format
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.text = displayText(control)
    // 非绑定文本允许直接改内容尺寸
    if (control.width) this.set('width', mm(control.width))
    this.setCoords()
    this.canvas?.requestRenderAll()
  }
}

/** 设计期显示文本：按 contentType 显示占位符，老模板回退到 expression/binding 启发式 */
function displayText(control: TextControl): string {
  const mode = control.contentType
  if (mode === 'expression') return control.expression ?? ''
  if (mode === 'variable') return control.binding ? `{{${control.binding}}}` : ''
  if (mode === 'fixed') return control.value ?? '文本'
  // 无 contentType（老模板）：沿用既有启发式
  if (control.expression) return control.expression
  if (control.binding) return `{{${control.binding}}}`
  return control.value ?? '文本'
}

function styleToFabric(style?: TextStyle) {
  return {
    fontSize: ptToPx(style?.fontSize ?? 12),
    fill: style?.fill ?? '#000000',
    fontFamily: style?.fontFamily ?? 'Source Han Sans CN, PingFang SC, sans-serif',
    fontWeight: style?.fontWeight ?? 'normal',
    fontStyle: style?.fontStyle ?? 'normal',
    underline: style?.textDecoration === 'underline',
    textAlign: style?.textAlign ?? 'left',
    lineHeight: style?.lineHeight ?? 1.16,
    charSpacing: style?.letterSpacing ? (style.letterSpacing / (style.fontSize ?? 12)) * 1000 : 0,
  }
}
