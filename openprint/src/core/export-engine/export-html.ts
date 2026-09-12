/**
 * HTML 导出 —— 自包含 HTML 单文件（矢量、零外部引用）
 *
 * 与打印 HTML 载荷同源（`renderHtml({ screen:false })` 打印态 CSS），但语义不同：
 * 导出文件要在**任意浏览器/机器**上打开，不假定对方装了思源字体，因此**默认内联字体**
 * （与打印载荷的"默认不内联"相反）。KaTeX 公式字体始终强制内联。
 */
import type { RenderRequest } from '@/core/sdk'
import type { LayoutResult } from '@/core/layout-engine/types'
import { renderHtml } from '@/core/renderer-html'
import { embedFontsInHtml, type FontFaceDef } from './fonts'
import { templateUsedFonts, toExportFontDefs } from '@/core/fonts/loader'
import { KATEX_FONT_DEFS } from '@/core/mathkit/katex-css'

export interface ExportHtmlOptions {
  /**
   * 字体内联清单。显式传入时优先于 `embedFonts` 开关。
   * 缺省 = 模板文本控件实际用到的内置字体（`templateUsedFonts`）+ KaTeX 字体（含公式时）。
   */
  fonts?: FontFaceDef[]
  /**
   * 是否内联字体（**默认 `true`**——导出文件需自包含，任意环境打开不丢字体）。
   * 接收方环境确定装了对应字体（如仅本机归档）时可传 `false` 减小体积。
   * KaTeX 公式字体不受此开关影响，始终强制内联。
   */
  embedFonts?: boolean
}

/**
 * 布局结果 → 自包含 HTML 字符串。供 `exportDocument(_, 'html')` 使用。
 */
export async function documentToHtml(
  request: RenderRequest,
  result: LayoutResult,
  options: ExportHtmlOptions = {},
): Promise<string> {
  const deco = request.output?.pageDecoration
  let html = renderHtml(result, { screen: false, pageDecoration: deco })

  // 字体策略（优先级）：显式 fonts > embedFonts 开关（默认 true）。
  let defs: FontFaceDef[]
  if (options.fonts) {
    defs = options.fonts
  } else if (options.embedFonts === false) {
    defs = []
  } else {
    defs = toExportFontDefs(templateUsedFonts(request.template))
  }
  // KaTeX 字形无系统兜底，始终强制内联
  const hasKatexFonts = defs.some((d) => d.src.includes('katex'))
  if (html.includes('katex') && !hasKatexFonts) {
    defs = [...defs, ...KATEX_FONT_DEFS]
  }
  if (defs.length) html = await embedFontsInHtml(html, defs)
  return html
}
