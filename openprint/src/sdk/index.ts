/**
 * OpenPrint SDK —— 浏览器端入口
 *
 * 面向「想在自己项目里直接渲染 / 导出 / 打印 OpenPrint 模板」的使用者。
 * 纯浏览器环境（需要 DOM）：导出 PDF 走 SVG foreignObject 栅格化，Node 端跑不了。
 *
 * ## 最简用法
 * ```ts
 * import { render } from 'openprint26/sdk'
 *
 * const { html, pages, warnings } = await render({
 *   template: templateJson,   // 设计器导出的模板 JSON
 *   data: { name: '张三', no: 'SF123' },
 * })
 * document.getElementById('preview').innerHTML = html
 * ```
 *
 * ## 导出 PDF / JPG / SVG
 * ```ts
 * import { createHeadless } from 'openprint26/sdk'
 *
 * const h = createHeadless()
 * const { blobs, filenames } = await h.exportPdf({ template, data })
 * h.dispose()
 * ```
 *
 * ## 体积
 * 核心约 162 kB（gzip ~46 kB）。条码（bwip-js）、二维码（qrcode）、公式（KaTeX）
 * 均为**按需加载** —— 模板里没有对应控件就不会下载。jspdf / opentype / html2canvas
 * 同样按需，只在调用导出时才拉取。
 */
export { render, renderDocument, dispose } from '@/core/sdk'
export type { RenderRequest, RenderResponse, LayoutOptions, RenderHtmlOptions } from '@/core/sdk'

export {
  escapeHtml,
  renderFragment,
  renderHtml,
  renderPage,
  renderStyle,
  generateCss,
  mmv,
  type CssOptions,
} from '@/core/renderer-html'
export { FILTERS } from '@/core/layout-engine/expression'
export { createHeadless } from '@/core/headless'
export type {
  HeadlessOptions,
  HeadlessRequest,
  HeadlessInstance,
  HeadlessExportOptions,
} from '@/core/headless'

export { loadFonts, embedFontsInHtml, embedFontsInSvg } from '@/core/headless'

export { exportDocument } from '@/core/export-engine'
export type { ExportFormat, ExportOptions, ExportOutcome } from '@/core/export-engine'
export type { FontFaceDef } from '@/core/export-engine/fonts'

export {
  DEFAULT_PRINTER_BASE_URL,
  FALLBACK_PRINT_DPI,
  MIN_PRINT_DPI,
  checkHealth,
  listPrinters,
  submitPrintJob,
  generateJobId,
  buildPrintPayload,
  printDocument,
  formatPayloadSize,
  blobToBase64,
  resolvePrintDpi,
  clampDpi,
  resolvePrintOrientation,
  listSystemFonts,
  PrintClientError,
  describePrintError,
  // 客户端本地数据库（打印客户端可直连本机数据源取数）
  listClientDatabases,
  listClientTables,
  listClientColumns,
  fetchClientRows,
} from '@/core/print-client'
export type {
  PrinterHealth,
  PrinterInfo,
  PrinterState,
  PrinterKind,
  PrintJobRequest,
  PrintJobResponse,
  PrintPayload,
  BuildPrintPayloadOptions,
  PrintDocumentOptions,
  OrientationPref,
  SystemFontEntry,
  ClientDatabase,
  ClientTable,
  ClientColumn,
  ClientDataQuery,
} from '@/core/print-client'

export type { LayoutResult, LayoutPage, RenderWarning } from '@/core/layout-engine/types'
export type { TemplateData } from '@/types/template'
export type { AnyControl } from '@/types/control'
