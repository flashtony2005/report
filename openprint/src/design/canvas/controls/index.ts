/**
 * 控件注册表：协议模型 → Fabric 对象 的统一工厂
 */
import type { FabricObject } from 'fabric'
import type { AnyControl } from '@/types/control'
import { PrintText } from './PrintText'
import { PrintRect } from './PrintRect'
import { PrintCircle } from './PrintCircle'
import { PrintLine } from './PrintLine'
import { PrintImage } from './PrintImage'
import { PrintBarcode } from './PrintBarcode'
import { PrintQrcode } from './PrintQrcode'
import { PrintTable } from './PrintTable'
import { PrintZone } from './PrintZone'
import { PrintRichText } from './PrintRichText'
import { PrintChart } from './PrintChart'
import { PrintMath } from './PrintMath'
import { PrintSignature } from './PrintSignature'
import { PrintLabelGrid } from './PrintLabelGrid'
import type { IPrintObject } from './PrintObject'

export {
  PrintText,
  PrintRect,
  PrintCircle,
  PrintLine,
  PrintImage,
  PrintBarcode,
  PrintQrcode,
  PrintTable,
  PrintZone,
  PrintRichText,
  PrintChart,
  PrintMath,
  PrintSignature,
  PrintLabelGrid,
}
export { isPrintObject, type IPrintObject } from './PrintObject'

export interface PageSizeMm {
  widthMm: number
  heightMm: number
  /** 左右边距（mm，页眉/页脚色带贴内容宽用） */
  marginLeftMm?: number
  marginRightMm?: number
}

/** 由协议模型创建 Fabric 控件对象 */
export function createFabricControl(
  control: AnyControl,
  page: PageSizeMm,
): FabricObject & IPrintObject {
  switch (control.type) {
    case 'text':
      return new PrintText(control)
    case 'rect':
      return control.shape === 'circle' ? new PrintCircle(control) : new PrintRect(control)
    case 'line':
      return new PrintLine(control)
    case 'image': {
      const obj = new PrintImage(control)
      void obj.loadImage()
      return obj
    }
    case 'barcode':
      return new PrintBarcode(control)
    case 'qrcode':
      return new PrintQrcode(control)
    case 'table':
      return new PrintTable(control)
    case 'chart':
      return new PrintChart(control)
    case 'math':
      return new PrintMath(control)
    case 'signature': {
      const obj = new PrintSignature(control)
      void obj.loadImage()
      return obj
    }
    case 'zone':
      return new PrintZone(control, page.widthMm, page.heightMm, page.marginLeftMm, page.marginRightMm)
    case 'richtext':
      return new PrintRichText(control)
    case 'labelgrid':
      return new PrintLabelGrid(control)
  }
}

/** 控件类型的中文名（图层/面板显示用） */
export const CONTROL_TYPE_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  table: '表格',
  barcode: '条码',
  qrcode: '二维码',
  rect: '矩形',
  line: '线条',
  richtext: '富文本',
  zone: '区域',
  chart: '图表',
  math: '公式',
  signature: '签名',
  labelgrid: '标签网格',
}
