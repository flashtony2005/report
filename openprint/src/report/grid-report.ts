/**
 * 网格报表的纯函数层（无 DOM / 无 Univer 依赖，便于单测）
 *
 * 职责：
 * - 由「分组字段 + 数值字段」或「画布表格列」生成 ReportTemplate（服务端 xpt 的 JSON 等价物）
 * - 把服务端展开结果转成 Univer 工作簿数据
 *
 * 真正的展开/分组/汇总算法在 print-server（Rust）里，前端只做描述与展示。
 */

export interface GridCell {
  text: string
  pos: string
  rowspan: number
  colspan: number
  raw_number?: number | null
  /** Excel 数字格式串（由 NumFmt 推导），xlsx 导出时套到数值格上 */
  num_format?: string | null
  /** Excel 公式（仅 cell.model.export_formula 且表达式可翻译时非空）；HTML 预览用 text */
  formula?: string | null
}

export interface RenderedSheet {
  name: string
  rows: GridCell[][]
}

/** 分页配置（页面级：按数据行数切页，表头/表尾每页重复） */
export interface PageConfig {
  /** 每页容纳的**数据**行数（不含重复的表头/表尾） */
  rows_per_page?: number
  /** 每页顶部重复的模板行数（表头） */
  repeat_header_rows?: number
  /** 每页底部重复的模板行数（表尾 / 签字栏等） */
  repeat_footer_rows?: number
}

export interface RenderResponse {
  sheets: RenderedSheet[]
  html: string
  /** 展开中间结果（仅 dump=true 时返回）：`seq | pos | 文本 <- 层次坐标 | 行父 | 列父` */
  dump?: string | null
  /** 分页结果（仅模板配了 page 时返回）：每页一个 sheet，名字带 ` (i/n)` */
  pages?: RenderedSheet[] | null
  /** 逐页 HTML，与 pages 一一对应 */
  pages_html?: string[] | null
  /**
   * 会静默产出错误数据的可疑情况（父格查不到、表达式解析失败等）。
   * 不中断渲染，但调用方应当展示给用户。
   */
  warnings?: string[] | null
}

export type ExpandDir = 'r' | 'c'

/** 交叉表数值格的聚合方式：同一 (行分组, 列分组) 交集里通常有多行数据 */
export type AggType = 'sum' | 'count' | 'avg' | 'min' | 'max'

/**
 * 数值显示格式（与设计器控件的 `CellFormat` 同形；服务端 `NumFmt` 与之逐字段对应）。
 *
 * 不配置则走服务端全局兜底：整数带千分位、非整数两位小数。
 */
export interface CellFormatSpec {
  kind: 'text' | 'int' | 'decimal' | 'currency' | 'percent'
  /** 小数位数；int 默认 0，decimal/currency/percent 默认 2 */
  digits?: number
  /** 千分位；int/decimal/currency 默认 true */
  thousands?: boolean
  /** 货币代码（kind=currency），默认 CNY */
  code?: string
}

export interface CellModel {
  ds?: string
  field?: string
  agg?: AggType
  expand_type?: ExpandDir
  row_parent?: string
  col_parent?: string
  /** 列向定位：本格排在目标 pos 所占列区间之后（列数随数据变化时用它，避免写死列号） */
  col_after?: string
  value_expr?: string
  expand_expr?: string
  /** 展开条数下限：不足时补空值（「默认留 N 个空行」） */
  expand_min_count?: number
  /** 展开条数上限：超过的丢弃（「只显示前 N 条」） */
  expand_max_count?: number
  /** 展开集为空时保留该格（值为 null）；缺省会连同子格一起删除 */
  keep_expand_empty?: boolean
  /** 数值显示格式（小计 / 合计格应与所在数值列一致） */
  format?: CellFormatSpec
  /**
   * 展示期表达式（第三值阶段）：可用 `value` 指代本格的值，
   * 如 `IF(value >= 1000, "大额", "小额")`。
   * 只影响展示文本，不影响导出到 xlsx 的原始数值。
   */
  format_expr?: string
  /**
   * 字典翻译：原始值文本 → 展示文本，如 `{ "1": "是", "0": "否" }`。
   * 键取未套数字格式的原始文本；命中不了就回落到 format / 全局兜底。
   */
  dict?: Record<string, string>
  /**
   * 行测试表达式：返回假则**整行删除**（本格连同子树一起不占位）。
   * 应挂在「决定这一行」的单元格上（如分组格），挂在叶子格上只会删掉那一格。
   */
  row_test_expr?: string
  /** 列测试表达式：返回假则整列删除 */
  col_test_expr?: string
  /**
   * 导出 xlsx 时把 value_expr 翻译成 Excel 公式（而非写死算好的值），
   * 导出后在 Excel 里改明细，小计 / 合计会跟着重算。
   * 翻不出来（如 PROPORTION / 条件表达式）会回落写值并告警。
   */
  export_formula?: boolean | null
}

export interface CellTpl {
  pos?: string
  value?: string | number | null
  model?: CellModel
  /** 向右合并列数（merge_across + 1 == colspan） */
  merge_across?: number
  /** 向下合并行数（merge_down + 1 == rowspan）；多级列表头的表头格用它纵跨所有列头行 */
  merge_down?: number
  /** 横向铺到行尾；列数随数据变化时标题/表头无法写死合并宽度 */
  merge_to_end?: boolean
}

export interface RowTpl {
  cells: CellTpl[]
}

export interface SheetTpl {
  name: string
  rows: RowTpl[]
  /** 分页配置；缺省不分页 */
  page?: PageConfig | null
}

export interface ReportTemplate {
  sheets: SheetTpl[]
  datasets?: Record<string, Record<string, unknown>[]>
}

/** 服务端现查的数据源声明（字段与 /api/data/rows 的 DataQuery 对齐） */
export interface ReportSource {
  name: string
  connId?: string
  engine?: string
  database?: string
  table?: string
  fields?: string
  limit?: number
  where?: string
  params?: unknown[]
}

export interface RenderRequest {
  template: ReportTemplate
  datasets?: Record<string, Record<string, unknown>[]>
  sources?: ReportSource[]
  /** 输出展开中间结果，用于排查扩展 / 求值问题 */
  dump?: boolean | null
}

/** 列下标 → Excel 列名：0 → A，26 → AA */
export function colName(idx: number): string {
  let n = idx
  let s = ''
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s
    if (n < 26) break
    n = Math.floor(n / 26) - 1
  }
  return s
}

/** 行列下标 → 位置名（0 基）：(0, 2) → "A3" */
export function cellPos(row: number, col: number): string {
  return `${colName(col)}${row + 1}`
}

/** `items[].amount` / `items.amount` → `amount` */
export function stripArrayPrefix(field: string): string {
  return field.replace(/^items(\[\])?\./, '')
}

/** 内置中文别名（面向常见业务字段），显式别名优先于它 */
export const DEFAULT_FIELD_LABELS: Record<string, string> = {
  region: '地区',
  city: '城市',
  province: '省份',
  salesman: '销售员',
  name: '姓名',
  amount: '金额',
  qty: '数量',
  price: '单价',
  month: '月份',
  year: '年份',
  date: '日期',
  product: '产品',
  category: '类别',
  dept: '部门',
  status: '状态',
}

/** 字段 → 显示名：显式别名 > 内置中文别名 > 字段原名 */
export function labelOf(field: string, aliases?: Record<string, string>): string {
  return aliases?.[field] || DEFAULT_FIELD_LABELS[field] || field
}

/** 取某数值字段的显示格式；未配置 → undefined（服务端走全局兜底口径） */
function fmtOf(
  field: string,
  map?: Record<string, CellFormatSpec>,
): CellFormatSpec | undefined {
  return map?.[field]
}

/** 解析参数输入框：空 → []；否则必须是 JSON 数组 */
export function parseParams(text: string): { ok: boolean; params?: unknown[]; message?: string } {
  const t = text.trim()
  if (!t) return { ok: true, params: [] }
  try {
    const v: unknown = JSON.parse(t)
    if (Array.isArray(v)) return { ok: true, params: v }
    return { ok: false, message: '参数需为 JSON 数组，如 ["华东", 1000]' }
  } catch (e) {
    return { ok: false, message: `参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }
  }
}

function cell(
  value: string | null,
  model?: CellModel,
  mergeAcross = 0,
  extra?: { mergeDown?: number; mergeToEnd?: boolean },
): CellTpl {
  const out: CellTpl = {
    pos: undefined,
    value: value ?? undefined,
    model,
    merge_across: mergeAcross,
  }
  if (extra?.mergeDown) out.merge_down = extra.mergeDown
  if (extra?.mergeToEnd) out.merge_to_end = true
  return out
}

/** 按索引写单元格，中间空位补占位格（服务端会跳过无值无模型的格子） */
function setCell(list: CellTpl[], idx: number, c: CellTpl): void {
  while (list.length < idx) list.push(cell(null))
  list[idx] = c
}

export interface GroupTemplateOptions {
  sheetName?: string
  /** 数据集名，需与 ReportSource.name 对应 */
  ds?: string
  /** 分组字段，从粗到细，如 ['region', 'city'] */
  groupFields: string[]
  /** 需要汇总的数值字段 */
  valueField: string
  /**
   * 数值字段在**每组内**的聚合方式，默认 sum。
   *
   * 必须聚合：一个分组下往往有多行明细（如「华东」下有 4 个城市），
   * 只取首行会把 37,900 显示成 12,000，后续小计/总计也跟着错。
   */
  agg?: AggType
  /** 字段 → 中文别名（表头与小计标签用它），缺省回落到内置别名表 */
  aliases?: Record<string, string>
  /** 字段 → 数值显示格式（表头不受影响；小计 / 总计沿用数值列的格式） */
  valueFormats?: Record<string, CellFormatSpec>
  /** 标题（留空则不输出标题行） */
  title?: string
  /** 分页配置；缺省不分页（整张表一次输出） */
  page?: PageConfig
}

/**
 * 生成「分组汇总」模板：N 级分组 + 各级小计/合计 + 总计。
 *
 * 布局（以 2 级分组为例）：
 *   row0 标题（merge_to_end，铺满整行）
 *   row1 表头
 *   row2 分组格 A3/B3 + 数值格 C3（行展开，组内按 agg 聚合）
 *   row3 末级小计（挂最深主格）
 *   row4 总计（标签横跨所有分组列）
 */
export function buildGroupTemplate(opts: GroupTemplateOptions): ReportTemplate {
  const ds = opts.ds ?? 'ds1'
  const aliases = opts.aliases ?? {}
  const groups = opts.groupFields.filter((f) => !!f)
  const cols = groups.length + 1
  const valueCol = cols - 1
  /** 数值列格式：明细 / 小计 / 总计保持一致 */
  const vfmt = fmtOf(opts.valueField, opts.valueFormats)
  const rows: RowTpl[] = []

  if (opts.title) {
    rows.push({ cells: [cell(opts.title, undefined, 0, { mergeToEnd: true })] })
  }

  // 表头（用中文化后的显示名）
  const headerRow = rows.length
  rows.push({
    cells: [
      ...groups.map((f) => cell(labelOf(f, aliases))),
      cell(labelOf(opts.valueField, aliases)),
    ],
  })

  // 明细行：分组格链式 row_parent，数值格挂最深分组格
  const detailRow = rows.length
  const valuePos = cellPos(detailRow, valueCol)
  const detail: CellTpl[] = groups.map((f, i) =>
    cell(null, {
      ds,
      field: f,
      expand_type: 'r',
      row_parent: i === 0 ? undefined : cellPos(detailRow, i - 1),
    }),
  )
  detail.push(
    cell(null, {
      ds,
      field: opts.valueField,
      agg: opts.agg ?? 'sum',
      row_parent: cellPos(detailRow, Math.max(0, groups.length - 1)),
      format: vfmt,
    }),
  )
  rows.push({ cells: detail })

  // 小计行：从次深级往上，最深一级不单独小计（每个明细行本身就是一行）
  for (let k = groups.length - 2; k >= 0; k--) {
    const parentPos = cellPos(detailRow, k)
    const g = labelOf(groups[k]!, aliases)
    const label = k === groups.length - 2 ? `${g}小计` : `${g}合计`
    const row: CellTpl[] = new Array(cols).fill(null).map(() => cell(null))
    row[k] = cell(label, { ds, row_parent: parentPos })
    row[valueCol] = cell(null, {
      ds,
      row_parent: parentPos,
      value_expr: `${valuePos}[${parentPos}:+0].sum()`,
      format: vfmt,
    })
    rows.push({ cells: row })
  }

  // 总计：标签横跨所有分组列（单级分组时 cols-2 = 0，不会与数值列撞在同一格）
  const totalRow: CellTpl[] = new Array(cols).fill(null).map(() => cell(null))
  totalRow[0] = cell('总计', undefined, Math.max(0, cols - 2))
  totalRow[valueCol] = cell(null, { ds, value_expr: `${valuePos}.sum()`, format: vfmt })
  rows.push({ cells: totalRow })

  void headerRow
  return { sheets: [{ name: opts.sheetName ?? '分组汇总', rows }] }
}

export interface DetailTemplateOptions {
  sheetName?: string
  ds?: string
  /** 列定义：title 为表头文字，field 为字段名（允许 items[]. 前缀） */
  columns: Array<{ title?: string; field?: string }>
  /** 字段 → 中文别名（列没有 title 时用它兜底） */
  aliases?: Record<string, string>
  /** 字段 → 数值显示格式（仅对配置了的数值列生效） */
  valueFormats?: Record<string, CellFormatSpec>
  title?: string
  /** 分页配置；缺省不分页 */
  page?: PageConfig
}

/**
 * 由「设计器画布里的表格控件」生成明细表模板。
 *
 * 首列纵向展开（不带 field → 每个数据行一个实例），其余列取字段值并挂首列为主格。
 */
export function buildDetailTemplate(opts: DetailTemplateOptions): ReportTemplate {
  const ds = opts.ds ?? 'ds1'
  const cols = opts.columns.filter((c) => !!c.field)
  if (cols.length === 0) {
    throw new Error('表格没有可映射的字段列')
  }
  const rows: RowTpl[] = []
  if (opts.title) {
    rows.push({ cells: [cell(opts.title, undefined, 0, { mergeToEnd: true })] })
  }
  rows.push({
    cells: cols.map((c) => cell(c.title || labelOf(stripArrayPrefix(c.field ?? ''), opts.aliases))),
  })

  const detailRow = rows.length
  const firstPos = cellPos(detailRow, 0)
  rows.push({
    cells: cols.map((c, i) =>
      cell(null, {
        ds,
        field: i === 0 ? undefined : stripArrayPrefix(c.field ?? ''),
        expand_type: i === 0 ? 'r' : undefined,
        row_parent: i === 0 ? undefined : firstPos,
        format: i === 0 ? undefined : fmtOf(stripArrayPrefix(c.field ?? ''), opts.valueFormats),
      }),
    ),
  })

  return { sheets: [{ name: opts.sheetName ?? '明细表', rows, page: opts.page }] }
}

export interface CrossTemplateOptions {
  sheetName?: string
  ds?: string
  /** 行分组字段（纵向展开），从粗到细 */
  rowFields: string[]
  /** 列分组字段（横向展开），从粗到细 */
  colFields: string[]
  /** 数值字段；多个则在每个列分组下并排展开 */
  valueFields: string[]
  /** 数值格的聚合方式，默认 sum（交叉表一个格子里通常落多行数据） */
  agg?: AggType
  /** 是否输出行合计 / 列合计 / 总计，默认 true */
  totals?: boolean
  /** 字段 → 中文别名（各级表头与「xx合计」用它），缺省回落到内置别名表 */
  aliases?: Record<string, string>
  /** 字段 → 数值显示格式（数值格 / 行合计 / 列合计 / 总计 一致套用） */
  valueFormats?: Record<string, CellFormatSpec>
  title?: string
  /** 分页配置；缺省不分页（整张表一次输出） */
  page?: PageConfig
}

/**
 * 生成「交叉表」模板：行字段纵向展开 × 列字段横向展开 × 数值字段。
 *
 * 布局（1 行字段 / 2 级列字段 / 2 数值字段）：
 * ```text
 *   r0 标题（merge_to_end，铺满整行）
 *   r1 行字段表头(rs=3) | 年份(列展开)          | 金额合计(rs=3) | 数量合计(rs=3)
 *   r2                  | 月份(列展开,col_parent) |
 *   r3                  | 金额 | 数量 | 金额 | 数量 |
 *   r4 行字段(行展开)    | 数值格(挂最深行格×最深列格) | 行合计…
 *   r5 合计             | 列合计…                | 总计…
 * ```
 *
 * 两条关键约束：
 * 1. **合计列的物理列号取决于数据里有多少个列分组**，写死会被覆盖 → 统一用 `col_after`
 *    让服务端在列布局第二遍推算（第 1 个跟在最深列展开格之后，第 n 个跟第 n-1 个之后）
 * 2. **表头格纵跨所有列头行** → 行字段表头与合计表头放在第一行列头并声明 `merge_down`，
 *    否则 N 级列头下表头块会出现半空的行
 */
export function buildCrossTemplate(opts: CrossTemplateOptions): ReportTemplate {
  const ds = opts.ds ?? 'ds1'
  const aliases = opts.aliases ?? {}
  const rowFs = opts.rowFields.filter(Boolean)
  const colFs = opts.colFields.filter(Boolean)
  const valFs = opts.valueFields.filter(Boolean)
  if (rowFs.length === 0 || colFs.length === 0 || valFs.length === 0) {
    throw new Error('交叉表需要至少一个行字段、一个列字段和一个数值字段')
  }
  const withTotals = opts.totals !== false
  /** 每个数值字段的显示格式（数值格与各类合计格共用） */
  const vfmt = valFs.map((f) => fmtOf(f, opts.valueFormats))
  /** 多值字段时补一列表头行，标明每个列分组下并排的是哪个指标 */
  const hasMetricRow = valFs.length > 1
  const rows: RowTpl[] = []

  if (opts.title) rows.push({ cells: [cell(opts.title, undefined, 0, { mergeToEnd: true })] })

  // ---- 列头：每个列字段一层，逐层 col_parent 链式 ----
  const headerStart = rows.length
  const colPos: string[] = []
  colFs.forEach((f, c) => {
    const r: CellTpl[] = []
    setCell(r, rowFs.length + c, cell(null, {
      ds,
      field: f,
      expand_type: 'c',
      col_parent: c === 0 ? undefined : colPos[c - 1],
    }))
    colPos.push(cellPos(headerStart + c, rowFs.length + c))
    rows.push({ cells: r })
  })

  const leafColPos = colPos[colPos.length - 1]!
  /** 表头块行数：各级列头 +（多值字段时）指标子表头 */
  const headerRows = colFs.length + (hasMetricRow ? 1 : 0)
  const valueRowIdx = headerStart + headerRows
  /** 数值单元格起始模板列 = 行字段数 + 列字段数 - 1（与最深列展开格同列） */
  const valueCol0 = rowFs.length + colFs.length - 1
  const valPos = valFs.map((_, j) => cellPos(valueRowIdx, valueCol0 + j))
  const totalCol0 = valueCol0 + valFs.length
  const mergeDown = headerRows - 1

  // 第一行列头：行字段表头（纵跨整个表头块）+ 合计列表头（同样纵跨）
  const firstHeader = rows[headerStart]!
  rowFs.forEach((f, i) =>
    setCell(firstHeader.cells, i, cell(labelOf(f, aliases), undefined, 0, { mergeDown })),
  )
  if (withTotals) {
    let prev: string | undefined
    valFs.forEach((f, j) => {
      const col = totalCol0 + j
      setCell(
        firstHeader.cells,
        col,
        cell(`${labelOf(f, aliases)}合计`, { ds, col_after: prev ?? leafColPos }, 0, { mergeDown }),
      )
      prev = cellPos(headerStart, col)
    })
  }

  // 指标子表头：每个列分组下并排的「金额 / 数量」，各自挂最深列展开格
  if (hasMetricRow) {
    const sub: CellTpl[] = []
    valFs.forEach((f, j) => {
      setCell(sub, valueCol0 + j, cell(labelOf(f, aliases), { ds, col_parent: leafColPos }))
    })
    rows.push({ cells: sub })
  }

  // ---- 明细行：行字段链式展开 + 数值格挂 (最深行格, 最深列格) ----
  const rowPos: string[] = []
  const valueRow: CellTpl[] = []
  rowFs.forEach((f, i) => {
    setCell(valueRow, i, cell(null, {
      ds,
      field: f,
      expand_type: 'r',
      row_parent: i === 0 ? undefined : rowPos[i - 1],
    }))
    rowPos.push(cellPos(valueRowIdx, i))
  })
  const leafRowPos = rowPos[rowPos.length - 1]!
  valFs.forEach((f, j) => {
    setCell(valueRow, valueCol0 + j, cell(null, {
      ds,
      field: f,
      agg: opts.agg ?? 'sum',
      row_parent: leafRowPos,
      col_parent: leafColPos,
      format: vfmt[j],
    }))
  })
  if (withTotals) {
    let prev: string | undefined
    valFs.forEach((_f, j) => {
      const col = totalCol0 + j
      setCell(valueRow, col, cell(null, {
        ds,
        row_parent: leafRowPos,
        col_after: prev ?? leafColPos,
        value_expr: `${valPos[j]}[${leafRowPos}:+0].sum()`,
        format: vfmt[j],
      }))
      prev = cellPos(valueRowIdx, col)
    })
  }
  rows.push({ cells: valueRow })

  // ---- 合计行：列合计（沿 col_parent 链汇总）+ 总计 ----
  if (withTotals) {
    const totalRowIdx = rows.length
    const totalRow: CellTpl[] = []
    setCell(totalRow, 0, cell('合计'))
    valFs.forEach((_f, j) => {
      setCell(totalRow, valueCol0 + j, cell(null, {
        ds,
        col_parent: leafColPos,
        value_expr: `${valPos[j]}[${leafColPos}:+0].sum()`,
        format: vfmt[j],
      }))
    })
    let prev: string | undefined
    valFs.forEach((_f, j) => {
      const col = totalCol0 + j
      setCell(totalRow, col, cell(null, {
        ds,
        col_after: prev ?? leafColPos,
        value_expr: `${valPos[j]}.sum()`,
        format: vfmt[j],
      }))
      prev = cellPos(totalRowIdx, col)
    })
    rows.push({ cells: totalRow })
  }

  return { sheets: [{ name: opts.sheetName ?? '交叉表', rows }] }
}

/** 表头样式 id（Univer IStyleData：加粗 + 居中 + 浅蓝底） */
const HEADER_STYLE_ID = 'grid-hdr'
/** 设计态样式：扩展格（黄底加粗） / 绑定格（蓝字） / 当前选中（蓝底蓝框） */
const EXPAND_STYLE_ID = 'tpl-expand'
const BINDING_STYLE_ID = 'tpl-binding'
const SELECTED_STYLE_ID = 'tpl-selected'

/**
 * 模板前部的表头行数（标题行 + 各级列头 + 指标子表头），到第一个行展开格为止。
 * 只用于给 Univer 表头加粗/加底色，不影响展开结果。
 */
export function headerRowCount(tpl: ReportTemplate): number {
  const rows = tpl.sheets[0]?.rows ?? []
  let n = 0
  for (const r of rows) {
    const isHeader = r.cells.every((c) => c.model?.expand_type !== 'r' && !c.model?.row_parent)
    if (!isHeader) break
    n++
  }
  return n
}

/**
 * 展开结果 → Univer 工作簿数据（rowspan/colspan 转 mergeData）。
 *
 * `opts.headerRows` 指定的行会套上表头样式（加粗/居中/底色），用于「多级表头美化」。
 */
export function toWorkbookData(sheet: RenderedSheet, opts: { headerRows?: number } = {}) {
  const cellData: Record<number, Record<number, { v: string; s?: string }>> = {}
  const mergeData: Array<{
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
  }> = []

  const headerRows = Math.max(0, opts.headerRows ?? 0)

  sheet.rows.forEach((row, r) => {
    row.forEach((c, cIdx) => {
      if (!c || !c.text) return
      cellData[r] = cellData[r] || {}
      cellData[r][cIdx] = r < headerRows ? { v: c.text, s: HEADER_STYLE_ID } : { v: c.text }
      const rs = Math.max(1, c.rowspan || 1)
      const cs = Math.max(1, c.colspan || 1)
      if (rs > 1 || cs > 1) {
        mergeData.push({
          startRow: r,
          endRow: r + rs - 1,
          startColumn: cIdx,
          endColumn: cIdx + cs - 1,
        })
      }
    })
  })

  const columnCount = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)

  return {
    id: 'grid-report',
    name: sheet.name,
    sheetOrder: ['sheet1'],
    styles: {
      [HEADER_STYLE_ID]: { bl: 1, ht: 2, vt: 2, bg: { rgb: '#D9E1F2' } },
    },
    sheets: {
      sheet1: {
        id: 'sheet1',
        name: sheet.name || '报表',
        rowCount: Math.max(sheet.rows.length, 50),
        columnCount: Math.max(columnCount, 10),
        cellData,
        mergeData,
      },
    },
  }
}

/* ------------------------------------------------------------------ *
 * 自由模板（类 Excel 逐格设计）
 *
 * 上面的三个构造器是「向导」：选字段 → 机器拼模板。它们盖不住
 * 「手写模板」场景——比如验证缺省父格跟随规则的那个三层模板，
 * 只能手写 JSON。这一层给 UI 提供逐格编辑需要的纯函数，
 * 全部可单测，Univer 只当画布。
 * ------------------------------------------------------------------ */

/**
 * 模板格里「绑定」的写法：`{{ds1.city}}` / `{{ds1.amount.sum()}}` / `{{D3[B3:+0].sum()}}`。
 *
 * **为什么不是 `=ds1.city`（润乾/类 Excel 的惯例）**：Univer 的 core preset 自带
 * 公式引擎，任何 `=` 开头的输入都会被当 Excel 公式解析，而我们这套
 * `D3[A3:+0].sum()` 层次坐标 DSL 在 Excel 里没有对应物，会直接显示 `#NAME?`。
 * 用 `{{}}` 保证：Univer 永远当纯文本，回读时不丢原样。
 */
const BIND_RE = /^\{\{([\s\S]+)\}\}$/
/** `ds1.city` */
const FIELD_RE = /^([A-Za-z_]\w*)\.([A-Za-z_][\w.]*)$/
/** `ds1.amount.sum()` */
const AGG_RE = /^([A-Za-z_]\w*)\.([A-Za-z_][\w.]*)\.(sum|count|avg|min|max)\(\)$/

/** 模板格文本解析结果 */
export type CellText =
  | { kind: 'literal'; text: string }
  | { kind: 'field'; ds: string; field: string; agg?: AggType }
  | { kind: 'expr'; expr: string }

/** 模板格文本 → 语义。`{{...}}` 之外一律当字面量。 */
export function parseCellText(raw: string): CellText {
  const t = (raw ?? '').trim()
  const m = BIND_RE.exec(t)
  if (!m) return { kind: 'literal', text: raw ?? '' }
  const inner = m[1].trim()
  const agg = AGG_RE.exec(inner)
  if (agg) {
    return { kind: 'field', ds: agg[1], field: agg[2], agg: agg[3] as AggType }
  }
  const fld = FIELD_RE.exec(inner)
  if (fld) return { kind: 'field', ds: fld[1], field: fld[2] }
  // 既不是 ds.field 也不是 ds.field.agg()：当表达式（层次坐标 / 条件表达式等）
  return { kind: 'expr', expr: inner }
}

/** 单元格 → 模板格文本（parseCellText 的逆）。空串表示这一格没内容。 */
export function formatCellText(cell: CellTpl): string {
  const m = cell.model
  if (m?.value_expr) return `{{${m.value_expr}}}`
  if (m?.field) {
    const ds = m.ds || 'ds1'
    const agg = m.agg ? `.${m.agg}()` : ''
    return `{{${ds}.${m.field}${agg}}}`
  }
  if (cell.value === undefined || cell.value === null) return ''
  return String(cell.value)
}

/** 模板设计网格：矩形的 CellTpl 二维数组（比 SheetTpl 多一层「固定尺寸」约束） */
export type TemplateGrid = CellTpl[][]

export function emptyGrid(rows: number, cols: number): TemplateGrid {
  const g: TemplateGrid = []
  for (let r = 0; r < rows; r++) {
    const row: CellTpl[] = []
    for (let c = 0; c < cols; c++) row.push({ value: null, model: undefined })
    g.push(row)
  }
  return g
}

/** SheetTpl → 矩形网格（不足的行列补空格，方便 UI 直接按下标渲染） */
export function templateToGrid(sheet: SheetTpl, minRows = 20, minCols = 10): TemplateGrid {
  const src = sheet.rows ?? []
  const rows = Math.max(src.length, minRows)
  const cols = Math.max(src.reduce((m, r) => Math.max(m, r.cells?.length ?? 0), 0), minCols)
  const g = emptyGrid(rows, cols)
  src.forEach((row, r) => {
    ;(row.cells ?? []).forEach((cell, c) => {
      if (c < cols) g[r][c] = cell
    })
  })
  return g
}

/**
 * 网格 → SheetTpl。尾部全空的行会被裁掉（否则服务端会展开出一堆空行）；
 * **中间的空格必须保留**——它参与「向左/向上扫找主格」的判定。
 */
export function gridToSheet(grid: TemplateGrid, name: string): SheetTpl {
  const lastContentRow = grid.reduce(
    (acc, row, r) => (row.some((c) => formatCellText(c) !== '' || c.model) ? r : acc),
    -1,
  )
  const rows = grid.slice(0, lastContentRow + 1).map((row) => ({ cells: row }))
  return { name, rows, page: null }
}

/** 不可变地改一格。越界返回原网格（UI 不应让它发生，但不让它炸）。 */
export function setGridCell(grid: TemplateGrid, r: number, c: number, cell: CellTpl): TemplateGrid {
  if (!grid[r] || c < 0 || c >= grid[r].length) return grid
  return grid.map((row, ri) => (ri === r ? row.map((x, ci) => (ci === c ? cell : x)) : row))
}

/* ------------------------------------------------------------------ *
 * 位置引用的整体平移
 *
 * 插/删行列时，`row_parent:"A3"`、`value_expr:"D3[B3:+0].sum()"` 这些**文本引用**
 * 会整片失效。不做重映射的话，插一行表头就能让整个模板静默错位——
 * 这是类 Excel 设计器最容易漏、也最难查的一类 bug。
 * ------------------------------------------------------------------ */

/**
 * 单元格引用：`A3` / `D12`。
 *
 * 前后加断言是为了避开三类误伤（每一条都有对应用例，别随手放宽）：
 * - `ds1.city` —— 数据集名带数字，但它是小写，且 `1` 后面跟 `.`；
 * - `items[0].amount` / `qty1` —— 下标和字段名里的数字不是行号；
 * - **断言里不能加 `[`**：`D3[B3:+0].sum()` 的 `B3` 前面就是 `[`，
 *   加了就漏掉层次坐标里的括号引用（这个 bug 是被用例抓出来的）。
 * 反过来，`B3:+0` 的 `B3` 本身**是**引用要平移，`:+0` 是相对偏移不动。
 */
const CELL_REF_RE = /(?<![A-Za-z0-9_.])([A-Z]{1,3})([1-9]\d{0,6})(?![A-Za-z0-9_.])/g

/** 列名 → 列下标：A → 0，AA → 26 */
export function colIndex(name: string): number {
  let n = 0
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 位置名 → 行列下标；非法输入返回 null */
export function parsePos(pos: string): { r: number; c: number } | null {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(pos)
  if (!m) return null
  return { r: Number(m[2]) - 1, c: colIndex(m[1]) }
}

/**
 * 平移一段文本里的所有单元格引用。
 *
 * - 插入（delta > 0）：下标 ≥ at 的整体 +1
 * - 删除（delta < 0）：下标 > at 的整体 -1；**正好指向 at 的返回空串**——
 *   它引用的那一行/列没了，留着悬空引用会静默指向别处，比没有引用更危险。
 */
function shiftText(text: string, axis: 'row' | 'col', at: number, delta: number): string {
  return text.replace(CELL_REF_RE, (full, col: string, rowStr: string) => {
    const r0 = Number(rowStr) - 1
    const c0 = colIndex(col)
    const cur = axis === 'row' ? r0 : c0
    if (cur < at) return full
    if (delta < 0 && cur === at) return ''
    const next = cur + delta
    if (next < 0) return ''
    return axis === 'row' ? cellPos(next, c0) : cellPos(r0, next)
  })
}

/** 需要参与平移的字段：凡是可能写位置名的，一个都不能漏 */
const REF_FIELDS = [
  'row_parent',
  'col_parent',
  'col_after',
  'value_expr',
  'expand_expr',
  'row_test_expr',
  'col_test_expr',
] as const

function shiftModel(
  m: CellModel | undefined,
  axis: 'row' | 'col',
  at: number,
  delta: number,
): CellModel | undefined {
  if (!m) return m
  const next: CellModel = { ...m }
  for (const k of REF_FIELDS) {
    const v = m[k]
    if (typeof v !== 'string' || !v) continue
    const shifted = shiftText(v, axis, at, delta)
    // 主格被删掉 → 清空（留着悬空引用比没有主格更危险：会静默挂到别处）
    ;(next as Record<string, unknown>)[k] = shifted === '' || shifted === null ? undefined : shifted
  }
  return next
}

/** 插入行（at 之前）。所有 ≥at 的行引用整体 +1。 */
export function insertGridRow(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'row', at, 1, true)
}
/** 删除行。所有 >at 的行引用 -1；正好指向 at 的引用被清空。 */
export function deleteGridRow(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'row', at, -1, false)
}
export function insertGridCol(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'col', at, 1, true)
}
export function deleteGridCol(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'col', at, -1, false)
}

function shiftGrid(
  grid: TemplateGrid,
  axis: 'row' | 'col',
  at: number,
  delta: number,
  insert: boolean,
): TemplateGrid {
  const blank: CellTpl = { value: null, model: undefined }
  // 1) 先按轴平移结构
  let out: TemplateGrid
  if (axis === 'row') {
    if (at < 0 || at > grid.length) return grid
    const copy = grid.map((row) => row.slice())
    if (insert) {
      copy.splice(at, 0, (grid[0] ?? []).map(() => ({ ...blank })))
    } else {
      copy.splice(at, 1)
    }
    out = copy
  } else {
    const copy = grid.map((row) => row.slice())
    for (const row of copy) {
      if (insert) row.splice(at, 0, { ...blank })
      else row.splice(at, 1)
    }
    out = copy
  }
  // 2) 再平移文本引用（这一句才是重点：结构挪了，引用必须跟着挪）
  return out.map((row) =>
    row.map((cell) => {
      if (!cell.model) return cell
      return { ...cell, model: shiftModel(cell.model, axis, at, delta) }
    }),
  )
}

/**
 * 模板体检：把「表照常出但数据不是你想要的」那类问题提前报出来。
 *
 * 只报**能确定是错的**，不报「可能你想这么写」——告警一多就没人看了。
 */
export function validateTemplate(tpl: ReportTemplate): string[] {
  const out: string[] = []
  const sheet = tpl.sheets?.[0]
  if (!sheet) return ['模板至少一个 sheet']

  // 位置 → 模型，用于检查主格指向的格子是否真的存在 / 是否也是展开格
  const at = (r: number, c: number): CellTpl | undefined => sheet.rows?.[r]?.cells?.[c]

  sheet.rows?.forEach((row, r) => {
    row.cells?.forEach((cell, c) => {
      const m = cell.model
      if (!m) return
      const pos = cellPos(r, c)

      if (m.expand_type && !m.ds && !m.expand_expr) {
        out.push(`${pos}：设了扩展方向却没有数据集（也没写 expand_expr），展开不出东西`)
      }
      if (m.expand_type && !m.field && !m.expand_expr && !m.value_expr) {
        out.push(`${pos}：扩展格没有字段也没有表达式`)
      }

      for (const [key, ref] of [
        ['左主格 row_parent', m.row_parent],
        ['上主格 col_parent', m.col_parent],
      ] as const) {
        if (!ref) continue
        const p = parsePos(ref)
        if (!p) {
          out.push(`${pos}：${key} "${ref}" 不是合法位置名`)
          continue
        }
        if (p.r === r && p.c === c) {
          out.push(`${pos}：${key} 指向自己`)
          continue
        }
        const target = at(p.r, p.c)
        if (!target?.model) {
          out.push(`${pos}：${key} 指向 ${ref}，但那一格没有数据模型`)
        }
      }

      // 主格成环：A3←B3←A3 会让展开停不下来
      const seen = new Set<string>([pos])
      let cur = m.row_parent
      let hops = 0
      while (cur && hops++ < 64) {
        if (seen.has(cur)) {
          out.push(`${pos}：左主格链成环（${[...seen, cur].join(' → ')}）`)
          break
        }
        seen.add(cur)
        const p = parsePos(cur)
        cur = p ? at(p.r, p.c)?.model?.row_parent : undefined
      }
    })
  })

  return [...new Set(out)]
}

/**
 * 模板网格 → Univer 工作簿数据（**设计态**，与展开结果的 toWorkbookData 区分开）。
 *
 * 这里只是「把每格的模板文本摆进格子」，不做任何展开。扩展格用底色标出来，
 * 因为 `{{ds1.city}}` 和字面量「城市」在格子里长得几乎一样，不标根本分不清。
 */
export function gridToWorkbookData(grid: TemplateGrid, opts: { selected?: string } = {}) {
  const cellData: Record<number, Record<number, { v: string; s?: string }>> = {}
  grid.forEach((row, r) => {
    row.forEach((cell, c) => {
      const text = formatCellText(cell)
      if (!text) return
      cellData[r] = cellData[r] || {}
      const pos = cellPos(r, c)
      const m = cell.model
      let s: string | undefined
      if (pos === opts.selected) s = SELECTED_STYLE_ID
      else if (m?.expand_type) s = EXPAND_STYLE_ID
      else if (text.startsWith('{{')) s = BINDING_STYLE_ID
      cellData[r][c] = { v: text, ...(s ? { s } : {}) }
    })
  })

  const columnCount = grid.reduce((m, r) => Math.max(m, r.length), 0)
  return {
    id: 'grid-template',
    name: '模板',
    sheetOrder: ['sheet1'],
    styles: {
      [EXPAND_STYLE_ID]: { bl: 1, bg: { rgb: '#FFF1B8' } },
      [BINDING_STYLE_ID]: { cl: { rgb: '#1668DC' } },
      [SELECTED_STYLE_ID]: { bl: 1, bg: { rgb: '#D6E4FF' }, bd: { b: { s: 1, cl: { rgb: '#1677FF' } } } },
    },
    sheets: {
      sheet1: {
        id: 'sheet1',
        name: '模板',
        rowCount: Math.max(grid.length, 50),
        columnCount: Math.max(columnCount, 12),
        cellData,
        mergeData: [],
      },
    },
  }
}

/**
 * 打开「导出公式」：给所有带 `value_expr` 的格打上 `export_formula`。
 *
 * 做成后处理而不是改三个构造器：构造器里小计 / 合计 / 总计的格散落多处，
 * 逐个加参数会污染签名；而「要不要公式」本身是个整体开关，统一套一层更清楚。
 */
export function withExportFormula(tpl: ReportTemplate, on = true): ReportTemplate {
  if (!on) return tpl
  return {
    ...tpl,
    sheets: tpl.sheets.map((s) => ({
      ...s,
      rows: s.rows.map((r) => ({
        cells: r.cells.map((c) => {
          const m = c.model
          if (!m?.value_expr) return c
          return { ...c, model: { ...m, export_formula: true } }
        }),
      })),
    })),
  }
}

/**
 * 展开控制：最少条数 / 最多条数 / 空数据集时是否保留。
 *
 * 三个属性**打在不同层级上**，这是本函数存在的唯一理由：
 *
 * - `minCount`（补空行）→ **最内层**行展开格。
 *   「每组至少留 5 行」说的是明细级，打在外层会变成「至少 5 个分组」。
 * - `maxCount`（只显示前 N 条）→ **最外层**行展开格。
 *   「TOP 10」说的是分组数；打在明细级会变成「每个分组只显示前 10 行」。
 * - `keepEmpty` → **所有**行展开格。逐级保留是想要的：空报表也要有一行空行撑着表头。
 *
 * 为什么不能一律打在所有行展开格上：分组模板里每个分组格都带 `expand_type:'r'` 且用
 * `row_parent` 链式嵌套，逐级生效会让条数相乘——2 级分组 + 最少 5 行 = 至少 25 行。
 *
 * 层级的判定靠位置名：`cell()` 不写 `pos`（由服务端按行列下标推断），但构造器写
 * `row_parent` 时用的就是 `cellPos()`，所以这里用同一个函数把位置补算回来再比对。
 */
export interface ExpandControl {
  /** 展开条数下限：不足时补空行。0 / undefined = 不限制 */
  minCount?: number
  /** 展开条数上限：只显示前 N 条。0 / undefined = 不限制 */
  maxCount?: number
  /** 展开集为空时保留该格（缺省会连同子格一起删除） */
  keepEmpty?: boolean
}

export function withExpandControl(tpl: ReportTemplate, ctl: ExpandControl): ReportTemplate {
  const min = ctl.minCount && ctl.minCount > 0 ? ctl.minCount : undefined
  const max = ctl.maxCount && ctl.maxCount > 0 ? ctl.maxCount : undefined
  const keep = ctl.keepEmpty ? true : undefined
  if (min === undefined && max === undefined && keep === undefined) return tpl

  return {
    ...tpl,
    sheets: tpl.sheets.map((sheet) => {
      // 先扫一遍：收集行展开格的位置，以及「谁被别的行展开格认作父格」
      const expandPos = new Set<string>()
      const childOf = new Set<string>()
      sheet.rows.forEach((row, ri) => {
        row.cells.forEach((c, ci) => {
          if (c.model?.expand_type !== 'r') return
          expandPos.add(cellPos(ri, ci))
          if (c.model.row_parent) childOf.add(c.model.row_parent)
        })
      })

      return {
        ...sheet,
        rows: sheet.rows.map((row, ri) => ({
          cells: row.cells.map((c, ci) => {
            const m = c.model
            if (m?.expand_type !== 'r') return c
            const pos = cellPos(ri, ci)
            const isOutermost = !m.row_parent || !expandPos.has(m.row_parent)
            const isInnermost = !childOf.has(pos)
            const next: CellModel = {
              ...m,
              expand_min_count: isInnermost ? min : undefined,
              expand_max_count: isOutermost ? max : undefined,
              keep_expand_empty: keep,
            }
            return { ...c, model: next }
          }),
        })),
      }
    }),
  }
}
