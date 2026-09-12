/**
 * GroupEngine —— 分组与统计
 * 真理源：《OpenPrint-设计方案.md》§5.5（分组统计）、§5.4（summaryRow）
 *
 * 产物是「行计划」(RowPlan[])：一个把 组头 / 数据行 / 小计 / 总计 编排好的线性序列。
 * 之所以先出行计划再交给 TableEngine 测量，是为了让"分组语义"和"高度/分页"彻底解耦：
 * 分页时只需按 RowPlan 顺序切，不必再理解分组结构。
 */
import type { TableControl } from '@/types/control'
import { evaluate, resolveBinding, stringifyValue } from './expression'
import type { EvalContext, RenderRowKind } from './types'

export type RowPlanKind = Extract<RenderRowKind, 'data' | 'group' | 'subtotal' | 'summary'>

export interface RowPlan {
  kind: RowPlanKind
  /** data 行的原始数据对象 */
  row?: Record<string, unknown>
  /** 在原始数组中的下标（斑马纹/序号用，跨分组连续） */
  dataIndex?: number
  /** group 行的分组标题 / subtotal|summary 行的标签 */
  label?: string
  /** 聚合结果：字段名 → 数值（供 subtotal / summary 行按列填值） */
  aggregates?: Record<string, number>
}

/* -------------------------------- 聚合 -------------------------------- */

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

/** 从行对象里按字段名取值，兼容 `items[].amount` 这类带前缀的路径 */
function readField(row: Record<string, unknown>, field: string): unknown {
  if (field in row) return row[field]
  const tail = field.includes('[].') ? field.slice(field.indexOf('[].') + 3) : field
  if (tail in row) return row[tail]
  // 支持 a.b 嵌套
  return tail.split('.').reduce<unknown>((acc, k) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[k]
  }, row)
}

export function aggregate(
  rows: Array<Record<string, unknown>>,
  type: 'sum' | 'count',
  field: string,
): number {
  if (type === 'count') return rows.length
  return rows.reduce((sum, r) => sum + toNumber(readField(r, field)), 0)
}

/**
 * 计算一批行在若干字段上的聚合值。
 * 字段清单来自 `control.summary` 与 `options.summaryRow.fields` 的并集。
 * @param allRows 整表（跨分组）行，供 type='custom' 的表达式引用 `allRows`。
 */
export function computeAggregates(
  rows: Array<Record<string, unknown>>,
  control: TableControl,
  allRows?: Array<Record<string, unknown>>,
): Record<string, number> {
  const out: Record<string, number> = {}

  for (const s of control.summary ?? []) {
    out[s.field] = aggregate(rows, s.type, s.field)
  }

  const sr = control.options?.summaryRow
  if (!sr || sr.type === 'custom') {
    // custom 类型在下方单独处理（sr 为 undefined 时也不走 sum/count 分支）
  } else {
    for (const f of sr.fields ?? []) {
      out[f] = aggregate(rows, sr.type, f)
    }
    return out
  }

  if (!sr) return out

  // ── type='custom'：用自定义表达式求值，作用域含预计算的 sum/avg 与原始行 ──
  const sum: Record<string, number> = {}
  const avg: Record<string, number> = {}
  for (const col of control.columns ?? []) {
    const f = col.field
    if (f) {
      sum[f] = aggregate(rows, 'sum', f)
      avg[f] = rows.length ? sum[f] / rows.length : 0
    }
  }
  const scope = { sum, avg, rows, allRows: allRows ?? rows }
  const fields = sr.fields ?? []
  const evalCtx: EvalContext = { data: {} }
  if (fields.length === 0) {
    // 无聚合列：把单表达式结果放进占位列（渲染时标签列之前呈现）
    try {
      out['__total__'] = toNumber(evaluate(sr.expression ?? '0', evalCtx, scope))
    } catch {
      /* 表达式错误时静默留 0，由调用方 warning 兜底 */
    }
  }
  for (const f of fields) {
    const expr = sr.expressions?.[f] ?? sr.expression ?? '0'
    try {
      out[f] = toNumber(evaluate(expr, evalCtx, scope))
    } catch {
      out[f] = 0
    }
  }
  return out
}

/** 是否配置了任何合计行 */
export function hasSummaryRow(control: TableControl): boolean {
  const sr = control.options?.summaryRow
  if (sr) return true
  return (control.summary?.length ?? 0) > 0
}

/** 合计行标签（默认「合计」） */
export function summaryLabel(control: TableControl): string {
  return control.options?.summaryRow?.label ?? control.summary?.[0]?.label ?? '合计'
}

/** 分组小计标签（默认「${key} 小计」，`${key}` 替换为分组值） */
export function subtotalLabel(control: TableControl, key: string): string {
  const tpl = control.options?.summaryRow?.subtotalLabel
  return tpl ? tpl.replace(/\$\{key\}/g, key) : `${key} 小计`
}

/* ------------------------------- 空行判定 ------------------------------- */

/** §5.4 skipEmptyRows：一行里所有被引用字段都为空则视为空行 */
export function isEmptyRow(row: Record<string, unknown>, fields: string[]): boolean {
  if (fields.length === 0) return false
  return fields.every((f) => {
    const v = readField(row, f)
    return v === null || v === undefined || v === ''
  })
}

/* ------------------------------ 行计划编排 ------------------------------ */

export interface PlanOptions {
  control: TableControl
  rows: Array<Record<string, unknown>>
  ctx: EvalContext
}

/**
 * 生成行计划。
 *
 * 无 groupBy：`[data, data, ..., summary?]`
 * 有 groupBy：`[group, data..., subtotal, group, data..., subtotal, ..., summary?]`
 *
 * 分组保持**首次出现顺序**（不重排），符合 ERP 单据"按录入顺序打印"的预期。
 */
export function planRows({ control, rows, ctx }: PlanOptions): RowPlan[] {
  const plans: RowPlan[] = []
  const groupBy = control.groupBy?.trim()

  if (!groupBy) {
    rows.forEach((row, i) => plans.push({ kind: 'data', row, dataIndex: i }))
  } else {
    const buckets = new Map<string, Array<{ row: Record<string, unknown>; index: number }>>()
    rows.forEach((row, i) => {
      const raw = resolveBinding(groupBy, { ...ctx, row, rowIndex: i })
      const key = stringifyValue(raw)
      const list = buckets.get(key)
      if (list) list.push({ row, index: i })
      else buckets.set(key, [{ row, index: i }])
    })

    for (const [key, items] of buckets) {
      plans.push({ kind: 'group', label: key || '（未分组）' })
      for (const { row, index } of items) {
        plans.push({ kind: 'data', row, dataIndex: index })
      }
      if (hasSummaryRow(control)) {
        plans.push({
          kind: 'subtotal',
          label: subtotalLabel(control, key || '（未分组）'),
          aggregates: computeAggregates(
            items.map((i) => i.row),
            control,
            rows,
          ),
        })
      }
    }
  }

  return plans
}

/** 全表总计行（渲染为表尾，参与 repeatFooter 逻辑） */
export function buildSummaryPlan(
  rows: Array<Record<string, unknown>>,
  control: TableControl,
): RowPlan | null {
  if (!hasSummaryRow(control)) return null
  return {
    kind: 'summary',
    label: summaryLabel(control),
    aggregates: computeAggregates(rows, control, rows),
  }
}

export { readField }
