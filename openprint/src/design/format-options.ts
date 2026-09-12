/**
 * 单元格数据格式 —— 属性面板 / 单元格工具栏共用的 UI 选项与默认值。
 * 类型定义见 src/types/control.ts 的 CellFormat / CellFormatKind；
 * 实际格式化由 core/layout-engine/expression.ts 的 formatCellValue 完成（与 `{{field | date:'...'}}` 过滤器等价）。
 */
import type { CellFormat, CellFormatKind } from '@/types/control'

/** 格式类型下拉选项 */
export const formatKindOptions: Array<{ label: string; value: CellFormatKind }> = [
  { label: '默认（不格式化）', value: 'none' },
  { label: '文本', value: 'text' },
  { label: '日期', value: 'date' },
  { label: '整数', value: 'int' },
  { label: '小数', value: 'decimal' },
  { label: '货币', value: 'currency' },
  { label: '百分比', value: 'percent' },
]

/** 日期模板预设（pattern 即 formatDate 的模板语法） */
export const datePatternOptions: Array<{ label: string; value: string }> = [
  { label: '2026-08-11（年-月-日）', value: 'YYYY-MM-DD' },
  { label: '2026/08/11（年/月/日）', value: 'YYYY/MM/DD' },
  { label: '2026年08月11日', value: 'YYYY年MM月DD日' },
  { label: '08/11/2026（美式 月/日/年）', value: 'MM/DD/YYYY' },
  { label: '11/08/2026（欧式 日/月/年）', value: 'DD/MM/YYYY' },
  { label: '2026-08-11 14:30（带时间）', value: 'YYYY-MM-DD HH:mm' },
  { label: '自定义…', value: '__custom__' },
]

/** 货币代码选项（与 expression.ts 的 CURRENCY_SYMBOL 对应） */
export const currencyCodeOptions: Array<{ label: string; value: string }> = [
  { label: '人民币 CNY（¥）', value: 'CNY' },
  { label: '美元 USD（$）', value: 'USD' },
  { label: '欧元 EUR（€）', value: 'EUR' },
  { label: '英镑 GBP（£）', value: 'GBP' },
  { label: '港币 HKD（HK$）', value: 'HKD' },
  { label: '日元 JPY（¥）', value: 'JPY' },
]

/** 按类型生成该种类的默认格式（用户第一次选择某类型时套用） */
export function makeFormat(kind: CellFormatKind): CellFormat {
  switch (kind) {
    case 'date':
      return { kind, pattern: 'YYYY-MM-DD' }
    case 'int':
      return { kind, thousands: true }
    case 'decimal':
      return { kind, digits: 2, thousands: true }
    case 'currency':
      return { kind, code: 'CNY', digits: 2, thousands: true }
    case 'percent':
      return { kind, digits: 2 }
    case 'none':
    case 'text':
    default:
      return { kind: 'none' }
  }
}

export function needsPattern(kind: CellFormatKind | undefined): boolean {
  return kind === 'date'
}
export function needsDigits(kind: CellFormatKind | undefined): boolean {
  return kind === 'int' || kind === 'decimal' || kind === 'currency' || kind === 'percent'
}
export function needsCode(kind: CellFormatKind | undefined): boolean {
  return kind === 'currency'
}
export function supportsThousands(kind: CellFormatKind | undefined): boolean {
  return kind === 'int' || kind === 'decimal' || kind === 'currency'
}

/** 由数据源字段类型推荐一个默认格式类型（仅作 UI 提示，不直接落库） */
export function suggestKindByFieldType(type: string | undefined): CellFormatKind | null {
  if (type === 'date') return 'date'
  if (type === 'number') return 'decimal'
  return null
}
