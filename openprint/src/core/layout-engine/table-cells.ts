/**
 * table-cells —— 表格设计期单元格网格模型（纯函数，可测）
 *
 * 把"列驱动 + 数据源"的传统表格，叠加一层**设计期可编辑的单元格网格**，
 * 使得双击任意单元格即可填写文字 / 绑定字段 / 调字体 / 填色，
 * 同时**完全兼容**未设置 cells 的旧模板（回落到列驱动渲染）。
 *
 * 行语义（designRowInfo）：
 * - 数据表（有 dataSource）：前 headerRows 行为表头；第 headerRows 行为"数据样例行"（模板，
 *   编辑它 = 编辑该列所有数据行）；其后 staticRows 行为静态尾行（合计 / 备注）。
 *   可视行与 cells 行 1:1 对应（cells 长度 = headerRows + 1 + staticRows）。
 * - 布局网格（无 dataSource）：前 headerRows 行为表头（由列标题推导），其后 designRows 行为
 *   静态内容（cells 长度 = headerRows + designRows）。
 *
 * ⚠️ `designRows` 语义 = **正文行数（不含表头）**；可视行总数一律取 `grid.rowCount`。
 */
import type { TableCell, TableCellStyle, TableColumn, TableControl } from '@/types/control'
import { isAggToken, parseAggToken, stripItems } from './aggregate'
import { ptToMm } from '@/core/units'
import { getSharedMeasurer } from '@/core/layout-engine/measure'

export const DEFAULT_HEADER_ROWS = 1

/**
 * 真实布局能力探测（带缓存）。
 * Vitest 的 happy-dom / jsdom 虽定义了 document.body，但不实现 CSS 布局引擎，
 * getBoundingClientRect 永远返回 0（见 measure.ts 顶部警告）。因此不能仅凭
 * `document.body` 是否存在就判定"可用 DOM 测量"。这里实际量一个 10px 探针元素，
 * 高度 > 0 才表示浏览器真排版 —— 此时 designRowHeights 走真实 DomMeasurer，
 * 否则回落字符估算（单测结果可复现、与 createCjkMeasurer 同规则）。
 */
let _domLayoutReady: boolean | null = null
function domSupportsLayout(): boolean {
  if (_domLayoutReady !== null) return _domLayoutReady
  if (typeof document === 'undefined' || !document.body) {
    _domLayoutReady = false
    return false
  }
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;width:10px;height:10px;padding:0;margin:0;border:0'
  document.body.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  _domLayoutReady = h > 0
  return _domLayoutReady
}

/* ─── 与 table-engine.ts 共享的排版常量（内联以避免循环导入）─── */
/** 数据表行高估算用：字号 9pt、行高 1.35、垂直内边距 1.2mm、水平内边距 2mm、最小行高 6mm */
const _TABLE_FONT_SIZE_PT = 9
const _LINE_HEIGHT_FACTOR = 1.35
const _CELL_PADDING_Y = 1.2
const _CELL_PADDING_X = 2
/** 单元格边框（与 tableCss `b-all td { border: 0.2mm }` 一致）；border-box 下占入行高 */
const _BORDER_MM = 0.2
const _MIN_ROW_HEIGHT = 6

export type DesignRowKind = 'header' | 'data' | 'static'

/**
 * 单个单元格的合并布局结果（由 computeSpanLayout 统一计算）。
 * - skip=true：该格被左/上某个合并格吞掉，渲染时跳过（矩阵仍留位保持规整）。
 * - colSpan / rowSpan：本格实际生效的合并跨度（已收敛到网格边界）。
 */
export interface CellSpan {
  skip: boolean
  colSpan: number
  rowSpan: number
}

export interface DesignRowInfo {
  kind: DesignRowKind
  /** 在 control.cells 中的行下标（数据表与可视行 1:1） */
  cellRow: number
  /** 是否为数据表的数据样例行（编辑影响整列） */
  isDataTemplate: boolean
}

export interface DesignGrid {
  isData: boolean
  headerRows: number
  staticRows: number
  /** 布局网格的正文行数（不含表头）；数据表恒为 0 */
  designRows: number
  /** 可视行总数（含表头 / 数据样例行 / 静态尾行） */
  rowCount: number
  colCount: number
  cells: TableCell[][]
}

/** 该表格是否数据表（绑定了数据源数组，或自带内嵌 data 行） */
export function isDataTable(control: TableControl): boolean {
  return (
    Boolean(control.dataSource?.trim()) ||
    (Array.isArray(control.data) && control.data.length > 0)
  )
}

/**
 * 表头行数。
 * 未显式设置时：**有任一列标题 → 1 行，否则 0 行**（数据表 / 布局网格同一规则），
 * 与运行期旧版 `columns.some(c => c.title)` 判定一致，保证老模板打印结果不变。
 */
export function headerRowsOf(control: TableControl): number {
  if (typeof control.headerRows === 'number') return Math.max(0, control.headerRows)
  return (control.columns ?? []).some((c) => c.title) ? DEFAULT_HEADER_ROWS : 0
}

export function staticRowsOf(control: TableControl): number {
  return isDataTable(control) ? Math.max(0, control.staticRows ?? 0) : 0
}

function emptyRow(colCount: number): TableCell[] {
  return Array.from({ length: colCount }, () => ({}))
}

/** 从列配置推导单元格（用于无 cells 时的瞬时渲染 / 首次初始化） */
function cellFromColumn(col: TableColumn, role: 'header' | 'data'): TableCell {
  if (role === 'header') {
    return {
      text: col.title,
      style: {
        backgroundColor: col.headerBackgroundColor,
        // 与运行期 table-engine 表头默认一致：headerAlign → align → center
        align: col.headerAlign ?? col.align ?? 'center',
        bold: true,
      },
    }
  }
  return {
    field: col.field,
    expression: col.expression,
    style: {
      backgroundColor: col.cellBackgroundColor,
      align: col.align,
      ...(col.style ?? {}),
    },
  }
}

/**
 * 布局网格的正文行数（不含表头）。
 * 真理源优先级：已物化的 cells 行数 > 显式 designRows > 按控件高度推算。
 * （以 cells 为先，才不会在改了表头行数后把用户已填的行挤掉。）
 */
function layoutBodyRows(control: TableControl, headerRows: number): number {
  if (control.cells && control.cells.length > 0) {
    return Math.max(1, control.cells.length - headerRows)
  }
  if (typeof control.designRows === 'number' && control.designRows > 0) return control.designRows
  const rowH = Math.max(4, control.options?.rowHeight ?? 8)
  const bodyH = Math.max(0, control.height - headerRows * rowH)
  return Math.max(1, Math.floor(bodyH / rowH) || 1)
}

/** 该单元格是否"从未被写过内容"（用于表头兜底判定；显式清空写入的 `text: ''` 不算空） */
function isBlankCell(cell: TableCell | undefined): boolean {
  return !cell || (cell.text === undefined && !cell.field && !cell.expression)
}

/**
 * 计算设计期网格（不修改入参）。
 * - 若 control.cells 存在：归一化其行数 / 列数后使用；整行空白的表头行用列标题兜底
 *   （用户改了列标题却看不到，比"尊重空表头"更反直觉）。
 * - 否则：由列配置瞬时推导。
 *   - 数据表 = headerRows 行表头 + 1 行数据样例 + staticRows 行静态尾行
 *   - 布局网格 = headerRows 行表头 + designRows 行静态正文
 */
export function buildDesignGrid(control: TableControl): DesignGrid {
  const cols = control.columns ?? []
  const colCount = Math.max(1, cols.length)
  const data = isDataTable(control)
  const headerRows = headerRowsOf(control)
  const staticRows = staticRowsOf(control)
  const bodyRows = data ? 1 : layoutBodyRows(control, headerRows)
  const rowCount = headerRows + bodyRows + staticRows

  // 由列配置推导的"标准网格"，同时充当已有 cells 的兜底来源
  const derived = normalizeCellRows(
    [
      ...Array.from({ length: headerRows }, () => cols.map((c) => cellFromColumn(c, 'header'))),
      ...(data
        ? [cols.map((c) => cellFromColumn(c, 'data'))]
        : Array.from({ length: bodyRows }, () => emptyRow(colCount))),
      ...Array.from({ length: staticRows }, () => emptyRow(colCount)),
    ],
    rowCount,
    colCount,
  )

  let cells = derived
  if (control.cells && control.cells.length > 0) {
    cells = normalizeCellRows(control.cells, rowCount, colCount)
    for (let r = 0; r < headerRows; r++) {
      if (cells[r]!.every(isBlankCell)) cells[r] = derived[r]!
    }
  }

  return {
    isData: data,
    headerRows,
    staticRows,
    designRows: data ? 0 : bodyRows,
    rowCount,
    colCount,
    cells,
  }
}

/**
 * 设计期各可视行的行高（mm）—— **设计画布与运行期共用**，是"所见即所得"的根。
 *
 * 两种算法按表格类型分流：
 *
 * - **布局网格**（无 dataSource，`isDataTable=false`）：
 *   表头按 8mm/行 分配（最多占 32% 高度），剩余高度由正文行均分，合计恰好 = 控件高度。
 *   这类表格本身就是「所见即所得」—— 画布上多高，打印就多高。
 *
 * - **数据表**（有 dataSource 或内嵌 data）：
 *   渲染端完全忽略 `control.height`，按内容测量行高（auto 模式）或固定行高（fixed 模式）。
 *   因此画布行高也必须走同一套算法，否则画布行高 ≈ 12mm 而渲染行高 ≈ 6mm，差 2 倍。
 *   这里用与 `measureRowHeight`（table-engine.ts）完全一致的常量估算：
 *   - fixed → `max(MIN_ROW_HEIGHT, options.rowHeight)`
 *   - auto  → `fontSize * lineHeight + 2 * paddingY`（≈ 6.4mm 单行），表头同样。
 *
 * @param heightMm 控件高度（mm）。仅布局网格使用。协议单位非 mm 时由调用方换算后传入。
 */
export function designRowHeights(control: TableControl, heightMm?: number): number[] {
  const grid = buildDesignGrid(control)

  if (isDataTable(control)) {
    // ── 数据表：与渲染端 measureRowHeight 一致 ──
    const mode = control.options?.rowHeightMode ?? 'auto'
    if (mode === 'fixed') {
      const fixedH = Math.max(_MIN_ROW_HEIGHT, control.options?.rowHeight ?? 8)
      return Array.from({ length: grid.rowCount }, () => fixedH)
    }
    // auto：逐行按内容换行测量，与渲染端 measureRowHeight 完全一致（共用同一款 DomMeasurer）。
    //   - 绑定 / 表达式 / 聚合 token 单元格 → 画布强制 nowrap 单行（ellipsis），跳过不撑高
    //   - 静态文本（表头标题、尾行标签如"本页合计/大写金额"）→ 按列宽真实排版换行
    // 浏览器里走真实 DOM 测量（getSharedMeasurer），其字体/字号/行高/white-space 与 tableCss
    // 完全一致，因此 control.height 像素级等于实际渲染高度，Fabric 选中框（= control.height）
    // 严丝合缝包住表格四边，不再"下方露出"。无 DOM（单测 / node）回落到字符宽度估算。
    const colWidths = designColWidths(control)
    if (domSupportsLayout()) {
      const measurer = getSharedMeasurer()
      return grid.cells.map((row, r) => {
        const kind = designRowInfo(grid, r).kind
        let maxH = 0
        for (let c = 0; c < row.length; c++) {
          const cell = row[c]
          if (!cell) continue
          // 绑定 / 表达式 / 聚合 token 单元格：画布渲染为 nowrap 单行占位符，
          // 仍要按单行高度计入行高（否则该行塌成 MIN_ROW_HEIGHT，而真实占位符占 ~1 行）。
          const isPlaceholder = Boolean(cell.field || cell.expression || isAggToken(cell.text ?? ''))
          const measured = isPlaceholder
            ? cell.text || cell.field || cell.expression || ' '
            : cell.text ?? ''
          if (!measured) continue
          const col = control.columns?.[c]
          const style = resolveCellStyleFor(control, col, cell, kind)
          // 列宽扣掉左右内边距与左右边框（border-box 下边框占入单元格宽度）；
          // 行高再加回上下边框（border-box 下边框占入行高）。这样 designRowHeights
          // 严格等于 border-box 单元格的真实渲染高度，Fabric 选中框（= control.height）
          // 与表格内容四边严丝合缝；非 b-all 边框模式仅会略略偏保守（不露底）。
          const avail = Math.max(1, (colWidths[c] ?? 0) - 2 * _CELL_PADDING_X - 2 * _BORDER_MM)
          const { heightMm: h } = measurer.measure(measured, {
            fontSize: style.fontSize ? Number(style.fontSize) : _TABLE_FONT_SIZE_PT,
            fontWeight: style.bold ? 'bold' : 'normal',
            widthMm: avail,
            wrap: isPlaceholder ? false : true,
          })
          if (h > maxH) maxH = h
        }
        return Math.max(_MIN_ROW_HEIGHT, maxH + 2 * _CELL_PADDING_Y + 2 * _BORDER_MM)
      })
    }
    const singleLineH = ptToMm(_TABLE_FONT_SIZE_PT) * _LINE_HEIGHT_FACTOR + 2 * _CELL_PADDING_Y
    const baseH = Math.max(_MIN_ROW_HEIGHT, singleLineH)
    return grid.cells.map((row) => Math.max(baseH, designRowContentHeight(row, colWidths)))
  }

  // ── 布局网格：按控件高度均分（画布 = 打印，真正所见即所得）──
  const totalH = Math.max(1, heightMm ?? control.height)
  const headerRows = grid.headerRows
  const bodyCount = Math.max(1, grid.rowCount - headerRows)
  const headerShare = Math.min(totalH * 0.32, headerRows * 8)
  const headerRowH = headerRows > 0 ? headerShare / headerRows : 0
  const bodyH = Math.max(4, (totalH - headerShare) / bodyCount)
  const out: number[] = []
  for (let r = 0; r < grid.rowCount; r++) out.push(r < headerRows ? headerRowH : bodyH)
  return out
}

/** 列宽缩放到控件总宽（mm）。width 未设时用原始列宽 */
function designColWidths(control: TableControl): number[] {
  const cols = control.columns ?? []
  const raw = cols.map((c) => c.width ?? 30)
  const sum = raw.reduce((a, b) => a + b, 0) || 1
  const total = control.width ?? 0
  const scale = total > 0 && sum > 0 ? total / sum : 1
  return raw.map((w) => w * scale)
}

/** 字符级换行估算：CJK ≈ 1em，ASCII ≈ 0.6em（与测试测量器同规则）。保守余量 0.3mm */
function ceilCharLines(text: string, widthMm: number): number {
  const em = ptToMm(_TABLE_FONT_SIZE_PT)
  let w = 0
  let lines = 1
  for (const ch of text) {
    const cw = /[\x00-\xff]/.test(ch) ? em * 0.6 : em
    if (w + cw > widthMm - 0.3) {
      lines++
      w = cw
    } else {
      w += cw
    }
  }
  return lines
}

/** 单行设计期行高的内容估算：静态文本按列宽换行；绑定/聚合 token 画布 nowrap 单行 */
function designRowContentHeight(row: TableCell[], colWidths: number[]): number {
  let lines = 1
  for (let c = 0; c < row.length; c++) {
    const cell = row[c]
    if (!cell) continue
    if (cell.field || cell.expression || isAggToken(cell.text)) continue // nowrap 单行
    const text = cell.text ?? ''
    if (!text) continue
    const avail = Math.max(1, (colWidths[c] ?? 0) - 2 * _CELL_PADDING_X)
    lines = Math.max(lines, ceilCharLines(text, avail))
  }
  return lines * ptToMm(_TABLE_FONT_SIZE_PT) * _LINE_HEIGHT_FACTOR + 2 * _CELL_PADDING_Y
}

/**
 * 数据表控件高度同步：让 `control.height` = 所有行高之和（含表头 + 数据样例行 + 静态尾行），
 * 使得画布包围盒与实际渲染尺寸一致。布局网格不受影响（画布 = 打印）。
 *
 * 设计表增删行、改行高模式、改固定行高后都应调用此函数，避免画布包围盒与渲染尺寸脱节。
 */
export function syncDataTableHeight(control: TableControl): TableControl {
  if (!isDataTable(control)) return control
  const heights = designRowHeights(control)
  const totalH = heights.reduce((s, h) => s + h, 0)
  if (Math.abs((control.height ?? 0) - totalH) < 0.01) return control
  return { ...control, height: totalH }
}

/** 把任意 cells 矩阵归一化为 rowCount × colCount（不足补空、超出截断） */
export function normalizeCellRows(
  cells: TableCell[][],
  rowCount: number,
  colCount: number,
): TableCell[][] {
  const out: TableCell[][] = []
  for (let r = 0; r < rowCount; r++) {
    const src = cells[r] ?? []
    const row: TableCell[] = []
    for (let c = 0; c < colCount; c++) {
      row.push(src[c] ? { ...src[c] } : {})
    }
    out.push(row)
  }
  return out
}

/** 给定可视行号，返回其语义（表头 / 数据样例行 / 静态尾行） */
export function designRowInfo(grid: DesignGrid, r: number): DesignRowInfo {
  if (!grid.isData) {
    return { kind: r < grid.headerRows ? 'header' : 'static', cellRow: r, isDataTemplate: false }
  }
  if (r < grid.headerRows) return { kind: 'header', cellRow: r, isDataTemplate: false }
  if (r === grid.headerRows) return { kind: 'data', cellRow: r, isDataTemplate: true }
  return { kind: 'static', cellRow: r, isDataTemplate: false }
}

/**
 * 设计期行角色名（双击编辑时显示在首列左侧，帮助用户识别当前所在行）。
 * 聚合尾行按单元格 token 判定：大写金额 / 总计 / 本页合计。
 */
export function rowRoleLabel(grid: DesignGrid, r: number): string {
  const info = designRowInfo(grid, r)
  if (info.kind === 'header') return grid.headerRows > 1 ? `标题行 ${r + 1}` : '标题行'
  if (info.isDataTemplate) return '数据行'
  const row = grid.cells[r] ?? []
  const tokens = row.map((c) => parseAggToken(c.text))
  if (tokens.some((t) => t === 'pageCap' || t === 'totalCap')) return '大写金额行'
  if (tokens.some((t) => t === 'totalSum' || t === 'totalAvg' || t === 'totalCount')) return '总计行'
  if (tokens.some((t) => t === 'pageSum' || t === 'pageAvg' || t === 'pageCount')) return '本页合计行'
  // 其余非表头、非聚合 token 的行（数据样例行 / 备注 / 签字栏等）统一叫"数据行"
  return '数据行'
}

/**
 * 物化 cells 到控件（首次双击编辑或列数变化时调用）。
 * 返回带完整 cells 的新控件；若已存在且长度匹配则原样返回。
 */
export function ensureCells(control: TableControl): TableControl {
  const grid = buildDesignGrid(control)
  const headerRows = grid.headerRows
  const staticRows = grid.staticRows
  const designRows = grid.designRows
  const existing = control.cells
  const matches =
    existing &&
    existing.length === grid.rowCount &&
    existing.every((row) => row.length === grid.colCount)
  if (matches) {
    return { ...control, headerRows, staticRows, designRows }
  }
  return {
    ...control,
    headerRows,
    staticRows,
    designRows,
    cells: grid.cells,
  }
}

/** 浅合并单元格样式：later 覆盖 former 的已定义字段 */
export function mergeCellStyle(...parts: Array<TableCellStyle | undefined>): TableCellStyle {
  const out: TableCellStyle = {}
  for (const p of parts) {
    if (!p) continue
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

/** 取某单元格最终样式（表格默认 → 列样式 → 单元格样式） */
export function resolveCellStyle(
  control: TableControl,
  column: TableColumn | undefined,
  cell: TableCell | undefined,
): TableCellStyle {
  return mergeCellStyle(control.options?.defaultCellStyle, column?.style, cell?.style)
}

/**
 * 按行语义取单元格最终样式。
 * 表头行**不吃 `column.style`** —— 列样式是给数据单元格用的，套到表头上会让
 * "把某列数据调成红色"顺带把标题也染红，与直觉相悖。设计期与运行期共用本函数。
 */
export function resolveCellStyleFor(
  control: TableControl,
  column: TableColumn | undefined,
  cell: TableCell | undefined,
  kind: DesignRowKind,
): TableCellStyle {
  return resolveCellStyle(control, kind === 'header' ? undefined : column, cell)
}

/** 不可变更新某单元格（合并 patch），返回新控件 */
export function patchCell(
  control: TableControl,
  r: number,
  c: number,
  patch: Partial<TableCell>,
): TableControl {
  const grid = buildDesignGrid(control)
  const next = grid.cells.map((row, ri) =>
    ri === r ? row.map((cell, ci) => (ci === c ? { ...cell, ...patch } : cell)) : row,
  )
  return {
    ...control,
    cells: next,
    headerRows: grid.headerRows,
    staticRows: grid.staticRows,
    designRows: grid.designRows,
  }
}

/* ----------------------------- 网格结构变更 ----------------------------- */

/**
 * 设定表格的语义行数并物化 cells（保留已有内容，按需补空 / 截断）。
 * 同时回写 headerRows / designRows / staticRows 元数据，使与设计期网格 1:1 对齐。
 *
 * 参数按控件类型生效：
 * - 布局网格（无 dataSource）：designRows = 正文行数；staticRows 恒为 0。
 * - 数据表：固定 1 行数据样例行（模板），staticRows = 静态尾行（备注 / 签字栏）。
 * 未传的维度沿用当前值，便于只改某一维。
 *
 * ⚠️ 不能走 ensureCells：它按"cells 长度优先推导 designRows"，会无视显式 designRows。
 * 这里以"目标维度"为准直接归一 cells。
 */
export function setGridRows(
  control: TableControl,
  rows: { headerRows?: number; designRows?: number; staticRows?: number },
): TableControl {
  const headerRows = Math.max(0, rows.headerRows ?? headerRowsOf(control))
  const isData = isDataTable(control)
  const staticRows = isData ? Math.max(0, rows.staticRows ?? staticRowsOf(control)) : 0
  const designRows = isData ? 0 : Math.max(0, rows.designRows ?? layoutBodyRows(control, headerRows))
  const colCount = Math.max(1, control.columns?.length ?? 0)
  const rowCount = headerRows + (isData ? 1 : designRows) + staticRows

  // 已有 cells → 按目标维度直接归一（保留内容）；无 cells → 先按新语义推导再取
  const base =
    control.cells && control.cells.length > 0
      ? control.cells
      : buildDesignGrid({ ...control, headerRows, designRows, staticRows }).cells
  const cells = normalizeCellRows(base, rowCount, colCount)
  return { ...control, headerRows, designRows, staticRows, cells }
}

/** 在列尾追加一列（并同步扩展每行的单元格）；返回新控件 */
export function addTableColumn(control: TableControl, col?: Partial<TableColumn>): TableControl {
  const idx = control.columns?.length ?? 0
  const newCol: TableColumn = {
    title: col?.title ?? `列${idx + 1}`,
    field: col?.field,
    expression: col?.expression,
    width: col?.width ?? 30,
    align: col?.align,
    headerAlign: col?.headerAlign,
    cellBackgroundColor: col?.cellBackgroundColor,
    headerBackgroundColor: col?.headerBackgroundColor,
    cellPadding: col?.cellPadding,
    style: col?.style,
  }
  const grid = buildDesignGrid(control) // 当前规范矩阵
  const cells = grid.cells.map((row, r) => {
    const row2 = [...row, {}]
    // 新列表头单元格默认填入列标题（与设计期"列标题推导表头"一致）
    if (r < grid.headerRows && newCol.title) row2[row2.length - 1] = { text: newCol.title }
    return row2
  })
  return {
    ...control,
    columns: [...(control.columns ?? []), newCol],
    cells,
    headerRows: grid.headerRows,
    staticRows: grid.staticRows,
    designRows: grid.designRows,
  }
}

/** 删除指定列（并同步裁剪每行的对应单元格）；至少保留 1 列 */
export function removeTableColumn(control: TableControl, index: number): TableControl {
  const cols = control.columns ?? []
  if (cols.length <= 1 || index < 0 || index >= cols.length) return control
  const grid = buildDesignGrid(control) // 当前规范矩阵
  const cells = grid.cells.map((row) => row.filter((_, i) => i !== index))
  return {
    ...control,
    columns: cols.filter((_, i) => i !== index),
    cells,
    headerRows: grid.headerRows,
    staticRows: grid.staticRows,
    designRows: grid.designRows,
  }
}

/** 删除指定行（同步裁剪该行单元格）；至少保留 1 行 */
export function removeTableRow(control: TableControl, index: number): TableControl {
  const grid = buildDesignGrid(control)
  if (index < 0 || index >= grid.rowCount || grid.rowCount <= 1) return control
  // 数据表的"数据样例行"（唯一 body 行）不可删除，否则破坏逐行渲染模型
  if (grid.isData && index === grid.headerRows) return control
  const cells = grid.cells.filter((_, r) => r !== index)
  let { headerRows, staticRows, designRows } = grid
  if (index < headerRows) headerRows -= 1
  else if (grid.isData) staticRows = Math.max(0, staticRows - 1)
  else designRows = Math.max(0, designRows - 1)
  return { ...control, headerRows, staticRows, designRows, cells }
}

/** 列左右移动（上移 / 下移到相邻位置）；同时搬动每行的对应单元格 */
export function moveTableColumn(control: TableControl, from: number, to: number): TableControl {
  const cols = control.columns ?? []
  if (from < 0 || from >= cols.length || to < 0 || to >= cols.length || from === to) return control
  const grid = buildDesignGrid(control) // 当前规范矩阵
  const cells = grid.cells.map((row) => {
    const r = [...row]
    const [cell] = r.splice(from, 1)
    r.splice(to, 0, cell!)
    return r
  })
  const movedCols = [...cols]
  const [col] = movedCols.splice(from, 1)
  movedCols.splice(to, 0, col!)
  return {
    ...control,
    columns: movedCols,
    cells,
    headerRows: grid.headerRows,
    staticRows: grid.staticRows,
    designRows: grid.designRows,
  }
}

/**
 * 单元格文本写回（把"用户在 DOM 里敲的字"翻译成协议语义）：
 * - 表头 / 静态行：写 `text`（纯字面量）
 * - 数据样例行：写 `expression`（模板串——含 `{{}}` 则运行期插值，纯文字则原样输出），
 *   并清空 `field`，避免 field/expression 双写时语义打架
 *
 * 若文本与"当前占位符"完全一致，视为未改动，直接返回原控件（避免把占位符固化成表达式）。
 */
export function patchCellText(
  control: TableControl,
  r: number,
  c: number,
  raw: string,
): TableControl {
  const grid = buildDesignGrid(control)
  const info = designRowInfo(grid, r)
  const text = raw.replace(/\u00a0/g, ' ').trim()
  const cell = grid.cells[r]?.[c] ?? {}
  const col = control.columns[c]

  if (info.isDataTemplate) {
    // 占位符显示与 table-design-render 的 fieldPlaceholder 严格对齐，确保"未改动即不写回"
    const fieldPh = (f: string): string => (f.includes('[]') ? `{{${f}}}` : `{{item.${f}}}`)
    const current = cell.expression
      ?? (cell.field ? fieldPh(cell.field) : col?.field ? fieldPh(col.field) : '')
    if (text === current) return control
    if (!text) return patchCell(control, r, c, { expression: undefined, field: undefined })
    // "{{item.xxx}}" 单一普通字段引用 → 回写为 field，保持模型最简
    const single = /^\{\{\s*item\.([A-Za-z0-9_$.]+)\s*\}\}$/.exec(text)
    if (single) return patchCell(control, r, c, { field: single[1], expression: undefined })
    // "{{items[].xxx}}" 含数组标记的单一字段引用 → 同样回写为 field（运行期 resolveBinding 会去前缀取值）
    const singleArr = /^\{\{\s*([A-Za-z0-9_$\u4e00-\u9fa5][A-Za-z0-9_$\u4e00-\u9fa5.\[\]]*\[\]\.[A-Za-z0-9_$\u4e00-\u9fa5.\[\]]*)\s*\}\}$/.exec(text)
    if (singleArr) return patchCell(control, r, c, { field: singleArr[1], expression: undefined })
    return patchCell(control, r, c, { expression: text, field: undefined })
  }

  if ((cell.text ?? '') === text) return control
  return patchCell(control, r, c, { text })
}

/** 不可变合并某单元格样式（只覆盖传入的键，undefined 表示"清除该项"） */
export function patchCellStyle(
  control: TableControl,
  r: number,
  c: number,
  style: TableCellStyle,
): TableControl {
  const grid = buildDesignGrid(control)
  const current = grid.cells[r]?.[c]?.style ?? {}
  const merged: TableCellStyle = { ...current }
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k]
    else (merged as Record<string, unknown>)[k] = v
  }
  return patchCell(control, r, c, { style: merged })
}

/**
 * 设置单元格横向合并跨度。
 * 合并 = 本格 colSpan=n，被吞掉的右侧格清空（渲染时按 span 跳过，模型仍留位保证矩阵规整）。
 */
export function setCellSpan(control: TableControl, r: number, c: number, span: number): TableControl {
  const grid = buildDesignGrid(control)
  const max = grid.colCount - c
  const n = Math.max(1, Math.min(Math.floor(span), max))
  let next = patchCell(control, r, c, { colSpan: n > 1 ? n : undefined })
  for (let i = 1; i < n; i++) {
    next = patchCell(next, r, c + i, { text: undefined, field: undefined, expression: undefined, colSpan: undefined })
  }
  return next
}

/**
 * 设置单元格纵向合并跨度。
 * 合并 = 本格 rowSpan=m，被吞掉的下方同列格清空（渲染时按 span 跳过，模型仍留位保持矩阵规整）。
 * 超界自动收敛到网格底边，故改行数 / 删行不会产生非法合并。
 */
export function setCellRowSpan(control: TableControl, r: number, c: number, span: number): TableControl {
  const grid = buildDesignGrid(control)
  const max = grid.rowCount - r
  const n = Math.max(1, Math.min(Math.floor(span), max))
  let next = patchCell(control, r, c, { rowSpan: n > 1 ? n : undefined })
  for (let k = 1; k < n; k++) {
    next = patchCell(next, r + k, c, {
      text: undefined,
      field: undefined,
      expression: undefined,
      colSpan: undefined,
      rowSpan: undefined,
    })
  }
  return next
}

/**
 * 统一计算整张网格的合并布局（colSpan + rowSpan 一起算），供设计 overlay 与运行期引擎共用。
 *
 * 规则：
 * - 跨列：本格 colSpan=n → 同行右侧 n-1 格被跳过（同一行内）。
 * - 跨行：本格 rowSpan=m → 下方 m-1 行同列（及所跨各列）被跳过。
 * - 两种跨度可同时作用于同一锚点格（形成 2×N / N×2 / N×M 的合并块）。
 * - 所有跨度超界自动收敛到网格边界，因此改行数 / 删列 / 移动列都不会产生非法合并或丢列。
 *
 * 返回与 cells 同形的矩阵：skip=true 的格由相邻锚点合并，渲染端据此决定"是否输出该 td"。
 */
export function computeSpanLayout(
  cells: TableCell[][],
  rowCount: number,
  colCount: number,
): CellSpan[][] {
  const out: CellSpan[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => ({ skip: false, colSpan: 1, rowSpan: 1 }) as CellSpan),
  )
  // carry[c] = 进入当前行时，第 c 列仍被上方某个 rowspan 占用的剩余行数（>0 表示该格需跳过）
  const carry = new Array<number>(colCount).fill(0)
  for (let r = 0; r < rowCount; r++) {
    const curCarry = carry.slice()
    const nextCarry = carry.map((v) => Math.max(0, v - 1))
    let c = 0
    while (c < colCount) {
      if (curCarry[c]! > 0) {
        out[r]![c]!.skip = true
        c++
        continue
      }
      const cell = cells[r]?.[c] ?? {}
      const cs = Math.max(1, Math.min(Math.floor(cell.colSpan ?? 1), colCount - c))
      const rs = Math.max(1, Math.min(Math.floor(cell.rowSpan ?? 1), rowCount - r))
      out[r]![c]!.colSpan = cs
      out[r]![c]!.rowSpan = rs
      if (cs > 1) {
        // 同一行被横向吞掉的格，标记 skip（矩阵自我完备：skip=true 即"不作为独立 td 输出"）
        for (let k = 1; k < cs; k++) out[r]![c + k]!.skip = true
      }
      if (rs > 1) {
        // 被跨的每一列在后续行都被占用（含跨列覆盖到的列）
        for (let k = 0; k < cs; k++) nextCarry[c + k] = Math.max(nextCarry[c + k]!, rs - 1)
      }
      c += cs
    }
    carry.length = 0
    carry.push(...nextCarry)
  }
  return out
}

/** 不可变更新某列（数据表数据样例行编辑 = 编辑整列） */
export function patchColumnStyle(
  control: TableControl,
  c: number,
  style: TableCellStyle,
): TableControl {
  const cols = control.columns.map((col, ci) =>
    ci === c ? { ...col, style: { ...(col.style ?? {}), ...style } } : col,
  )
  return { ...control, columns: cols }
}

/* ----------------------------- 行 / 列插入 ----------------------------- */

/**
 * 在 `atRow` 处插入一空行（原行下移）。
 * - 布局网格：直接插入正文区，designRows+1。
 * - 数据表：数据样例行固定在 headerRows，任何插入都落在静态尾行区（避免破坏"单数据样例行"不变量），
 *   故 atRow 被收敛到 headerRows+1 之后；staticRows+1。
 */
export function insertTableRow(control: TableControl, atRow: number): TableControl {
  const grid = buildDesignGrid(control)
  const colCount = grid.colCount
  const cells = grid.cells.map((row) => row.map((c) => ({ ...c })))
  const newRow: TableCell[] = Array.from({ length: colCount }, () => ({}))
  let insertAt = atRow
  let headerRows = grid.headerRows
  let designRows = grid.designRows
  let staticRows = grid.staticRows
  if (grid.isData) {
    const minStatic = grid.headerRows + 1
    insertAt = Math.max(minStatic, atRow)
    staticRows += 1
  } else {
    designRows += 1
  }
  cells.splice(insertAt, 0, newRow)
  return { ...control, headerRows, designRows, staticRows, cells }
}

/** 在 `atCol` 处插入一空列（原列右移），同步扩展表头与每行的单元格 */
export function insertTableColumn(control: TableControl, atCol: number): TableControl {
  const grid = buildDesignGrid(control)
  const cells = grid.cells.map((row) => {
    const r = [...row]
    r.splice(atCol, 0, {})
    return r
  })
  const idx = (control.columns?.length ?? 0) + 1
  const newCol: TableColumn = {
    title: `列${idx}`,
    width: 30,
    align: 'left',
    headerAlign: 'center',
  }
  const cols = [...(control.columns ?? [])]
  cols.splice(atCol, 0, newCol)
  return {
    ...control,
    columns: cols,
    cells,
    headerRows: grid.headerRows,
    staticRows: grid.staticRows,
    designRows: grid.designRows,
  }
}

/* ----------------------------- 默认尾行结构 ----------------------------- */

export interface SeedTailOptions {
  /** 参与合计（数值）的列索引；不传则从数据首行采样 / 列 aggregate 标记推断 */
  numericColumns?: number[]
  /** 大写金额取哪列的总计（主金额列索引）；不传取最后一个数值列 */
  moneyColumn?: number
  /** 是否植入"大写金额"行（默认 true）。初始化默认表格可传 false，只留本页合计 + 总计两行 */
  capital?: boolean
}

/**
 * 植入"本页合计 / 总计 / 大写金额"三行尾结构（学习金蝶等 ERP 单据设计）：
 * - 数值列（数量 / 单价 / 金额…）尾格写入聚合 token：本页合计=`{{#pageSum}}`、总计=`{{#totalSum}}`、大写金额=`{{#totalCap}}`；
 * - 第一列写入行名标签（本页合计 / 总计 / 大写金额），让用户一眼识别；
 * - 非数值列（名称 / 备注等字符串）尾格留空，不参与计算；
 * - 数值列自动标记 `aggregate:true`，参与尾行聚合。
 *
 * 幂等：若已存在任意聚合 token 尾行则不重复植入。
 */
export function seedSummaryTail(control: TableControl, opts: SeedTailOptions = {}): TableControl {
  const grid = buildDesignGrid(control)
  // 已植入尾行则不重复：识别聚合 token 或首列的尾行标签（单列表格 token 落在首列，故需同时识别标签）
  const tailLabels = new Set(['本页合计', '总计', '大写金额'])
  const seeded = grid.cells.slice(grid.headerRows + 1).some(
    (row) =>
      row.some((c) => isAggToken(c.text)) ||
      (row[0] != null && tailLabels.has(row[0]!.text ?? '')),
  )
  if (seeded) return control
  const cols = control.columns ?? []
  const colCount = grid.colCount

  // 数值列判定
  const numeric = new Set<number>(opts.numericColumns ?? [])
  if (opts.numericColumns === undefined) {
    const sample = Array.isArray(control.data) && control.data.length ? (control.data[0] as Record<string, unknown>) : undefined
    cols.forEach((c, i) => {
      const key = stripItems(c.field)
      if (c.aggregate === true || c.aggregate === 'sum' || c.aggregate === 'avg' || c.aggregate === 'count') {
        numeric.add(i)
      } else if (key && sample && typeof sample[key] === 'number') {
        numeric.add(i)
      }
    })
  }
  const money = opts.moneyColumn ?? [...numeric].sort((a, b) => b - a)[0] ?? -1

  const makeRow = (label: string, token: string | null): TableCell[] =>
    Array.from({ length: colCount }, (_, c) => {
      if (c === 0) return { text: label, style: { bold: true, align: 'center' } }
      if (token && numeric.has(c)) return { text: token, style: { bold: true, align: 'center' } }
      return {}
    })
  const pageRow = makeRow('本页合计', '{{#pageSum}}')
  const totalRow = makeRow('总计', '{{#totalSum}}')
  const withCap = opts.capital ?? true
  const capRow: TableCell[] = Array.from({ length: colCount }, (_, c) => {
    if (c === 0) return { text: '大写金额', style: { bold: true, align: 'center' } }
    if (c === money) return { text: '{{#totalCap}}', style: { bold: true, align: 'center' } }
    return {}
  })

  // 数值列标记 aggregate:true
  const newCols = cols.map((c, i) => (numeric.has(i) ? { ...c, aggregate: true as const } : c))

  const tailRows = withCap ? [pageRow, totalRow, capRow] : [pageRow, totalRow]
  const cells = [...grid.cells, ...tailRows]
  return {
    ...control,
    columns: newCols,
    cells,
    headerRows: grid.headerRows,
    staticRows: grid.staticRows + tailRows.length,
    designRows: grid.designRows,
  }
}
