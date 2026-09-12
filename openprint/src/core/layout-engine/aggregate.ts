/**
 * aggregate —— 表格尾行（本页合计 / 总计 / 大写金额）聚合引擎（纯函数，可测）
 *
 * 设计要点（与用户需求对齐）：
 * - 表格默认结构 = 标题行 + 数据行 + 本页合计行 + 总计行 + 大写金额行。
 * - 尾行的「计算单元格」用约定表达式占位：
 *   - `{{#pageSum}}`  本页合计（每页只算本页数据行）
 *   - `{{#totalSum}}` 总计（整表所有数据行，仅末页出现）
 *   - `{{#pageCap}}`  本页合计大写金额
 *   - `{{#totalCap}}` 总计大写金额（如 贰万贰仟陆佰伍拾元整，仅末页出现）
 *   - 另有 `{{#pageAvg}}`/`{{#totalAvg}}`/`{{#pageCount}}`/`{{#totalCount}}` 可用。
 * - 单元格里凡不是聚合 token 的 `{{}}` 视为普通插值；完全不含 `{{}}` 的字面量视为静态文本。
 * - 哪一列需要合计：由列字段类型（或数据行首行采样）判断，非数值列（字符串等）不计算。
 * - 合计整数不带小数、小数保留两位；大写金额按人民币大写规则转换。
 */
import type { TableColumn } from '@/types/control'

/* -------------------------------- Token 解析 -------------------------------- */

export type AggKind =
  | 'pageSum'
  | 'totalSum'
  | 'pageAvg'
  | 'totalAvg'
  | 'pageCount'
  | 'totalCount'
  | 'pageCap'
  | 'totalCap'

/** 解析单元格文本是否为聚合 token；返回具体类型或 null */
export function parseAggToken(text: string | undefined): AggKind | null {
  if (!text) return null
  const m = /^\{\{\s*#(pageSum|totalSum|pageAvg|totalAvg|pageCount|totalCount|pageCap|totalCap)\s*\}\}$/.exec(
    text.trim(),
  )
  return m ? (m[1] as AggKind) : null
}

/** 该文本是否为聚合 token */
export function isAggToken(text: string | undefined): boolean {
  return parseAggToken(text) !== null
}

/** token 所在的尾行类别 */
export type FooterKind = 'pageSubtotal' | 'grandTotal' | 'capital' | 'static'

export function footerKindOf(kind: AggKind | null): FooterKind {
  if (kind === 'pageCap' || kind === 'totalCap') return 'capital'
  if (kind === 'totalSum' || kind === 'totalAvg' || kind === 'totalCount') return 'grandTotal'
  if (kind === 'pageSum' || kind === 'pageAvg' || kind === 'pageCount') return 'pageSubtotal'
  return 'static'
}

/* -------------------------------- 字段工具 -------------------------------- */

/** 去 `items[].` 前缀，得到数据行字段键（items[].amount → amount） */
export function stripItems(field: string | undefined): string {
  if (!field) return ''
  return field.includes('[].') ? field.slice(field.indexOf('[].') + 3) : field
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

/* -------------------------------- 聚合求值 -------------------------------- */

export function sumField(rows: Array<Record<string, unknown>>, field: string): number {
  let s = 0
  for (const r of rows) s += toNum(r[field])
  return s
}

export function avgField(rows: Array<Record<string, unknown>>, field: string): number {
  return rows.length ? sumField(rows, field) / rows.length : 0
}

/** 按 token 类别，对给定数据行集合在 field 上求值 */
export function aggValueForRows(
  kind: AggKind,
  rows: Array<Record<string, unknown>>,
  field: string,
): number {
  switch (kind) {
    case 'pageSum':
    case 'totalSum':
      return sumField(rows, field)
    case 'pageAvg':
    case 'totalAvg':
      return avgField(rows, field)
    case 'pageCount':
    case 'totalCount':
      return rows.length
    default:
      return 0
  }
}

/**
 * 聚合数值显示：整数不带小数（默认整数计算），小数保留两位，统一加千分位。
 * 对齐 table-engine 的 formatAggregate 行为；字符串等非数值列不计算（调用方应已跳过）。
 */
export function formatAggNumber(v: number): string {
  const fixed = Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2)
  const [int = '0', dec] = fixed.split('.')
  const sign = int.startsWith('-') ? '-' : ''
  const grouped = (sign ? int.slice(1) : int).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + grouped + (dec ? `.${dec}` : '')
}

/* ------------------------------ 大写人民币转换 ------------------------------ */

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const SMALL_UNITS = ['', '拾', '佰', '仟']
// 每 4 位一组的大单位：个 / 万 / 亿 / 兆
const GROUP_UNITS = ['', '万', '亿', '兆']

/** 0..9999 → 中文（不含组单位），并返回本组是否含非零位 */
function groupToChinese(num: number): { text: string; hasNonZero: boolean } {
  const s = String(num).padStart(4, '0')
  let result = ''
  let zero = false
  let hasNonZero = false
  for (let i = 0; i < 4; i++) {
    const d = Number(s[i])
    if (d === 0) {
      zero = true
    } else {
      if (zero && result) result += DIGITS[0]
      result += (DIGITS[d] ?? '') + (SMALL_UNITS[3 - i] ?? '')
      zero = false
      hasNonZero = true
    }
  }
  return { text: result, hasNonZero }
}

/** 非负整数 → 中文数字（正确处理 万/亿 分组与组间零） */
function integerToChinese(n: number): string {
  if (n === 0) return DIGITS[0] ?? '零'
  if (n < 0) return '负' + integerToChinese(-n)
  // 按 4 位拆组（高位在前）
  const groups: number[] = []
  let rem = Math.floor(n)
  while (rem > 0) {
    groups.unshift(rem % 10000)
    rem = Math.floor(rem / 10000)
  }
  let result = ''
  for (let g = 0; g < groups.length; g++) {
    const { text, hasNonZero } = groupToChinese(groups[g] ?? 0)
    if (hasNonZero) {
      result += text + (GROUP_UNITS[groups.length - 1 - g] ?? '')
    } else if (g < groups.length - 1 && result && !result.endsWith(DIGITS[0] ?? '零')) {
      // 整组为 0（且非最低组）→ 在高位与低位之间补一个"零"连接
      result += DIGITS[0] ?? '零'
    }
  }
  return result
}

/**
 * 金额 → 中文大写人民币（如 22650 → 贰万贰仟陆佰伍拾元整）。
 * - 支持整数与两位小数（角/分），第三位小数四舍五入。
 * - 负数加「负」前缀；零金额返回「零元整」。
 */
export function toChineseCapitalRMB(input: number): string {
  if (!Number.isFinite(input)) return ''
  const negative = input < 0
  const amount = Math.abs(Math.round(input * 100) / 100)
  if (amount === 0) return '零元整'

  const intPart = Math.floor(amount)
  const decPart = Math.round((amount - intPart) * 100) // 0..99
  const jiao = Math.floor(decPart / 10)
  const fen = decPart % 10

  let result = ''
  if (intPart > 0) result += integerToChinese(intPart) + '元'
  if (jiao === 0 && fen === 0) {
    result += '整'
  } else {
    if (jiao > 0) result += (DIGITS[jiao] ?? '') + '角'
    else if (intPart > 0) result += DIGITS[0] ?? '零' // 元后零角（如 100.05 → 壹佰元零伍分）
    if (fen > 0) result += (DIGITS[fen] ?? '') + '分'
  }
  return (negative ? '负' : '') + result
}

/* ------------------------------ 列聚合判定 ------------------------------ */

/**
 * 某列是否参与聚合（计算合计）。
 * - 显式 `aggregate:false` → 不参与。
 * - 显式 `aggregate:true` 或 `'sum'`/`'avg'`/`'count'` → 参与。
 * - 否则按数据首行采样推断：列字段在数据行里出现数值则参与（字符串等类型不计算）。
 */
export function columnAggregatable(
  col: TableColumn | undefined,
  sample: Record<string, unknown> | undefined,
): boolean {
  if (!col) return false
  if (col.aggregate === false) return false
  if (col.aggregate === true || col.aggregate === 'sum' || col.aggregate === 'avg' || col.aggregate === 'count')
    return true
  const key = stripItems(col.field)
  if (key && sample && typeof sample[key] === 'number') return true
  return false
}
