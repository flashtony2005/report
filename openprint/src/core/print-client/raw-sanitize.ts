/**
 * 指令直通模式（esc / tsc / zpl）的画布 JSON 净化
 *
 * 设计原则：**只保留客户端翻译指令所需的字段**，其余（浏览器渲染样式 / 设计器元数据）
 * 一律裁剪——指令（ESC/POS、TSPL、ZPL）不支持字体样式，打印机默认内置中文字库
 * （如 GB2312 中文字体），颜色对单色票据 / 标签机无意义。
 *
 * 保留（白名单）：
 * - 几何：left / top / width / height / angle（旋转，TSC/ZPL 支持 0/90/180/270）
 * - 内容：文本 / 绑定 / 表达式 / 格式（contentType/value/binding/expression/format）
 * - 排版必需：字号（fontSize）+ 对齐（textAlign/align）——字体样式一律不传
 * - 条码 / 二维码规格：format/showText/errorLevel
 * - 表格结构：columns/cells/options/summary（分页、边框等语义保留；样式净化）
 * - 数据绑定字段：dataSource、{{row.x}} 依赖的 data
 *
 * 删除：
 * - 字体样式：fontFamily/fontWeight/fontStyle/textDecoration/bold/italic/underline/
 *   lineHeight/letterSpacing（打印机内置字库，指令不支持）
 * - 颜色：fill/color/backgroundColor/cellBackgroundColor/headerBackgroundColor/stroke
 *   /subtotalStyle 等（单色打印）
 * - 设计器元数据：locked/name/showGuides/childOf（画布回环标记）
 * - 渲染装饰：cornerRadius/strokeDashArray/image fit/labelgrid showLines/水印/页背景色
 * - 页面级渲染配置：page.backgroundColor / watermark / minPages
 */
import type { AnyControl, TableCell, TableCellStyle, TableColumn, TableOptions } from '@/types/control'
import type { PageSetup, Section, TemplateData } from '@/types/template'
import type { RenderRequest } from '@/core/sdk'

/** 从对象中挑选指定键（跳过 undefined） */
function pick<T extends object>(obj: T, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = (obj as unknown as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/** 控件公共保留键（几何 + 打印语义；设计器元数据 locked/name/showGuides/childOf 不传） */
const BASE_KEYS = ['id', 'type', 'left', 'top', 'width', 'height', 'angle', 'printable', 'visibleIf'] as const

/** 文本样式：只留字号与对齐（字体样式 / 颜色删除） */
const TEXT_STYLE_KEYS = ['fontSize', 'textAlign'] as const
/** 单元格样式：只留字号与对齐（bold/italic/underline/fontFamily/颜色删除） */
const CELL_STYLE_KEYS = ['fontSize', 'align', 'valign', 'diagonal'] as const

/** 页面设置：物理尺寸 / 单位 / 方向 / 边距；删除 backgroundColor / watermark / minPages */
const PAGE_KEYS = ['width', 'height', 'unit', 'orientation', 'margin'] as const

const TABLE_COLUMN_KEYS = [
  'title',
  'field',
  'expression',
  'width',
  'align',
  'headerAlign',
  'aggregate',
  'format',
  'style',
] as const

const TABLE_OPTION_KEYS = [
  'repeatHeader',
  'repeatFooter',
  'pageRows',
  'rowHeightMode',
  'rowHeight',
  'keepTogether',
  'skipEmptyRows',
  'mergeSheets',
  'verticalAlign',
  'borders',
  'tableStyle',
  'defaultCellStyle',
  'summaryRow',
] as const

const SUMMARY_ROW_KEYS = [
  'type',
  'fields',
  'label',
  'expression',
  'expressions',
  'subtotalLabel',
  'subtotalStyle',
] as const

const TABLE_CELL_KEYS = ['contentType', 'text', 'field', 'expression', 'format', 'colSpan', 'rowSpan', 'style'] as const

function sanitizeColumn(col: TableColumn): Partial<TableColumn> {
  const out = pick(col, TABLE_COLUMN_KEYS)
  if (col.style) out.style = pick(col.style, CELL_STYLE_KEYS) as TableCellStyle
  return out
}

function sanitizeCell(cell: TableCell): Partial<TableCell> {
  const out = pick(cell, TABLE_CELL_KEYS)
  if (cell.style) out.style = pick(cell.style, CELL_STYLE_KEYS) as TableCellStyle
  return out
}

function sanitizeTableOptions(opts: TableOptions): Partial<TableOptions> {
  const out = pick(opts, TABLE_OPTION_KEYS)
  if (opts.defaultCellStyle) out.defaultCellStyle = pick(opts.defaultCellStyle, CELL_STYLE_KEYS) as TableCellStyle
  if (opts.summaryRow) {
    const s = opts.summaryRow
    const summary = pick(s, SUMMARY_ROW_KEYS)
    if (s.subtotalStyle) summary.subtotalStyle = pick(s.subtotalStyle, CELL_STYLE_KEYS) as TableCellStyle
    out.summaryRow = summary as TableOptions['summaryRow']
  }
  return out
}

/** 递归净化单个控件（按类型白名单 + 嵌套子结构） */
export function sanitizeControl(control: AnyControl): AnyControl {
  const base = pick(control, BASE_KEYS)
  let out: Record<string, unknown>
  switch (control.type) {
    case 'text':
      out = {
        ...base,
        ...pick(control, ['contentType', 'value', 'binding', 'expression', 'format']),
        ...(control.style ? { style: pick(control.style, TEXT_STYLE_KEYS) } : {}),
      }
      break
    case 'image':
      out = { ...base, ...(control.value ? { value: control.value } : {}) }
      break
    case 'table':
      out = {
        ...base,
        ...pick(control, ['dataSource', 'data', 'groupBy', 'summary', 'headerRows', 'staticRows', 'designRows']),
        ...(control.columns ? { columns: control.columns.map(sanitizeColumn) } : {}),
        ...(control.options ? { options: sanitizeTableOptions(control.options) } : {}),
        ...(control.cells ? { cells: control.cells.map((row) => row.map(sanitizeCell)) } : {}),
      }
      break
    case 'barcode':
      out = { ...base, ...pick(control, ['contentType', 'binding', 'value', 'expression', 'format', 'showText']) }
      break
    case 'qrcode':
      out = { ...base, ...pick(control, ['contentType', 'binding', 'value', 'expression', 'errorLevel']) }
      break
    case 'rect':
      // 颜色（fill/stroke）不传，单色打印默认黑；保留线宽与形状
      out = { ...base, ...pick(control, ['strokeWidth', 'shape']) }
      break
    case 'line':
      out = { ...base, ...pick(control, ['strokeWidth']) }
      break
    case 'richtext':
      out = { ...base, ...(control.value !== undefined ? { value: control.value } : {}) }
      break
    case 'chart':
      // 图表在指令模式下通常无法直接翻译，数据全量保留供客户端自行决定（忽略或简化）
      out = { ...base, ...pick(control, ['kind', 'categories', 'series', 'options']) }
      break
    case 'math':
      out = { ...base, ...pick(control, ['latex', 'displayMode', 'fontSize']) }
      break
    case 'signature':
      out = { ...base, ...(control.src ? { src: control.src } : {}), ...pick(control, ['penWidth']) }
      break
    case 'zone':
      out = { ...base, ...pick(control, ['zone', 'zoneHeight', 'repeat']), children: control.children.map(sanitizeControl) }
      break
    case 'labelgrid':
      out = {
        ...base,
        ...pick(control, ['columns', 'gapX', 'gapY', 'cardWidth', 'cardHeight', 'dataSource']),
        children: control.children.map(sanitizeControl),
      }
      break
    default:
      out = { ...base }
  }
  return out as unknown as AnyControl
}

function sanitizeSection<C>(section: Section<C>): Section<C> {
  return {
    type: section.type,
    ...(section.height !== undefined ? { height: section.height } : {}),
    ...(section.repeat !== undefined ? { repeat: section.repeat } : {}),
    components: (section.components as AnyControl[]).map(sanitizeControl) as C[],
  }
}

/** 净化模板：页面渲染配置 / 控件样式裁剪，保留协议结构与数据绑定所需字段 */
export function sanitizeTemplate<C>(template: TemplateData<C>): TemplateData<C> {
  return {
    version: template.version,
    document: {
      type: 'report',
      page: pick(template.document.page, PAGE_KEYS) as PageSetup,
      sections: template.document.sections.map(sanitizeSection),
    },
  }
}

/**
 * 指令直通载荷对象：`{ ...净化后模板, data }`（无 `template` 包裹层）。
 * data 为客户端数据绑定（{{field}} / {{row.x}}）所需，原样保留。
 */
export function buildRawPayloadObject(request: RenderRequest): Record<string, unknown> {
  const template = sanitizeTemplate(request.template)
  return request.data ? { ...template, data: request.data } : { ...template }
}
