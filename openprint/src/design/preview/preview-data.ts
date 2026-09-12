/**
 * 预览数据构造 —— 用数据源字段的 `sample` 值合成一份可预览的业务数据
 *
 * 为什么不直接写死 SALES_ORDER_SAMPLE：
 * 换成后端数据源（createDataSourceHttp）后字段清单是动态的，写死样例就废了。
 * FieldDef.sample 是协议里既有的约定，按它反推数据结构才能对任意数据源通用。
 *
 * 明细字段路径形如 `items[].qty`，这里会展开成 `items: [{qty}, {qty}, …]`，
 * 行数由调用方指定 —— 把行数调大就能验证分页（这也是预览面板"明细行数"输入框的用途）。
 */
import type { FieldDef } from '@/types/datasource'

/** 序号类字段：值直接用行号，方便肉眼核对分页边界 */
const SEQ_RE = /^(seq|index|no|rowno|序号)$/i
/** 编码类字段：拼上行号，让每行看起来不一样 */
const CODE_RE = /(code|no|sn|编码|编号|单号)$/i

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.').filter(Boolean)
  let cur = target
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!
    const next = cur[k]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[k] = {}
    }
    cur = cur[k] as Record<string, unknown>
  }
  const last = keys.at(-1)
  if (last) cur[last] = value
}

function pad(n: number, width = 3): string {
  return String(n).padStart(width, '0')
}

/** 按行号给样例值加变化，避免整张表每行完全一样看不出分页 */
function varyValue(field: FieldDef, leaf: string, rowIndex: number): unknown {
  const sample = field.sample

  if (SEQ_RE.test(leaf)) return rowIndex + 1

  if (typeof sample === 'number') {
    // 在样例值上下浮动 ±20%，保留两位；整数字段仍返回整数
    const factor = 1 + ((rowIndex % 5) - 2) * 0.1
    const v = sample * factor
    return Number.isInteger(sample) ? Math.max(1, Math.round(v)) : Math.round(v * 100) / 100
  }

  if (typeof sample === 'boolean') return rowIndex % 2 === 0
  if (sample === null || sample === undefined || sample === '') return ''

  const text = String(sample)
  if (CODE_RE.test(leaf)) return `${text}-${pad(rowIndex + 1)}`
  return text
}

export interface PreviewDataOptions {
  /** 明细数组行数（默认 30，足以在 A4 上撑出多页） */
  rows?: number
  /**
   * 真实数据行（数据库模式）：优先级高于 rows 计数。
   * 给定后，每个数组路径直接填充该批行（按 leaf 字段名映射），不再用 sample 合成。
   */
  dataRows?: Array<Record<string, unknown>>
}

/**
 * 字段清单 → 预览数据对象。
 * 字段为空时返回 `{}`，渲染器会给出 DATASOURCE_EMPTY 告警而不是静默出空白页。
 */
export function buildPreviewData(
  fields: FieldDef[],
  options: PreviewDataOptions = {},
): Record<string, unknown> {
  const rowCount = Math.max(0, Math.floor(options.rows ?? 30))
  const data: Record<string, unknown> = {}

  /** 数组路径 → 该数组下的叶子字段 */
  const arrays = new Map<string, Array<{ leaf: string; field: FieldDef }>>()

  for (const field of fields) {
    if (field.hidden) continue
    const marker = field.path.indexOf('[]')
    if (marker < 0) {
      setPath(data, field.path, field.sample ?? '')
      continue
    }
    const arrayPath = field.path.slice(0, marker)
    // `items[].qty` → leaf 'qty'；`items[]` 自身（无叶子）跳过
    const leaf = field.path.slice(marker + 2).replace(/^\./, '')
    if (!leaf) continue
    const list = arrays.get(arrayPath)
    if (list) list.push({ leaf, field })
    else arrays.set(arrayPath, [{ leaf, field }])
  }

  for (const [arrayPath, leaves] of arrays) {
    // 数据库模式：直接用真实行映射，跳过 sample 合成
    if (options.dataRows && options.dataRows.length > 0) {
      const mapped = options.dataRows.map((src) => {
        const row: Record<string, unknown> = {}
        for (const { leaf, field } of leaves) {
          row[leaf] = src[leaf] ?? (field.type === 'number' ? 0 : '')
        }
        return row
      })
      setPath(data, arrayPath, mapped)
      continue
    }
    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < rowCount; i++) {
      const row: Record<string, unknown> = {}
      for (const { leaf, field } of leaves) setPath(row, leaf, varyValue(field, leaf, i))
      // 金额 = 数量 × 单价：让合计行的数字自洽，否则一眼假
      const qty = row.qty
      const price = row.price
      if (typeof qty === 'number' && typeof price === 'number' && 'amount' in row) {
        row.amount = Math.round(qty * price * 100) / 100
      }
      rows.push(row)
    }
    setPath(data, arrayPath, rows)
  }

  return data
}
