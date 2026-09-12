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
}

export interface RenderedSheet {
  name: string
  rows: GridCell[][]
}

export interface RenderResponse {
  sheets: RenderedSheet[]
  html: string
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
  /** 数值显示格式（小计 / 合计格应与所在数值列一致） */
  format?: CellFormatSpec
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

  return { sheets: [{ name: opts.sheetName ?? '明细表', rows }] }
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
