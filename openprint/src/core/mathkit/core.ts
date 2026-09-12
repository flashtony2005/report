/**
 * mathkit/core —— 公式渲染的纯逻辑层（**不 import katex**）
 *
 * katex 实例由调用方注入，这样两条使用路径能共用同一份渲染逻辑：
 *
 * | 入口 | 使用者 | katex 加载方式 | CSS |
 * |------|--------|----------------|-----|
 * | `mathkit/index` | 设计器画布（MathViewLayer） | 静态 import（同步） | 静态注入 katex.min.css |
 * | `mathkit/async` | 排版引擎 / SDK | **动态 import（按需）** | 由 css-generator 按需注入 |
 *
 * 之所以要拆：KaTeX 含 60 个字体文件，静态引入会让 SDK 凭空多出约 1.4 MB
 * （lib 打包时字体会被 base64 内联进 CSS）。拆开后，模板里没有公式控件的场景
 * 完全不会下载 KaTeX。
 */
import type { MathControl } from '@/types/control'

/** 默认字号（pt） */
export const DEFAULT_FONT_SIZE = 16

/** 默认颜色 */
export const DEFAULT_COLOR = '#000000'

/** KaTeX 的最小接口 —— 只取本文件需要的部分，便于解耦与测试 */
export interface KatexLike {
  renderToString(
    latex: string,
    options: { displayMode: boolean; throwOnError: boolean; output: 'html' },
  ): string
}

/** MathControl → KaTeX 渲染后的 HTML 字符串 */
export function renderMathControlWith(control: MathControl, katex: KatexLike): string {
  return renderMathHtmlWith(
    control.latex ?? '',
    control.displayMode ?? true,
    control.fontSize ?? DEFAULT_FONT_SIZE,
    control.color ?? DEFAULT_COLOR,
    katex,
  )
}

/**
 * 渲染 LaTeX 为 KaTeX HTML。
 *
 * 返回的 HTML 包含 KaTeX 内联 class（katex / katex-display / katex-mathml 等），
 * 其布局完全依赖 KaTeX 的 CSS —— 调用方需自行保证样式已注入。
 *
 * throwOnError:false —— 语法错误时渲染红色错误提示，而非抛异常。
 */
export function renderMathHtmlWith(
  latex: string,
  displayMode: boolean,
  fontSize: number,
  color: string,
  katex: KatexLike,
): string {
  if (!latex?.trim()) {
    return `<div style="font-size:${fontSize}pt;color:#999;text-align:center">公式预览（输入 LaTeX 源码）</div>`
  }
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    })
    return `<div style="font-size:${fontSize}pt;color:${color};text-align:${displayMode ? 'center' : 'left'}">${html}</div>`
  } catch (e) {
    return `<div style="font-size:${fontSize}pt;color:#e53935;text-align:center">公式渲染失败：${e instanceof Error ? e.message : String(e)}</div>`
  }
}
