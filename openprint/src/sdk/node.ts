/**
 * OpenPrint SDK —— Node 服务端入口
 *
 * 只做「模板 + 数据 → HTML」，不碰任何浏览器 API，可在 Node 里批量跑。
 *
 * ## 能做什么
 * - 排版 + 生成 HTML（纯字符串拼接，零 DOM）
 * - 把 HTML 交给 puppeteer / wkhtmltopdf 转 PDF
 *
 * ## 不能做什么
 * - **导出 PDF / JPG**：栅格化依赖 canvas + foreignObject，Node 无 DOM 跑不了
 *   （要用导出请走浏览器端 `openprint26/sdk`）
 * - **静默打印**：需要先生成 PDF，同样依赖浏览器
 *
 * ## 用法
 * ```ts
 * import { render } from 'openprint26/node'
 *
 * const { html, pages, warnings } = await render({ template, data })
 * ```
 *
 * ## 精度说明
 * 文本测量在无 DOM 时走 **CJK 感知的字符宽度估算**（见 layout-engine/measure.ts），
 * 与浏览器真实排版存在偏差。对分页敏感的模板，建议在浏览器端产出或自行校准。
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

export type { LayoutResult, LayoutPage, RenderWarning } from '@/core/layout-engine/types'
export type { TemplateData } from '@/types/template'
export type { AnyControl } from '@/types/control'
