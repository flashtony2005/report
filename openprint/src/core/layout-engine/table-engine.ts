/**
 * TableEngine —— 动态表格建模与切片分页
 * 真理源：《OpenPrint-设计方案.md》§5.4（表格统一设计）、§7.4（难点清单）
 *
 * 覆盖 §7.4 难点：
 * | 难点 | 实现位置 |
 * |---|---|
 * | 动态表格分页 / 表头重复 | sliceTable() 的 repeatHeader 分支 |
 * | 每页行数控制 pageRows | sliceTable() 的 forcedRows |
 * | 行内文本测量 rowHeightMode:'auto' | measureRowHeight() |
 * | keepTogether 起始不足整体下移 | minStartHeight()（由 pagination-engine 调用） |
 * | 合计/表尾 repeatFooter | sliceTable() 的 footer 预算 |
 * | 空行 / 空表 skipEmptyRows | buildTableModel() |
 * | 多单合并 mergeSheets | resolveRows() |
 *
 * 分两步：**建模**（一次性算完所有行与高度）→ **切片**（按页可用高度取行）。
 * 这样分页只是纯几何切割，不再触碰数据语义，逻辑可测且不会走样。
 *
 * ## 内容真理源 = 设计期单元格网格（方案 A）
 *
 * 建模不再直接读列配置，而是统一经 `buildDesignGrid(control)`：
 * 表头行、数据样例行（模板）、静态尾行都来自同一份 `cells` 网格 —— 设计画布画的是它、
 * 打印吃的也是它，字体/颜色/对齐/合并因此天然一致（真·所见即所得）。
 * 未设置 `cells` 的老模板由 `buildDesignGrid` 从列配置瞬时推导，行为与旧版逐字节等价。
 */
import type { HAlign, TableCell, TableCellStyle, TableColumn, TableControl } from '@/types/control'
import { FILTERS, interpolate, resolveBinding, stringifyValue, formatCellValue } from './expression'
import {
  aggValueForRows,
  columnAggregatable,
  formatAggNumber,
  isAggToken,
  parseAggToken,
  stripItems,
  toChineseCapitalRMB,
  type FooterKind,
} from './aggregate'
import {
  buildDesignGrid,
  computeSpanLayout,
  designRowHeights,
  isDataTable,
  resolveCellStyleFor,
  type CellSpan,
  type DesignRowKind,
} from './table-cells'
import {
  buildSummaryPlan,
  isEmptyRow,
  planRows,
  readField,
  summaryLabel,
  type RowPlan,
} from './group-engine'
import type { TextMeasurer } from './measure'
import type { EvalContext, RenderCell, RenderRow, RenderWarning } from './types'

/* ------------------------------- 排版常数 ------------------------------- */

/** 表格文字字号（pt）—— 与设计画布 PrintTable 的 9pt 保持一致，确保"所见即所得" */
export const TABLE_FONT_SIZE = 9
/**
 * 单元格水平内边距（mm）。
 * 说明：协议注释写的默认 4mm 若同时用作垂直内边距会让行高凭空多出 8mm，
 * 对 ERP 密集表格不可用；这里把 cellPadding 解释为**水平内缩**（业界报表工具通用语义），
 * 垂直方向由 CELL_PADDING_Y 单独控制。
 */
export const DEFAULT_CELL_PADDING = 2
/** 单元格垂直内边距（mm，上下各一份） */
export const CELL_PADDING_Y = 1.2
/** 最小行高（mm），防止空行被压成一条线 */
export const MIN_ROW_HEIGHT = 6
/** 表头行相对数据行的高度系数 */
export const HEADER_ROW_FACTOR = 1

/* -------------------------------- 模型 -------------------------------- */

export interface TableModel {
  control: TableControl
  columns: TableColumn[]
  /** 归一化后的各列实际宽度（mm，合计 = 控件宽度） */
  columnWidths: number[]
  /** 表头行（支持多行；无表头时为空数组） */
  headerRows: RenderRow[]
  /** 数据 + 组头 + 小计行（按打印顺序） */
  rows: RenderRow[]
  /** 表尾块：聚合尾行（本页合计/总计/大写金额）+ 设计期静态尾行（备注 / 签字栏） */
  footerRows: RenderRow[]
  /** 解析后的全表数据行（供切片期重算合计；尾行聚合的真理源） */
  dataRows: Array<Record<string, unknown>>
  warnings: RenderWarning[]
  /** 是否为布局网格（无 dataSource 的空白表格，§5.4） */
  isLayoutGrid: boolean
}

/** 行高累加（表头 / 表尾块） */
export function sumRowHeights(rows: RenderRow[]): number {
  return rows.reduce((s, r) => s + r.height, 0)
}

/* ------------------------------ 数据行解析 ------------------------------ */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/**
 * 取出表格的数据行。
 * mergeSheets（§9.2.1a 多单合并）：dataSource 解析出的若干数组会被**扁平拼接**成一条连续行流，
 * 使多张单据一次连续打印，而不是各自起新页。
 */
function embeddedRows(control: TableControl): Array<Record<string, unknown>> {
  if (Array.isArray(control.data) && control.data.length > 0) {
    const out: Array<Record<string, unknown>> = []
    for (const item of control.data) {
      const rec = asRecord(item)
      if (rec) out.push(rec)
    }
    return out
  }
  return []
}

function resolveRows(
  control: TableControl,
  ctx: EvalContext,
  warnings: RenderWarning[],
): Array<Record<string, unknown>> {
  const path = control.dataSource?.trim()
  if (path) {
    const raw = resolveBinding(path, ctx)
    const embedded = embeddedRows(control)
    if (raw === null || raw === undefined) {
      // dataSource 缺失：有内嵌 data 则回退（模板示例/导入场景），否则告警
      if (embedded.length) return embedded
      warnings.push({
        code: 'DATASOURCE_EMPTY',
        message: `表格数据源 "${path}" 在数据中不存在`,
        controlId: control.id,
      })
      return []
    }

    if (!Array.isArray(raw)) {
      if (embedded.length) return embedded
      warnings.push({
        code: 'DATASOURCE_NOT_ARRAY',
        message: `表格数据源 "${path}" 不是数组（实际为 ${typeof raw}）`,
        controlId: control.id,
      })
      return []
    }

    const merge = control.options?.mergeSheets ?? false
    const out: Array<Record<string, unknown>> = []
    for (const item of raw) {
      if (Array.isArray(item)) {
        // 多单合并：嵌套数组扁平化；未开启合并时忽略嵌套数组（避免打出乱序内容）
        if (merge) {
          for (const sub of item) {
            const rec = asRecord(sub)
            if (rec) out.push(rec)
          }
        }
        continue
      }
      const rec = asRecord(item)
      if (rec) out.push(rec)
    }

    if (out.length === 0) {
      // dataSource 为空数组：有内嵌 data 则回退
      if (embedded.length) return embedded
      warnings.push({
        code: 'DATASOURCE_EMPTY',
        message: `表格数据源 "${path}" 为空数组`,
        controlId: control.id,
      })
    }
    return out
  }

  // 表格自带内嵌数据（导入数据场景）：与 dataSource 字段解耦，直接作为数据行
  return embeddedRows(control)
}

/* ------------------------------- 列宽归一化 ------------------------------ */

/** 把列的相对宽度按控件实际宽度等比归一，保证列宽之和 === 表格宽度 */
export function normalizeColumnWidths(columns: TableColumn[], totalWidth: number): number[] {
  const sum = columns.reduce((s, c) => s + (c.width > 0 ? c.width : 0), 0)
  if (sum <= 0) {
    const even = totalWidth / Math.max(1, columns.length)
    return columns.map(() => even)
  }
  return columns.map((c) => ((c.width > 0 ? c.width : 0) / sum) * totalWidth)
}

/* ------------------------------- 单元格取值 ------------------------------ */

function interp(src: string, ctx: EvalContext, errors: string[]): string {
  const r = interpolate(src, ctx)
  errors.push(...r.errors)
  return r.text
}

/**
 * 单元格内容模式（显式 contentType；老模板按 expression > field > text 启发式回退，
 * 与文本控件 resolveTextValue 的回退语义一致）。
 */
function cellTextMode(cell: TableCell): 'fixed' | 'variable' | 'expression' {
  if (cell.contentType) return cell.contentType
  return cell.expression ? 'expression' : cell.field ? 'variable' : 'fixed'
}

/**
 * 数据行单元格取值。优先级：单元格 expression > 单元格 field > 单元格固定文字 > 列 expression > 列 field。
 * （单元格未设置任何内容时回落到列配置，既兼容老模板，也让"新增列"立刻可用。）
 */
function dataCellText(
  cell: TableCell,
  col: TableColumn | undefined,
  ctx: EvalContext,
  errors: string[],
): string {
  const mode = cellTextMode(cell)
  // 显式模式且字段非空：按模式取值；字段为空则回落老链路（列配置兜底，保证显式 variable 空路径不打断整列）
  if (mode === 'expression' && cell.expression) return interp(cell.expression, ctx, errors)
  if (mode === 'variable' && cell.field) {
    return formatCellValue(resolveBinding(cell.field, ctx), cell.format ?? col?.format)
  }
  if (mode === 'fixed' && cell.text !== undefined) return interp(cell.text, ctx, errors)
  // 老模板 / 显式模式字段为空：expression > field > text > 列 expression > 列 field
  if (cell.expression) return interp(cell.expression, ctx, errors)
  if (cell.field) return formatCellValue(resolveBinding(cell.field, ctx), cell.format ?? col?.format)
  if (cell.text !== undefined) return interp(cell.text, ctx, errors)
  if (col?.expression) return interp(col.expression, ctx, errors)
  if (col?.field) return formatCellValue(resolveBinding(col.field, ctx), col?.format)
  return ''
}

/**
 * 表头 / 静态行取值。优先级与数据行对齐：单元格 expression > 单元格 field > 单元格字面量 > 列 field。
 * - 支持 {{}} 插值（如"合计：{{order.total}}"、"第 {{page}} 页"）；
 * - 也支持字段绑定（order.no）：经 resolveBinding 解析主表标量字段；
 * - 无任何标记的字面量文字原样输出（即"普通文本"约定）。
 */
function staticCellText(
  cell: TableCell,
  col: TableColumn | undefined,
  fallback: string,
  ctx: EvalContext,
  errors: string[],
): string {
  const mode = cellTextMode(cell)
  // 显式模式且字段非空：按模式取值；字段为空则回落老链路
  if (mode === 'expression' && cell.expression) return interp(cell.expression, ctx, errors)
  if (mode === 'variable' && cell.field) {
    return formatCellValue(resolveBinding(cell.field, ctx), cell.format ?? col?.format)
  }
  if (mode === 'fixed' && cell.text !== undefined) return interp(cell.text, ctx, errors)
  // 老模板 / 显式模式字段为空：expression > field > text > 列 field > fallback
  if (cell.expression) return interp(cell.expression, ctx, errors)
  if (cell.field) return formatCellValue(resolveBinding(cell.field, ctx), cell.format ?? col?.format)
  if (cell.text !== undefined) return interp(cell.text, ctx, errors)
  if (col?.field) return formatCellValue(resolveBinding(col.field, ctx), col?.format)
  if (!fallback) return ''
  return interp(fallback, ctx, errors)
}

/** 聚合值显示：整数不带小数，小数保留两位，统一加千分位 */
function formatAggregate(v: number): string {
  return Number.isInteger(v) ? FILTERS.number!(v, 0) : FILTERS.number!(v, 2)
}

/* ---------------------------- 单元格 → 渲染单元格 --------------------------- */

/** 与 cells[] 一一对应的几何（含 colSpan 合并后的宽度），供行高测量使用 */
interface RowGeometry {
  widths: number[]
  pads: number[]
}

interface BuiltRow {
  cells: RenderCell[]
  geo: RowGeometry
}

/**
 * 把设计期样式盖到渲染单元格上（只覆盖显式设置过的项，未设置的保留 kind 默认值）。
 * 若传入 ctx，则 backgroundColor 与 color 支持 {{}} 表达式插值（可根据行/全局数据动态算色）。
 */
function applyCellStyle(
  base: RenderCell,
  control: TableControl,
  col: TableColumn | undefined,
  cell: TableCell,
  kind: DesignRowKind,
  ctx?: EvalContext,
  errors?: string[],
): RenderCell {
  const s = resolveCellStyleFor(control, col, cell, kind)
  const out: RenderCell = { ...base }
  if (s.align) out.align = s.align
  if (s.backgroundColor) out.background = s.backgroundColor
  if (s.bold !== undefined) out.bold = s.bold
  if (s.fontSize !== undefined) out.fontSize = s.fontSize
  if (s.fontFamily) out.fontFamily = s.fontFamily
  if (s.italic !== undefined) out.italic = s.italic
  if (s.underline !== undefined) out.underline = s.underline
  if (s.color) out.color = s.color
  if (s.valign) out.valign = s.valign
  if (s.diagonal) out.diagonal = s.diagonal
  // 动态颜色：支持 {{}} 表达式插值（无 {{ 时等同于原值）
  if (ctx) {
    const errs = errors ?? []
    if (out.background) out.background = interp(out.background, ctx, errs)
    if (out.color) out.color = interp(out.color, ctx, errs)
  }
  return out
}

/**
 * 摊平一行设计期单元格：处理 colSpan / rowSpan（合并宽度、跳过被吞掉的格），
 * 同时产出与渲染单元格对齐的宽度 / 内边距数组，让行高测量吃到真实可用宽度。
 *
 * @param spanRow 本行各列的合并布局（computeSpanLayout 已算好）：skip=true 的格被上方/左侧
 *   合并吞掉，这里直接跳过；colSpan/rowSpan 作为本格的有效跨度。
 */
function layoutDesignRow(
  rowCells: TableCell[],
  spanRow: CellSpan[],
  columns: TableColumn[],
  columnWidths: number[],
  colCount: number,
  make: (cell: TableCell, col: TableColumn | undefined, colIndex: number) => RenderCell,
): BuiltRow {
  const cells: RenderCell[] = []
  const widths: number[] = []
  const pads: number[] = []
  let c = 0
  while (c < colCount) {
    if (spanRow[c]?.skip) {
      c++
      continue
    }
    const cell = rowCells[c] ?? {}
    const span = Math.max(1, spanRow[c]!.colSpan)
    const col = columns[c]
    let w = 0
    for (let k = 0; k < span; k++) w += columnWidths[c + k] ?? 0
    const rc = make(cell, col, c)
    if (span > 1) rc.colSpan = span
    if (spanRow[c]!.rowSpan > 1) rc.rowSpan = spanRow[c]!.rowSpan
    cells.push(rc)
    widths.push(w)
    pads.push(col?.cellPadding ?? DEFAULT_CELL_PADDING)
    c += span
  }
  return { cells, geo: { widths, pads } }
}

/* -------------------------------- 行高测量 ------------------------------- */

function measureRowHeight(
  { cells, geo }: BuiltRow,
  control: TableControl,
  measurer: TextMeasurer,
): number {
  const mode = control.options?.rowHeightMode ?? 'auto'
  if (mode === 'fixed') {
    return Math.max(MIN_ROW_HEIGHT, control.options?.rowHeight ?? 8)
  }

  let maxH = 0
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!
    const avail = Math.max(1, (geo.widths[i] ?? 0) - (geo.pads[i] ?? DEFAULT_CELL_PADDING) * 2)
    const { heightMm } = measurer.measure(cell.text ?? '', {
      fontSize: cell.fontSize ?? TABLE_FONT_SIZE,
      fontWeight: cell.bold ? 'bold' : 'normal',
      widthMm: avail,
    })
    if (heightMm > maxH) maxH = heightMm
  }
  return Math.max(MIN_ROW_HEIGHT, maxH + CELL_PADDING_Y * 2)
}

/* -------------------------------- 建模 -------------------------------- */

export interface BuildTableOptions {
  control: TableControl
  ctx: EvalContext
  measurer: TextMeasurer
  /**
   * 表格宽度（mm）。协议 page.unit 可能是 in/pt，而测量器只认 mm，
   * 因此调用方必须把换算后的值传进来；缺省时按 control.width 已是 mm 处理。
   */
  widthMm?: number
  /** 表格高度（mm），仅布局网格算行数时用到 */
  heightMm?: number
}

export function buildTableModel({
  control,
  ctx,
  measurer,
  widthMm,
  heightMm,
}: BuildTableOptions): TableModel {
  const warnings: RenderWarning[] = []
  const columns = control.columns ?? []
  const tableWidth = widthMm ?? control.width
  const tableHeight = heightMm ?? control.height
  const columnWidths = normalizeColumnWidths(columns, tableWidth)
  const errors: string[] = []

  // 设计期网格 = 内容与样式的唯一真理源（无 cells 的老模板由列配置瞬时推导）
  const grid = buildDesignGrid(control)
  const colCount = grid.colCount
  // 整张网格的合并布局（colSpan + rowSpan 一起算，设计 overlay 与运行期引擎共用同一份）
  const spanLayout = computeSpanLayout(grid.cells, grid.rowCount, colCount)

  const buildRowFrom = (
    rowCells: TableCell[],
    spanRow: CellSpan[],
    make: (cell: TableCell, col: TableColumn | undefined, colIndex: number) => RenderCell,
  ): BuiltRow => layoutDesignRow(rowCells, spanRow, columns, columnWidths, colCount, make)

  /* ── 表头行（支持多行表头） ── */
  const headerRows: RenderRow[] = []
  for (let r = 0; r < grid.headerRows; r++) {
    const built = buildRowFrom(grid.cells[r] ?? [], spanLayout[r]!, (cell, col) =>
      applyCellStyle(
        {
          text: staticCellText(cell, col, col?.title ?? '', ctx, errors),
          align: col?.headerAlign ?? col?.align ?? 'center',
          background: col?.headerBackgroundColor,
          bold: true,
        },
        control,
        col,
        cell,
        'header',
        ctx,
        errors,
      ),
    )
    headerRows.push({
      kind: 'header',
      height: measureRowHeight(built, control, measurer) * HEADER_ROW_FACTOR,
      cells: built.cells,
    })
  }

  /** 静态行（布局网格正文 / 数据表静态尾行）：字面量 + 全局插值 */
  const buildStaticRow = (rowCells: TableCell[], height: number | undefined, spanRow: CellSpan[]): RenderRow => {
    const built = buildRowFrom(rowCells, spanRow, (cell, col) =>
      applyCellStyle(
        { text: staticCellText(cell, col, '', ctx, errors), align: col?.align ?? 'left' },
        control,
        col,
        cell,
        'static',
        ctx,
        errors,
      ),
    )
    return {
      kind: 'static',
      height: height ?? measureRowHeight(built, control, measurer),
      cells: built.cells,
    }
  }

  const flushErrors = (): void => {
    for (const message of new Set(errors)) {
      warnings.push({ code: 'EXPRESSION_ERROR', message, controlId: control.id })
    }
  }

  /* ── 布局网格：无数据源，行高与设计画布逐行对齐（§5.4） ── */
  const isLayoutGrid = !isDataTable(control)
  if (isLayoutGrid) {
    // 与设计期共用 designRowHeights：画布上是几毫米，打印就是几毫米
    const heights = designRowHeights(control, tableHeight)
    headerRows.forEach((row, i) => {
      row.height = heights[i] ?? row.height
    })
    const rows: RenderRow[] = []
    for (let r = grid.headerRows; r < grid.rowCount; r++) {
      rows.push(buildStaticRow(grid.cells[r] ?? [], heights[r], spanLayout[r]!))
    }
    flushErrors()
    return { control, columns, columnWidths, headerRows, rows, footerRows: [], dataRows: [], warnings, isLayoutGrid: true }
  }

  /* ── 数据行 ── */
  let dataRows = resolveRows(control, ctx, warnings)

  if (control.options?.skipEmptyRows) {
    const fields = columns.map((c) => c.field).filter((f): f is string => Boolean(f))
    dataRows = dataRows.filter((r) => !isEmptyRow(r, fields))
  }

  const plans = planRows({ control, rows: dataRows, ctx })

  /** 与列 1:1 对齐的行（组头 / 小计 / 合计）的测量几何 */
  const columnGeo: RowGeometry = {
    widths: columnWidths,
    pads: columns.map((c) => c.cellPadding ?? DEFAULT_CELL_PADDING),
  }

  // 数据样例行（模板）：决定每个数据行的取值方式与单元格样式
  const template = grid.cells[grid.headerRows] ?? []
  // 数据行由运行期逐条生成，跨行会跨越不同记录，语义不成立 → 强制模板行 rowSpan=1（colSpan 保留）
  const templateSpan: CellSpan[] = spanLayout[grid.headerRows]!.map((s) => ({ ...s, rowSpan: 1 }))

  const rows: RenderRow[] = plans.map((plan) => buildRow(plan))

  function buildRow(plan: RowPlan): RenderRow {
    if (plan.kind === 'group') {
      const text = plan.label ?? ''
      const cells: RenderCell[] = [
        { text, align: 'left', colSpan: colCount, bold: true, background: '#F5F7FA' },
      ]
      return {
        kind: 'group',
        height: measureRowHeight(
          { cells, geo: { widths: [tableWidth], pads: [columnGeo.pads[0] ?? DEFAULT_CELL_PADDING] } },
          control,
          measurer,
        ),
        cells,
      }
    }

    if (plan.kind === 'subtotal' || plan.kind === 'summary') {
      const style =
        plan.kind === 'subtotal' ? control.options?.summaryRow?.subtotalStyle : undefined
      const cells = buildAggregateCells(plan.label ?? '小计', plan.aggregates ?? {}, style)
      return {
        kind: plan.kind,
        height: measureRowHeight({ cells, geo: columnGeo }, control, measurer),
        cells,
      }
    }

    // 数据行：内容与样式都由"数据样例行"模板驱动（含 colSpan 合并；rowSpan 强制为 1）
    const rowCtx: EvalContext = { ...ctx, row: plan.row, rowIndex: plan.dataIndex ?? 0 }
    const built = buildRowFrom(template, templateSpan, (cell, col) =>
      applyCellStyle(
        {
          text: dataCellText(cell, col, rowCtx, errors),
          align: col?.align ?? 'left',
          background: col?.cellBackgroundColor,
        },
        control,
        col,
        cell,
        'data',
        rowCtx,
        errors,
      ),
    )
    return {
      kind: 'data',
      dataIndex: plan.dataIndex,
      height: measureRowHeight(built, control, measurer),
      cells: built.cells,
    }
  }

  /**
   * 合计行按列填值：第一列放标签，配置了聚合的列放数值，其余留空。
   * 若第一列本身就是聚合列，则标签退到"无处可放"，此时把标签并入该列前缀。
   * @param style 可选样式覆盖（如分组小计行自定义样式），只覆盖显式设置的项。
   */
  function buildAggregateCells(
    label: string,
    agg: Record<string, number>,
    style?: TableCellStyle,
  ): RenderCell[] {
    const applyStyle = (cell: RenderCell): RenderCell => {
      if (!style) return cell
      const out: RenderCell = { ...cell }
      if (style.bold !== undefined) out.bold = style.bold
      if (style.italic !== undefined) out.italic = style.italic
      if (style.underline !== undefined) out.underline = style.underline
      if (style.fontSize !== undefined) out.fontSize = style.fontSize
      if (style.fontFamily) out.fontFamily = style.fontFamily
      if (style.color) out.color = style.color
      if (style.backgroundColor) out.background = style.backgroundColor
      if (style.align) out.align = style.align
      if (style.valign) out.valign = style.valign
      return out
    }

    const cells: RenderCell[] = columns.map((c, i) => {
      const field = c.field
      const hit =
        field !== undefined && (field in agg ? field : stripPrefix(field) in agg ? stripPrefix(field) : null)
      if (hit) {
        const v = agg[hit] ?? 0
        // 合计值沿用该列的显示格式：currency 带币种符号、digits 控小数位，
        // 与上方数据行观感一致。未配置 format 的列保留原有
        // 「整数 0 位 / 小数 2 位 + 千分位」行为，不动老模板。
        const text = c.format ? formatCellValue(v, c.format) : formatAggregate(v)
        return applyStyle({
          text,
          align: c.align ?? 'right',
          bold: true,
        })
      }
      return applyStyle({
        text: i === 0 ? label : '',
        align: i === 0 ? 'left' : (c.align ?? 'left'),
        bold: true,
      })
    })
    if (cells.length === 0) {
      cells.push(applyStyle({ text: label, align: 'left', bold: true, colSpan: 1 }))
    }
    return cells
  }

  function stripPrefix(field: string): string {
    return field.includes('[].') ? field.slice(field.indexOf('[].') + 3) : field
  }

  /* ── 表尾块：聚合尾行（本页合计 / 总计 / 大写金额）+ 设计期静态尾行 ── */

  /**
   * 构建一行表尾（语义尾行）。若该静态行含聚合 token，则按列字段类型判断是否需要计算：
   * - 数值列 → 标记 isAgg + aggField，渲染期由切片器按本页/总计重算；
   * - 非数值列（字符串等）→ 不计算，渲染为空占位。
   * 首列的行名标签（"本页合计"/"总计"/"大写金额"）按普通静态文本处理。
   */
  function buildFooterRow(rowCells: TableCell[], spanRow: CellSpan[]): RenderRow {
    const tokens = rowCells.map((c) => parseAggToken(c.text))
    const hasToken = tokens.some((t) => t !== null)
    let fk: FooterKind = 'static'
    if (hasToken) {
      if (tokens.some((t) => t === 'pageCap' || t === 'totalCap')) fk = 'capital'
      else if (tokens.some((t) => t === 'totalSum' || t === 'totalAvg' || t === 'totalCount'))
        fk = 'grandTotal'
      else fk = 'pageSubtotal'
    }
    const built = buildRowFrom(rowCells, spanRow, (cell, col) => {
      const tk = parseAggToken(cell.text)
      if (tk) {
        const field = stripItems(col?.field)
        const numeric = columnAggregatable(col, dataRows[0])
        if (numeric && field) {
        return applyCellStyle(
          {
            text: '',
            align: col?.align ?? 'center',
            bold: true,
            isAgg: true,
            tokenKind: tk,
            aggField: field,
          },
          control,
          col,
          cell,
          'static',
          ctx,
          errors,
        )
        }
        // 非数值列：聚合 token 不参与计算，留空
        return applyCellStyle(
          { text: '', align: col?.align ?? 'left', bold: true },
          control,
          col,
          cell,
          'static',
          ctx,
          errors,
        )
      }
      return applyCellStyle(
        { text: staticCellText(cell, col, '', ctx, errors), align: col?.align ?? 'left' },
        control,
        col,
        cell,
        'static',
        ctx,
        errors,
      )
    })
    return {
      kind: fk === 'static' ? 'static' : fk === 'pageSubtotal' ? 'subtotal' : 'summary',
      footerKind: fk,
      height: measureRowHeight(built, control, measurer),
      cells: built.cells,
    }
  }

  const footerRows: RenderRow[] = []
  const summaryPlan = buildSummaryPlan(dataRows, control)
  if (summaryPlan) {
    const cells = buildAggregateCells(summaryLabel(control), summaryPlan.aggregates ?? {})
    footerRows.push({
      kind: 'summary',
      footerKind: 'static',
      height: measureRowHeight({ cells, geo: columnGeo }, control, measurer),
      cells,
    })
  }
  const sample = dataRows[0]
  for (let r = grid.headerRows + 1; r < grid.rowCount; r++) {
    footerRows.push(buildFooterRow(grid.cells[r] ?? [], spanLayout[r]!))
  }

  flushErrors()

  return { control, columns, columnWidths, headerRows, rows, footerRows, dataRows, warnings, isLayoutGrid: false }
}

/* -------------------------------- 切片 -------------------------------- */

export interface SliceRequest {
  /** 本页分配给表格的可用高度（mm） */
  avail: number
  /** 从 model.rows 的第几行开始 */
  start: number
}

export interface SliceResult {
  headerRows: RenderRow[]
  rows: RenderRow[]
  footerRows: RenderRow[]
  /** 下一片起始下标 */
  nextStart: number
  /** 本片实际占高（mm） */
  height: number
  isLast: boolean
  warnings: RenderWarning[]
}

/** 表格在一页上至少要占的高度（表头 + 1 行 + 表尾），用于 keepTogether 判定 */
export function minStartHeight(model: TableModel): number {
  const h = sumRowHeights(model.headerRows)
  const firstRow = model.rows[0]?.height ?? MIN_ROW_HEIGHT
  const footer = sumRowHeights(model.footerRows)
  return h + firstRow + footer
}

/**
 * 从 start 位置切出一页能放下的内容。
 *
 * 预算顺序：可用高 −（表头）−（表尾）= 数据行预算。
 * 表尾是否占预算取决于 repeatFooter：
 * - repeatFooter !== false → 每页都有表尾，恒占预算
 * - repeatFooter === false → 只有末片有表尾，先按"无表尾"试算，
 *   若恰好切到最后一行，再回头检查表尾能否塞下，塞不下就吐出若干行留到下一页
 */
export function sliceTable(model: TableModel, req: SliceRequest): SliceResult {
  const warnings: RenderWarning[] = []
  const opts = model.control.options ?? {}
  const isFirst = req.start === 0

  const repeatHeader = opts.repeatHeader ?? true
  const repeatFooter = opts.repeatFooter ?? true

  const headerRows = isFirst || repeatHeader ? model.headerRows : []
  // td 0.2mm 边框（b-all / b-horizontal 的 border-top）未计入测量行高，渲染时逐行累积，
  // 会让切片实际底部超过预算、压到页脚/页面边缘。按行预留边框：宁少排一行，不压页脚。
  const borders = opts.borders ?? 'all'
  const rowBorder = borders === 'all' || borders === 'horizontal' ? 0.2 : 0
  const headerH = sumRowHeights(headerRows) + headerRows.length * rowBorder
  // 尾行按"是否每页都出现"拆分预算，避免非末页为总计/大写行预留留白：
  // - 每页固定：本页合计 + 静态尾行（repeatFooter 时）
  // - 仅末页：总计 + 大写金额 + 静态尾行（repeatFooter 关时）
  const pageFooterH = model.footerRows
    .filter((f) => f.footerKind === 'pageSubtotal' || (f.footerKind === 'static' && repeatFooter))
    .reduce((s, r) => s + r.height + rowBorder, 0)
  const lastFooterH = model.footerRows
    .filter(
      (f) =>
        f.footerKind === 'grandTotal' ||
        f.footerKind === 'capital' ||
        (f.footerKind === 'static' && !repeatFooter),
    )
    .reduce((s, r) => s + r.height + rowBorder, 0)

  // 固定每页行数（pageRows 为数字时强制分页）
  const forcedRows =
    typeof opts.pageRows === 'number' && opts.pageRows > 0 ? Math.floor(opts.pageRows) : null

  let budget = req.avail - headerH - pageFooterH

  // 把尾行模板按当前切片重算（本页合计用本页数据行；总计/大写用全表数据行，仅末页）
  function resolveTailRow(fr: RenderRow, rows: Array<Record<string, unknown>>): RenderRow {
    const cells: RenderCell[] = fr.cells.map((cell) => {
      if (!cell.isAgg || !cell.aggField || !cell.tokenKind) return cell
      const text =
        cell.tokenKind === 'totalCap' || cell.tokenKind === 'pageCap'
          ? toChineseCapitalRMB(aggValueForRows('totalSum', rows, cell.aggField))
          : formatAggNumber(aggValueForRows(cell.tokenKind, rows, cell.aggField))
      return { ...cell, text }
    })
    return { ...fr, cells }
  }

  function resolveFooterRows(
    pickedDataRows: Array<Record<string, unknown>>,
    last: boolean,
  ): RenderRow[] {
    const out: RenderRow[] = []
    for (const fr of model.footerRows) {
      const fk = fr.footerKind
      if (fk === 'pageSubtotal') {
        out.push(resolveTailRow(fr, pickedDataRows))
      } else if (fk === 'grandTotal' || fk === 'capital') {
        if (last) out.push(resolveTailRow(fr, model.dataRows))
      } else if (repeatFooter || last) {
        out.push(fr)
      }
    }
    return out
  }

  const picked: RenderRow[] = []
  let used = 0
  let i = req.start

  while (i < model.rows.length) {
    const row = model.rows[i]!
    const rowH = row.height + rowBorder
    if (forcedRows !== null && picked.length >= forcedRows) break

    if (used + rowH > budget) {
      // 一行都放不下：强制放一行，避免无限循环（并告警）
      if (picked.length === 0) {
        if (row.height > req.avail) {
          warnings.push({
            code: 'ROW_TOO_TALL',
            message: `第 ${(row.dataIndex ?? i) + 1} 行高度 ${row.height.toFixed(1)}mm 超过整页可用高度，已强制放置`,
            controlId: model.control.id,
          })
        }
        picked.push(row)
        used += rowH
        i++
      }
      break
    }

    picked.push(row)
    used += rowH
    i++
  }

  let isLast = i >= model.rows.length
  let footerRows: RenderRow[] = []

  // 仅当本片确有数据行时才挂表尾；否则空尾片（上一页已放完全部行）会渲染出多余的合计
  if (model.footerRows.length > 0 && picked.length > 0) {
    // 本片涉及的数据行（映射回原始数据，供本页合计重算）
    const pickedDataRows = picked
      .filter((r) => r.kind === 'data' && r.dataIndex !== undefined)
      .map((r) => model.dataRows[r.dataIndex!]!)
      .filter(Boolean)

    if (isLast) {
      // 末页需额外容纳总计 / 大写金额行：放不下则把数据行让给下一页
      while (picked.length > 0 && headerH + used + pageFooterH + lastFooterH > req.avail) {
        const removed = picked.pop()!
        used -= removed.height
        i--
      }
      // while 弹出行后，可能出现「footer 放下了但还有行没放完」的情况：
      // 这种 slice 的 i 已 < rows.length，实质是"被迫让行给真末页"，必须当作非末页
      // 只挂本页合计，绝不挂总计/大写（否则非末页出现总计 → 用户看到的"两页都有总计"bug）
      if (picked.length === 0) {
        // 极端：所有数据行弹出（avail 极小，连一行都放不下），表尾不挂、
        // 标记非末页，让下一页 sliceTable 重新放（否则会出现"非末页带总计/大写"）
        footerRows = []
        isLast = false
      } else if (i >= model.rows.length) {
        // 没让行（footer 装得下）→ 真末页，挂总计/大写
        footerRows = resolveFooterRows(pickedDataRows, true)
      } else {
        // 让了行给下一页 → 非末页，只挂本页合计
        isLast = false
        footerRows = resolveFooterRows(pickedDataRows, false)
      }
    } else {
      footerRows = resolveFooterRows(pickedDataRows, false)
    }
  }

  isLast = isLast && i >= model.rows.length

  return {
    headerRows,
    rows: picked,
    footerRows,
    nextStart: i,
    height: headerH + used + sumRowHeights(footerRows) + footerRows.length * rowBorder,
    isLast,
    warnings,
  }
}

/** 表格全部内容一次性排开的总高度（用于判断是否需要分页） */
export function totalTableHeight(model: TableModel): number {
  return sumRowHeights(model.headerRows) + sumRowHeights(model.rows) + sumRowHeights(model.footerRows)
}

export type { HAlign }