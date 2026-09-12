/**
 * mathkit/async —— 按需加载入口（**引擎 / SDK 专用**）
 *
 * 与 `mathkit/index`（同步版）的区别：
 * - katex 走动态 import + Promise 缓存 → 模板里没有公式控件就完全不下载
 * - **不** import katex.min.css → 避免 lib 打包时 60 个字体被 base64 内联成 1.4 MB CSS
 *   （渲染端的样式由 `css-generator` 按需注入，见那里对 math 控件的判定）
 *
 * 渲染逻辑本身与同步版共用 `./core`，两边结果保证一致。
 */
import type { MathControl } from '@/types/control'
import { renderMathControlWith } from './core'

type KatexModule = typeof import('katex')

let katexPromise: Promise<KatexModule> | null = null

/** 加载 katex（带缓存，同一会话内只解析一次模块） */
function loadKatex(): Promise<KatexModule> {
  katexPromise ??= import('katex')
  return katexPromise
}

/** MathControl → HTML 字符串（异步，KaTeX 按需加载） */
export async function renderMathControlAsync(control: MathControl): Promise<string> {
  const katex = (await loadKatex()).default
  return renderMathControlWith(control, katex)
}

export { renderMathControlWith }
