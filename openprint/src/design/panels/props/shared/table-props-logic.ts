/**
 * TableProps 共享逻辑（P4.2）—— Vue / React 两端同源。
 *
 * 从 TableProps.vue 抽出的纯逻辑：options 补丁清理、样式合并清理、
 * 列格式写回、列字段/聚合列/分组字段选项构造、样式预设套用补丁。
 * 网格结构变更直接复用 @/core/layout-engine/table-cells 纯函数（两端已同源）。
 */
import type {
  CellFormat,
  CellFormatKind,
  TableColumn,
  TableCellStyle,
  TableControl,
  TableOptions,
  TableStylePreset,
} from '@/types/control'
import type { FieldDef, TableMeta } from '@/types/datasource'
import {
  datePatternOptions,
  makeFormat,
} from '@/design/format-options'
import { TABLE_STYLE_PRESETS } from '@/design/canvas/table-style-presets'

/* ------------------------------ 补丁清理 ------------------------------ */

/** 合并补丁并清理"被清空"的项（null / 空串），避免脏样式残留 */
export function mergeClean(cur: Record<string, unknown>, p: Record<string, unknown>): Record<string, unknown> {
  const next = { ...cur, ...p }
  for (const k of Object.keys(next)) {
    if (next[k] === null || next[k] === '') delete next[k]
  }
  return next
}

/** options 补丁：合并并清理被显式置 undefined 的键（如关闭合计行时 summaryRow:undefined） */
export function cleanOptions(cur: TableOptions | undefined, p: Partial<TableOptions>): TableOptions {
  const next: Record<string, unknown> = { ...(cur ?? {}), ...p }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  return next as unknown as TableOptions
}

/* ------------------------------ 列 ------------------------------ */

/** 列「参与合计」开关当前状态 */
export function isAggregateOn(col: TableColumn | undefined): boolean {
  return col?.aggregate === true || col?.aggregate === 'sum' || col?.aggregate === 'avg' || col?.aggregate === 'count'
}

/** 写回列格式：kind='none' 视为清除（删字段，保持模型干净） */
export function normalizeColumnFormat(fmt: CellFormat | undefined): CellFormat | undefined {
  return fmt && fmt.kind !== 'none' ? fmt : undefined
}

/** 由格式 kind 生成初始 CellFormat（none → undefined） */
export function formatFromKind(k: CellFormatKind): CellFormat | undefined {
  return k === 'none' ? undefined : makeFormat(k)
}

/* ------------------------------ 选项构造（依赖数据源） ------------------------------ */

/**
 * 该表是不是「数组表」（可作表格/标签网格的数据源）。
 * `isArray` 是权威标记，但外部数据源（ERP/内省）未必标全：
 * 关系为 `detail`、或 pathPrefix 以 `[]` 结尾（如示例数据的 `items[]`）同样按数组表处理。
 */
export function isArrayTable(t: TableMeta): boolean {
  return t.isArray === true || t.relation === 'detail' || /\[\]$/.test(t.pathPrefix)
}

/**
 * 表格「数据设置 → 数据源」选项：**只列数组表**，value 用表的 pathPrefix。
 *
 * 表格数据源必须是数组路径（`table-engine` 的 `resolveRows` 拿它 `resolveBinding` 后强制
 * `Array.isArray`，不是数组就报 `DATASOURCE_NOT_ARRAY` 且表格空白）。所以这里**不能**喂
 * `flatFields`（那全是 `items[].列名` 这类单值列）—— 早先正是错喂了字段列表，下拉里"全是列、
 * 没有表"。自由文本仍允许手填（antd/naive 都是 tags 模式）。
 */
export function tableSourceOptions(tables: TableMeta[] | undefined): { label: string; value: string }[] {
  return (tables ?? [])
    .filter(isArrayTable)
    .map((t) => ({ label: `${t.name}  ·  ${t.pathPrefix}`, value: t.pathPrefix }))
}

/** 列字段下拉选项：只列「明细数组字段」（路径含 []），自由文本仍允许手填 */
export function columnFieldOptions(flatFields: FieldDef[]): { label: string; value: string }[] {
  const list = flatFields.filter((f) => f.path.includes('[]'))
  return [
    { label: '（不绑定）', value: '' },
    ...list.map((f) => ({ label: `${f.label}  ·  ${f.path}`, value: f.path })),
  ]
}

/** 字段类型查表（按完整 path），用于给出"字段类型"提示 */
export function fieldTypeMapOf(flatFields: FieldDef[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const f of flatFields) m.set(f.path, f.type)
  return m
}

/** 分组字段选项：取明细（数组）表的字段，value 用裸字段名（与运行期列 field 约定一致） */
export function groupFieldOptions(
  flatFields: FieldDef[],
  tables: { id: string; isArray?: boolean }[] | undefined,
): { label: string; value: string }[] {
  const arrayIds = new Set((tables ?? []).filter((t) => t.isArray).map((t) => t.id))
  return flatFields
    .filter((f) => (f.tableId ? arrayIds.has(f.tableId) : f.path.includes('[]')))
    .map((f) => {
      const tail = f.path.includes('[].') ? f.path.slice(f.path.indexOf('[].') + 3) : f.path
      return { label: `${f.label} · ${f.path}`, value: tail }
    })
}

/** 聚合列选项：取"已绑定字段的列"，其值须与列 field 一致引擎才能按列落位 */
export function summaryFieldOptions(columns: TableColumn[]): { label: string; value: string }[] {
  return columns
    .filter((c) => c.field)
    .map((c) => ({ label: `${c.title || c.field} · ${c.field}`, value: c.field! }))
}

/* ------------------------------ 日期格式 ------------------------------ */

/** 当前 pattern 是否为预设模板（非自定义） */
export function isPresetDatePattern(p?: string): boolean {
  return Boolean(p && datePatternOptions.some((o) => o.value !== '__custom__' && o.value === p))
}

/* ------------------------------ 合计行 ------------------------------ */

export interface SummaryRowCfg {
  type: 'sum' | 'count' | 'custom'
  fields: string[]
  label: string
  expression?: string
  expressions?: Record<string, string>
  subtotalLabel?: string
  subtotalStyle?: { bold?: boolean; color?: string }
}

/** 合计行兜底配置 */
export function defaultSummary(): SummaryRowCfg {
  return { type: 'sum', fields: [], label: '合计' }
}

/** 编辑某字段的专属表达式（expressions[field]），空串删除该键 */
export function withSummaryExpr(
  cur: SummaryRowCfg,
  field: string,
  expr: string | null,
): SummaryRowCfg {
  const expressions = { ...(cur.expressions ?? {}) }
  if (expr && expr.trim()) expressions[field] = expr
  else delete expressions[field]
  return { ...cur, type: 'custom', expressions }
}

/** 兜底单表达式（无聚合列时生效） */
export function withSummaryFallback(cur: SummaryRowCfg, expr: string | null): SummaryRowCfg {
  return { ...cur, type: 'custom', expression: expr || undefined }
}

/* ------------------------------ 样式预设 ------------------------------ */

/** 套用样式预设：预设若捆绑边框方案，则配色 + 框线一并套用；否则只改配色、保留当前边框 */
export function stylePickPatch(key: TableStylePreset): Partial<TableOptions> {
  const meta = TABLE_STYLE_PRESETS.find((p) => p.key === key)
  return meta?.borders ? { tableStyle: key, borders: meta.borders } : { tableStyle: key }
}
