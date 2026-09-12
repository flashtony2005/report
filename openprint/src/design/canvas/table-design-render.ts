/**
 * table-design-render —— 设计期表格 HTML 渲染（方案 A：与运行期共用渲染语义）
 *
 * 设计期表格以 HTML overlay 呈现（绝对定位、transform 同步 Fabric 节点 + 视口），
 * 由本模块产出的 HTML 与运行期 html-renderer 使用同一套样式类 / 内联样式键，
 * 从而做到"设计即打印"的真·所见即所得；双击单元格即可原生 contenteditable 编辑。
 *
 * 所有几何以 mm 表达（CSS 原生支持 mm 单位），由调用方统一做 zoom/scale 变换。
 */
import type { TableCell, TableControl, TableColumn } from '@/types/control'
import {
  buildDesignGrid,
  computeSpanLayout,
  designRowHeights,
  resolveCellStyleFor,
  type DesignRowKind,
} from '@/core/layout-engine/table-cells'
import { isAggToken, parseAggToken } from '@/core/layout-engine/aggregate'
import { normalizeColumnWidths } from '@/core/layout-engine/table-engine'
import { diagonalBackground } from '@/core/renderer-html/css-generator'
import { interpolate } from '@/core/layout-engine/expression'
import type { EvalContext } from '@/core/layout-engine/types'
import { useDataSourceStore } from '@/design/stores/dataSource'

const PLACEHOLDER = '#9aa0a6'

/**
 * 构造设计期样例求值上下文：取数据源样例数据的第一条作为 `row`，供动态配色表达式求值。
 * 在 Pinia store 之外（如纯函数测试）调用时 store 可能未初始化，try/catch 兜底返回空上下文。
 */
function buildSampleCtx(): EvalContext {
  try {
    const ds = useDataSourceStore()
    const data = (ds.previewData ?? {}) as Record<string, unknown>
    const items = Array.isArray(data['items']) ? (data['items'] as unknown[]) : []
    const row = items.length ? (items[0] as Record<string, unknown>) : undefined
    return { data, row, rowIndex: 0, page: 1, pages: 3 }
  } catch {
    return { data: {}, row: undefined, rowIndex: 0, page: 1, pages: 1 }
  }
}

/**
 * 对动态配色表达式求值：含 `{{}}` 时调 interpolate；非表达式或求值失败时原样返回。
 * 设计画布显示用样例数据算出来的颜色，让用户实时看到效果。
 */
function evalColorExpr(src: string | undefined, ctx: EvalContext): string | undefined {
  if (!src) return undefined
  if (!/\{\{/.test(src)) return src
  try {
    const r = interpolate(src, ctx)
    // 求值出错或结果为空时回退到原表达式字符串（避免画布丢色）
    return r.errors.length || !r.text ? src : r.text
  } catch {
    return src
  }
}

/**
 * 各可视行的行高（mm），与渲染、命中测试共用。
 * 实现下沉到 core（designRowHeights），**运行期布局网格用的是同一份算法** —— 这样
 * 空白表格在画布上什么样，打印出来就是什么样。
 */
export function gridRowHeights(control: TableControl): number[] {
  return designRowHeights(control)
}

/** 列累计 x（mm，长度 colCount+1，末值 = 表格宽） */
export function gridColXs(control: TableControl): number[] {
  const widths = normalizeColumnWidths(control.columns, control.width)
  const xs = [0]
  for (const w of widths) xs.push(xs[xs.length - 1]! + w)
  return xs
}

export interface GridLayout {
  colXs: number[]
  rowYs: number[]
  rowCount: number
  colCount: number
}

/** 设计期网格布局（mm），供渲染与双击命中测试共用 */
export function computeGridLayout(control: TableControl): GridLayout {
  const grid = buildDesignGrid(control)
  const colXs = gridColXs(control)
  const rowHs = gridRowHeights(control)
  const rowYs = [0]
  for (const h of rowHs) rowYs.push(rowYs[rowYs.length - 1]! + h)
  return { colXs, rowYs, rowCount: grid.rowCount, colCount: grid.colCount }
}

/** 计算双击点命中的单元格（fraction ∈ [0,1]） */
export function hitTestCell(
  layout: GridLayout,
  fracX: number,
  fracY: number,
): { row: number; col: number } | null {
  if (fracX < 0 || fracX > 1 || fracY < 0 || fracY > 1) return null
  const x = fracX * layout.colXs[layout.colXs.length - 1]!
  const y = fracY * layout.rowYs[layout.rowYs.length - 1]!
  let col = 0
  for (let c = 1; c < layout.colXs.length; c++) {
    if (x <= layout.colXs[c]!) { col = c - 1; break }
    col = c - 1
  }
  let row = 0
  for (let r = 1; r < layout.rowYs.length; r++) {
    if (y <= layout.rowYs[r]!) { row = r - 1; break }
    row = r - 1
  }
  return { row, col }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 字段 → 占位符显示：含数组标记（items[].name）直接用路径，避免 {{item.items[].name}} 冗余前缀 */
function fieldPlaceholder(field: string): string {
  return field.includes('[]') ? `{{${field}}}` : `{{item.${field}}}`
}

function placeholderOf(cell: TableCell, col: TableColumn | undefined): string {
  const mode = cell.contentType
  if (mode === 'expression') return cell.expression ?? ''
  if (mode === 'variable') return cell.field ? fieldPlaceholder(cell.field) : ''
  if (mode === 'fixed') return ''
  // 老模板启发式（无 contentType）：expression > field > 列配置
  if (cell.expression) return cell.expression
  if (cell.field) return fieldPlaceholder(cell.field)
  if (col?.expression) return col.expression
  if (col?.field) return fieldPlaceholder(col.field)
  return ''
}

/** 单元格是否按"绑定占位"显示（variable / expression 显式模式，或老模板启发式命中字段） */
function isBoundCell(cell: TableCell, col: TableColumn | undefined, isDataRow: boolean): boolean {
  const mode = cell.contentType
  if (mode === 'variable' || mode === 'expression') return true
  if (mode === 'fixed') return false
  return Boolean(
    cell.field || cell.expression || (isDataRow && col?.field) || (isDataRow && col?.expression),
  )
}

/**
 * 单元格内联样式。
 * 只输出**显式设置过**的属性，未设置的交给 css-generator 的 `.op-table` 类规则兜底
 * （例如表头加粗、va-* 垂直对齐），保证设计期与运行期视觉一致。
 */
function cellStyle(
  control: TableControl,
  cell: TableCell,
  col: TableColumn | undefined,
  placeholder: boolean,
  kind: DesignRowKind,
): string {
  const s = resolveCellStyleFor(control, col, cell, kind)
  // 动态配色：仅数据行用样例数据求值（表头/静态行不染动态色）
  const ctx = kind === 'data' ? buildSampleCtx() : null
  const bgColor = ctx ? evalColorExpr(s.backgroundColor, ctx) : s.backgroundColor
  const fgColor = ctx ? evalColorExpr(s.color, ctx) : s.color
  const parts: string[] = []
  if (s.fontSize) parts.push(`font-size:${s.fontSize}pt`)
  if (s.fontFamily) parts.push(`font-family:${s.fontFamily}`)
  if (s.bold !== undefined) parts.push(`font-weight:${s.bold ? 'bold' : 'normal'}`)
  if (s.italic !== undefined) parts.push(`font-style:${s.italic ? 'italic' : 'normal'}`)
  if (s.underline !== undefined) parts.push(`text-decoration:${s.underline ? 'underline' : 'none'}`)
  if (s.align) parts.push(`text-align:${s.align}`)
  if (s.valign) parts.push(`vertical-align:${s.valign}`)
  if (bgColor) parts.push(`background-color:${bgColor}`)
  if (s.diagonal) parts.push(diagonalBackground(s.diagonal))
  // 占位符（字段绑定 / 聚合 token）强制单行：长文本（如 {{item.productCode}}）换行会把
  // 画布行高撑得比 designRowHeights 的单行估算高，导致表格实际总高 > 包围盒，
  // 末尾的「大写金额」等行被 overlay 的 overflow:hidden 裁掉（看不见、拉大才出现）。
  // 超出部分省略号截断，仅提示绑定关系；运行期按真实数据换行不受影响。
  if (placeholder) parts.push(`color:${PLACEHOLDER}`, 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis')
  else if (fgColor) parts.push(`color:${fgColor}`)
  return parts.join(';')
}

/**
 * 渲染设计期表格 HTML（表头 / 数据样例行 / 静态尾行）。
 *
 * 类名与运行期 html-renderer 完全一致（op-table / b-* / va-* / is-header / is-data），
 * 因此同一份 CSS 即可驱动两端 —— 这正是"设计即打印"的根。
 * 每个 td 带 `data-row` / `data-col`，供 overlay 做 DOM 级单元格定位与编辑写回。
 */
export function renderTableGridHtml(control: TableControl): string {
  const grid = buildDesignGrid(control)
  const opts = control.options ?? {}
  const borders = opts.borders ?? 'all'
  const va = opts.verticalAlign ?? 'middle'
  const colXs = gridColXs(control)
  const colWs = colXs.slice(1).map((_, i) => colXs[i + 1]! - colXs[i]!)
  const rowHs = gridRowHeights(control)
  // 合并布局（colSpan + rowSpan 一起算），与设计期渲染、运行期引擎共用同一份结果
  const spanLayout = computeSpanLayout(grid.cells, grid.rowCount, grid.colCount)

  const cols = colWs.map((w) => `<col style="width:${w}mm">`).join('')
  const rows: string[] = []

  for (let r = 0; r < grid.rowCount; r++) {
    const isHeaderRow = r < grid.headerRows
    const isDataRow = grid.isData && r === grid.headerRows
    const kind: DesignRowKind = isHeaderRow ? 'header' : isDataRow ? 'data' : 'static'
    const spanRow = spanLayout[r]!
    const cells: string[] = []
    let c = 0
    while (c < grid.colCount) {
      if (spanRow[c]!.skip) {
        c++
        continue
      }
      const cell = grid.cells[r]?.[c] ?? {}
      const col = control.columns[c]
      const span = spanRow[c]!.colSpan
      const rspan = spanRow[c]!.rowSpan
      const isAgg = isAggToken(cell.text)
      const bound = isBoundCell(cell, col, isDataRow)
      // 聚合 token（{{#totalSum}} 等）按占位符着色显示，提示用户这是动态计算单元格
      const placeholder = bound || isAgg
      const text = bound ? placeholderOf(cell, col) : (cell.text ?? '')
      const style = cellStyle(control, cell, col, placeholder, kind)
      const spanAttr = span > 1 ? ` colspan="${span}"` : ''
      const rspanAttr = rspan > 1 ? ` rowspan="${rspan}"` : ''
      const tdClass = isAgg ? ' is-agg' : ''
      const styleAttr = style ? ` style="${style}"` : ''
      cells.push(
        `<td data-row="${r}" data-col="${c}"${spanAttr}${rspanAttr}${tdClass ? ` class="${tdClass}"` : ''}${styleAttr}>${esc(text) || '<br>'}</td>`,
      )
      c += span
    }
    const rh = rowHs[r]
    let cls = isDataRow ? 'is-data is-template' : isHeaderRow ? 'is-header' : 'is-static'
    // 聚合尾行（本页合计/总计/大写金额）对齐运行期 is-subtotal/is-summary 类，保证样式预设两端一致
    if (!isHeaderRow && !isDataRow) {
      const tokens = (grid.cells[r] ?? []).map((c) => parseAggToken(c.text))
      if (tokens.some((t) => t === 'pageSum' || t === 'pageAvg' || t === 'pageCount')) cls = 'is-subtotal'
      else if (tokens.some((t) => t === 'totalSum' || t === 'totalAvg' || t === 'totalCount' || t === 'pageCap' || t === 'totalCap')) cls = 'is-summary'
    }
    rows.push(`<tr class="${cls}" style="height:${rh}mm">${cells.join('')}</tr>`)
  }

  const tableStyle = opts.tableStyle ?? 'none'
  return (
    `<table class="op-node op-table b-${borders} va-${va} ts-${tableStyle}" ` +
    `style="width:${control.width}mm;height:${control.height}mm;table-layout:fixed">` +
    `<colgroup>${cols}</colgroup><tbody>${rows.join('')}</tbody></table>`
  )
}
