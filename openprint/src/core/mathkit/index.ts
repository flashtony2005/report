/**
 * mathkit/index —— 同步入口（**仅供设计器使用**）
 *
 * 这里静态 import katex 及其 CSS，因为设计器画布的 MathViewLayer 必须在
 * `computed` 里同步拿到 HTML，没有 await 的机会。设计器本来就是个大应用，
 * 多这点体积无所谓。
 *
 * ⚠️ 引擎 / SDK 请用 `mathkit/async` —— 那边是动态加载，模板没有公式控件时
 *    不会下载 KaTeX（省约 1.4 MB）。
 */
import katex from 'katex'
import type { MathControl } from '@/types/control'
import {
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  renderMathControlWith,
  renderMathHtmlWith,
} from './core'

/** KaTeX CSS（设计期画布需要，导入时自动注入） */
import 'katex/dist/katex.min.css'

export type { MathControl }
export { DEFAULT_COLOR, DEFAULT_FONT_SIZE }

/** MathControl → HTML 字符串（同步，一步到位） */
export function renderMathControl(control: MathControl): string {
  return renderMathControlWith(control, katex)
}

/** 渲染 LaTeX 为 KaTeX HTML（同步） */
export function renderMathHtml(
  latex: string,
  displayMode: boolean,
  fontSize: number,
  color: string,
): string {
  return renderMathHtmlWith(latex, displayMode, fontSize, color, katex)
}
