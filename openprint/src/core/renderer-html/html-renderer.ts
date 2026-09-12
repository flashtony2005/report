/**
 * HTML 渲染器 —— LayoutPage[] → 可打印 HTML
 * 真理源：《OpenPrint-设计方案.md》§5.11（打印样式）、§7.3（渲染产物）、§11.2（注入防护）
 *
 * ## 定位模型
 *
 * 引擎已经把一切算成 mm 绝对坐标，渲染器只做「数据 → 字符串」的机械翻译：
 * 不做换行、不做测量、不做条件判断。任何在这里出现的排版逻辑都意味着
 * 「测量用一套规则、渲染用另一套」，最终表现为分页错位——所以这里刻意保持"笨"。
 *
 * ## 注入防护（§11.2）
 *
 * - 文本 / 属性值一律 escape
 * - richtext 在 data-binder 里已过 DOMPurify，这里直接注入
 * - 条码 SVG 来自 bwip-js / qrcode 生成器，文本已被库转义
 * - 图片 src 过 URL 协议白名单，挡掉 `javascript:` 一类的伪协议
 */
import type {
  ImageControl,
  LineControl,
  RectControl,
  TextControl,
} from '@/types/control'
import type {
  LayoutPage,
  LayoutResult,
  PlacedControl,
  PlacedTable,
  PlacedNode,
  RenderRow,
  GridLine,
} from '@/core/layout-engine/types'
import { layoutHasMath } from '@/core/layout-engine/control-scan'
import type { WatermarkConfig } from '@/types/template'
import {
  generateCss,
  mmv,
  diagonalBackground,
  TEXT_DEFAULT_COLOR,
  TEXT_DEFAULT_FONT_FAMILY,
  TEXT_DEFAULT_FONT_SIZE,
  TEXT_DEFAULT_LINE_HEIGHT,
  type CssOptions,
} from './css-generator'
import { MM_TO_PX } from '@/utils/constants'

/* -------------------------------- 转义 -------------------------------- */

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c)
}

/** CSS 值消毒：挡掉 `;` `{}` 与 url(javascript:) 之类的样式注入 */
function cssValue(v: unknown): string {
  return String(v ?? '')
    .replace(/[;{}<>]/g, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/url\s*\(\s*['"]?\s*javascript:/gi, 'url(')
    .trim()
}

/** 图片地址协议白名单 */
function safeSrc(src: string): string {
  const s = src.trim()
  if (/^(data:image\/|https?:|blob:|\/|\.\/|\.\.\/)/i.test(s)) return s
  // 相对路径（不含协议）也放行
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
  return ''
}

function styleAttr(pairs: Array<string | false | null | undefined>): string {
  const s = pairs.filter(Boolean).join(';')
  return s ? ` style="${escapeHtml(s)}"` : ''
}

/* ------------------------------ 节点几何 ------------------------------ */

function boxStyles(node: PlacedNode): string[] {
  const out = [
    `left:${mmv(node.left)}`,
    `top:${mmv(node.top)}`,
    `width:${mmv(node.width)}`,
    `height:${mmv(node.height)}`,
  ]
  const angle = node.kind === 'control' ? node.angle : undefined
  if (angle) out.push(`transform:rotate(${Math.round(angle * 100) / 100}deg)`)
  return out
}

/* -------------------------------- 控件 -------------------------------- */

function renderText(node: PlacedControl, text: string): string {
  const s = (node.control as TextControl).style ?? {}
  const style = [
    ...boxStyles(node),
    `font-size:${s.fontSize ?? TEXT_DEFAULT_FONT_SIZE}pt`,
    `color:${cssValue(s.fill ?? TEXT_DEFAULT_COLOR)}`,
    `font-family:${cssValue(s.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY)}`,
    `font-weight:${s.fontWeight === 'bold' ? 'bold' : 'normal'}`,
    `font-style:${s.fontStyle === 'italic' ? 'italic' : 'normal'}`,
    `text-decoration:${s.textDecoration === 'underline' ? 'underline' : 'none'}`,
    `text-align:${s.textAlign ?? 'left'}`,
    `line-height:${s.lineHeight ?? TEXT_DEFAULT_LINE_HEIGHT}`,
    s.letterSpacing ? `letter-spacing:${s.letterSpacing}pt` : null,
  ]
  return `<div class="op-node op-text" data-id="${escapeHtml(node.id)}"${styleAttr(style)}>${escapeHtml(text)}</div>`
}

function renderImage(node: PlacedControl, src: string): string {
  const c = node.control as ImageControl
  const url = safeSrc(src)
  if (!url) return renderPlaceholder(node, '图片')
  const radius = c.cornerRadius ? `border-radius:${c.cornerRadius}px` : null
  const imgStyle = [`object-fit:${c.fit ?? 'contain'}`, radius]
  return (
    `<div class="op-node op-image" data-id="${escapeHtml(node.id)}"${styleAttr(boxStyles(node))}>` +
    `<img src="${escapeHtml(url)}" alt=""${styleAttr(imgStyle)}></div>`
  )
}

function renderCode(node: PlacedControl, svg: string): string {
  // svg 由 bwip-js / qrcode 生成，内容已由库自身转义
  return `<div class="op-node op-code" data-id="${escapeHtml(node.id)}"${styleAttr(boxStyles(node))}>${svg}</div>`
}

function renderRichText(node: PlacedControl, html: string): string {
  // html 已在 data-binder 中经 DOMPurify 消毒
  return `<div class="op-node op-richtext" data-id="${escapeHtml(node.id)}"${styleAttr(boxStyles(node))}>${html}</div>`
}

function renderShape(node: PlacedControl): string {
  const c = node.control
  if (c.type === 'line') {
    const line = c as LineControl
    const stroke = cssValue(line.stroke ?? '#000000')
    const sw = line.strokeWidth ?? 1
    const dash = line.strokeDashArray?.length ? 'dashed' : 'solid'
    // 协议只存外接框，宽>=高视为水平线（与 PrintLine 的 MVP 约定一致）
    const horizontal = node.height <= node.width
    const inner = horizontal
      ? `left:0;right:0;top:50%;transform:translateY(-50%);border-top:${sw}px ${dash} ${stroke}`
      : `top:0;bottom:0;left:50%;transform:translateX(-50%);border-left:${sw}px ${dash} ${stroke}`
    return (
      `<div class="op-node op-line" data-id="${escapeHtml(node.id)}"${styleAttr(boxStyles(node))}>` +
      `<span${styleAttr([inner])}></span></div>`
    )
  }

  const rect = c as RectControl
  const fill = rect.fill && rect.fill !== 'transparent' ? cssValue(rect.fill) : 'transparent'
  const sw = rect.strokeWidth ?? 1
  const isCircle = rect.shape === 'circle'

  // 圆角：优先四角独立值，其次统一 cornerRadius，最后无圆角
  let radiusStyle: string | null = null
  if (isCircle) {
    radiusStyle = 'border-radius:50%'
  } else if (
    rect.cornerRadiusTL != null ||
    rect.cornerRadiusTR != null ||
    rect.cornerRadiusBR != null ||
    rect.cornerRadiusBL != null
  ) {
    const cr = rect.cornerRadius ?? 0
    const tl = rect.cornerRadiusTL ?? cr
    const tr = rect.cornerRadiusTR ?? cr
    const br = rect.cornerRadiusBR ?? cr
    const bl = rect.cornerRadiusBL ?? cr
    radiusStyle = `border-radius:${tl}px ${tr}px ${br}px ${bl}px`
  } else if (rect.cornerRadius) {
    radiusStyle = `border-radius:${rect.cornerRadius}px`
  }

  const style = [
    ...boxStyles(node),
    `background:${fill}`,
    sw > 0 ? `border:${sw}px solid ${cssValue(rect.stroke ?? '#000000')}` : 'border:0',
    radiusStyle,
    // 虚线：画布侧走 Fabric setLineDash，导出侧用 border-style 近似
    rect.strokeDashArray?.length ? 'border-style:dashed' : null,
  ]
  return `<div class="op-node ${isCircle ? 'op-circle' : 'op-rect'}" data-id="${escapeHtml(node.id)}"${styleAttr(style)}></div>`
}

function renderPlaceholder(node: PlacedControl, label: string): string {
  return (
    `<div class="op-node op-placeholder" data-id="${escapeHtml(node.id)}"${styleAttr(boxStyles(node))}>` +
    `${escapeHtml(label)}</div>`
  )
}

function renderControl(node: PlacedControl): string {
  switch (node.content.kind) {
    case 'text':
      return renderText(node, node.content.text)
    case 'html':
      return renderRichText(node, node.content.html)
    case 'image':
      return renderImage(node, node.content.src)
    case 'svg':
      return renderCode(node, node.content.svg)
    case 'shape':
      return renderShape(node)
    case 'placeholder':
      return renderPlaceholder(node, node.content.label)
    default:
      return ''
  }
}

/* -------------------------------- 表格 -------------------------------- */

const ROW_CLASS: Record<RenderRow['kind'], string> = {
  header: 'is-header',
  data: 'is-data',
  group: 'is-group',
  subtotal: 'is-subtotal',
  summary: 'is-summary',
  static: 'is-static',
}

/**
 * 输出单元格完整样式。
 * 只写**显式设置过**的属性，其余交给 `tableCss()` 的类规则兜底 —— 设计期 overlay
 * （table-design-render.ts）走的是同一套取舍，两端因此像素级一致。
 */
function renderRow(row: RenderRow, striped: boolean): string {
  const cls = [ROW_CLASS[row.kind]]
  if (striped && row.kind === 'data' && (row.dataIndex ?? 0) % 2 === 1) cls.push('is-striped')

  const cells = row.cells
    .map((cell) => {
      const style = [
        `text-align:${cell.align ?? 'left'}`,
        cell.background ? `background-color:${cssValue(cell.background)}` : null,
        cell.bold !== undefined ? `font-weight:${cell.bold ? 'bold' : 'normal'}` : null,
        cell.fontSize ? `font-size:${cell.fontSize}pt` : null,
        cell.fontFamily ? `font-family:${cssValue(cell.fontFamily)}` : null,
        cell.italic !== undefined ? `font-style:${cell.italic ? 'italic' : 'normal'}` : null,
        cell.underline !== undefined
          ? `text-decoration:${cell.underline ? 'underline' : 'none'}`
          : null,
        cell.color ? `color:${cssValue(cell.color)}` : null,
        cell.valign ? `vertical-align:${cell.valign}` : null,
        cell.diagonal ? diagonalBackground(cell.diagonal) : null,
      ]
      const span = cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''
      const rspan = cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
      return `<td${span}${rspan}${styleAttr(style)}>${escapeHtml(cell.text) || '<br>'}</td>`
    })
    .join('')

  return `<tr class="${cls.join(' ')}" style="height:${mmv(row.height)}">${cells}</tr>`
}

function renderTable(node: PlacedTable): string {
  const opts = node.control.options ?? {}
  const borders = opts.borders ?? 'all'
  const striped = opts.striped ?? false
  const va = opts.verticalAlign ?? 'middle'
  const tableStyle = opts.tableStyle ?? 'none'

  const cols = node.columnWidths
    .map((w) => `<col style="width:${mmv(w)}">`)
    .join('')

  const body: string[] = []
  for (const row of node.headerRows) body.push(renderRow(row, false))
  for (const row of node.rows) body.push(renderRow(row, striped))
  for (const row of node.footerRows) body.push(renderRow(row, false))

  const style = [
    `left:${mmv(node.left)}`,
    `top:${mmv(node.top)}`,
    `width:${mmv(node.width)}`,
  ]

  return (
    `<table class="op-node op-table b-${borders} va-${va} ts-${tableStyle}" data-id="${escapeHtml(node.id)}"` +
    `${styleAttr(style)}><colgroup>${cols}</colgroup><tbody>${body.join('')}</tbody></table>`
  )
}

function renderNode(node: PlacedNode): string {
  return node.kind === 'table' ? renderTable(node) : renderControl(node)
}

/* --------------------------------- 页 --------------------------------- */

function renderGridLines(lines: GridLine[]): string {
  if (lines.length === 0) return ''
  const cells = lines
    .map((l) => {
      const border = l.solid ? '1px solid rgba(37,99,235,0.55)' : '1px dashed rgba(37,99,235,0.5)'
      const style = [
        `left:${mmv(l.left)}`,
        `top:${mmv(l.top)}`,
        `width:${mmv(l.width)}`,
        `height:${mmv(l.height)}`,
        `border:${border}`,
        'box-sizing:border-box',
        'pointer-events:none',
      ]
      return `<div class="op-gridline"${styleAttr(style)}></div>`
    })
    .join('')
  return `<div class="op-gridlines">${cells}</div>`
}

function renderSection(cls: string, nodes: PlacedNode[]): string {
  if (nodes.length === 0) return `<div class="op-section ${cls}"></div>`
  return `<div class="op-section ${cls}">${nodes.map(renderNode).join('')}</div>`
}

/**
 * 生成水印装饰层 HTML。
 * - 居中单个：flex 居中 + 绝对定位旋转 span
 * - 全页平铺：用单个旋转水印瓦片生成的 SVG 作 background-image（repeat）
 * 文本已 escape，颜色经 cssValue 消毒。
 */
function renderWatermark(wm: WatermarkConfig): string {
  if (!wm.enabled) return ''
  const color = cssValue(wm.color) || '#cccccc'
  const size = Math.max(1, wm.fontSize)
  const rot = Number.isFinite(wm.rotation) ? wm.rotation : 0
  const text = escapeHtml(wm.text || '')

  if (!wm.tile) {
    const span = `<span style="transform:translate(-50%,-50%) rotate(${rot}deg);color:${color};font-size:${mmv(size)};font-family:${TEXT_DEFAULT_FONT_FAMILY};font-weight:bold;opacity:0.9">${text}</span>`
    return `<div class="op-watermark op-wm-single">${span}</div>`
  }

  // 平铺：瓦片尺寸（mm）随字号放大，瓦片内绘制旋转文本
  const spacingMm = Math.max(size * 2.6, 14)
  const tilePx = Math.max(1, Math.ceil(spacingMm * (MM_TO_PX)))
  const fontSizePx = Math.max(1, size) * MM_TO_PX
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tilePx}" height="${tilePx}">` +
    `<text x="50%" y="50%" fill="${color}" font-size="${fontSizePx}" font-family='${TEXT_DEFAULT_FONT_FAMILY}' ` +
    `font-weight="bold" text-anchor="middle" dominant-baseline="middle" ` +
    `transform="rotate(${rot} ${tilePx / 2} ${tilePx / 2})">${escapeHtml(wm.text || '')}</text>` +
    `</svg>`
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`
  const style = `background-image:url('${uri}');background-repeat:repeat;background-size:${mmv(spacingMm)} ${mmv(spacingMm)};`
  return `<div class="op-watermark op-wm-tile" style="${style}"></div>`
}

export function renderPage(page: LayoutPage, watermark?: WatermarkConfig | null): string {
  const wm = watermark ? renderWatermark(watermark) : ''
  // Word 式布局：页眉/页脚是 .op-page 的直接子元素（在上下边距内），
  // 正文独占 .op-content（在上下边距之间）。
  return (
    `<div class="op-page-wrap"><div class="op-page" data-page="${page.pageNo}">` +
    wm +
    renderSection('op-header', page.header) +
    `<div class="op-content">` +
    renderSection('op-body', page.body) +
    (page.gridLines ? renderGridLines(page.gridLines) : '') +
    `</div>` +
    renderSection('op-footer', page.footer) +
    `</div></div>`
  )
}

/* ------------------------------- 文档装配 ------------------------------ */

export interface RenderHtmlOptions extends CssOptions {
  /** 生成完整 HTML 文档（含 head/style）；false 时只返回 `.op-doc` 片段 */
  fullDocument?: boolean
  /** 文档标题（打印时可能作为默认文件名） */
  title?: string
  /** 打印后自动关闭窗口（无头/新窗口打印场景用） */
  autoPrint?: boolean
}

/** 只输出内容片段（宿主页面自行注入样式时用） */
export function renderFragment(result: LayoutResult, watermark?: WatermarkConfig | null): string {
  return `<div class="op-doc">${result.pages.map((p) => renderPage(p, watermark)).join('')}</div>`
}

/** 输出完整可独立打开 / 打印的 HTML 文档 */
export function renderHtml(result: LayoutResult, options: RenderHtmlOptions = {}): string {
  const css = generateCss(result.metrics, { hasMath: layoutHasMath(result), ...options })
  const fragment = renderFragment(result, options.pageDecoration?.watermark)

  if (options.fullDocument === false) return fragment

  const autoPrint = options.autoPrint
    ? '<script>window.addEventListener("load",function(){window.focus();window.print()})</script>'
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title ?? 'OpenPrint')}</title>
<style>${css}</style>
</head>
<body>
${fragment}
${autoPrint}
</body>
</html>`
}

/** 供预览面板单独取样式用（iframe 里换缩放不必重算 HTML） */
export function renderStyle(result: LayoutResult, options: CssOptions = {}): string {
  return generateCss(result.metrics, { hasMath: layoutHasMath(result), ...options })
}
