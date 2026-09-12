/**
 * katex-css —— KaTeX 样式与字体资源（供预览 iframe / 导出栅格化复用）
 *
 * KaTeX 渲染产物是 HTML + 一整套 class + web fonts，其布局/定位完全依赖 katex.min.css。
 * 设计期主应用已通过 `import 'katex/dist/katex.min.css'` 拿到样式；
 * 但预览 iframe（独立文档）与导出 SVG（隔离上下文）看不到主应用的 CSS，
 * 必须把 KaTeX CSS 作为字符串注入到它们的 `<style>` 里。
 *
 * 因此这里把 katex.min.css 当字符串读入，拆成两部分：
 * - KATEX_STYLE_CSS：去掉所有 `@font-face` 后的「样式规则」（布局/定位），两者都要
 * - KATEX_FONT_CSS：仅 `@font-face` 规则，字体路径改写到公共目录 `/fonts/katex/*.woff2`
 *
 * 用法：
 * - 预览（screen:true）：两份都注入（iframe 同源可加载 /fonts/katex/*.woff2）
 * - 导出栅格化（screen:false）：只注入 KATEX_STYLE_CSS，字体改由 embedFontsInSvg
 *   以 data-URI 注入，避免 SVG(data:) 上下文里无法解析绝对 URL 的字体。
 */
import katexCssRaw from './katex-bundled.css.txt?raw'
import type { FontFaceDef } from '@/core/export-engine/fonts'

/** 把相对字体路径 url(fonts/...) 改写为公共目录绝对路径 /fonts/katex/... */
const KATEX_CSS = katexCssRaw.replace(/url\(\s*['"]?\s*fonts\//g, 'url(/fonts/katex/')

/** KaTeX 样式规则（不含 @font-face）：预览 + 导出栅格化都要 */
export const KATEX_STYLE_CSS = KATEX_CSS.replace(/@font-face\s*\{[^}]*\}/g, '')

/** KaTeX @font-face 规则（字体走公共目录）：仅预览（同源 iframe）使用 */
export const KATEX_FONT_CSS = (KATEX_CSS.match(/@font-face\s*\{[^}]*\}/g) ?? []).join('\n')

/** 导出栅格化时注入的 KaTeX 字体清单（woff2 同源公共路径，由 embedFontsInSvg 转 data-URI） */
export const KATEX_FONT_DEFS: FontFaceDef[] = [
  { family: 'KaTeX_AMS', src: '/fonts/katex/KaTeX_AMS-Regular.woff2' },
  { family: 'KaTeX_Caligraphic', src: '/fonts/katex/KaTeX_Caligraphic-Bold.woff2', weight: 'bold' },
  { family: 'KaTeX_Caligraphic', src: '/fonts/katex/KaTeX_Caligraphic-Regular.woff2' },
  { family: 'KaTeX_Fraktur', src: '/fonts/katex/KaTeX_Fraktur-Bold.woff2', weight: 'bold' },
  { family: 'KaTeX_Fraktur', src: '/fonts/katex/KaTeX_Fraktur-Regular.woff2' },
  { family: 'KaTeX_Main', src: '/fonts/katex/KaTeX_Main-Bold.woff2', weight: 'bold' },
  { family: 'KaTeX_Main', src: '/fonts/katex/KaTeX_Main-BoldItalic.woff2', weight: 'bold', style: 'italic' },
  { family: 'KaTeX_Main', src: '/fonts/katex/KaTeX_Main-Italic.woff2', style: 'italic' },
  { family: 'KaTeX_Main', src: '/fonts/katex/KaTeX_Main-Regular.woff2' },
  { family: 'KaTeX_Math', src: '/fonts/katex/KaTeX_Math-BoldItalic.woff2', weight: 'bold', style: 'italic' },
  { family: 'KaTeX_Math', src: '/fonts/katex/KaTeX_Math-Italic.woff2', style: 'italic' },
  { family: 'KaTeX_SansSerif', src: '/fonts/katex/KaTeX_SansSerif-Bold.woff2', weight: 'bold' },
  { family: 'KaTeX_SansSerif', src: '/fonts/katex/KaTeX_SansSerif-Italic.woff2', style: 'italic' },
  { family: 'KaTeX_SansSerif', src: '/fonts/katex/KaTeX_SansSerif-Regular.woff2' },
  { family: 'KaTeX_Script', src: '/fonts/katex/KaTeX_Script-Regular.woff2' },
  { family: 'KaTeX_Size1', src: '/fonts/katex/KaTeX_Size1-Regular.woff2' },
  { family: 'KaTeX_Size2', src: '/fonts/katex/KaTeX_Size2-Regular.woff2' },
  { family: 'KaTeX_Size3', src: '/fonts/katex/KaTeX_Size3-Regular.woff2' },
  { family: 'KaTeX_Size4', src: '/fonts/katex/KaTeX_Size4-Regular.woff2' },
  { family: 'KaTeX_Typewriter', src: '/fonts/katex/KaTeX_Typewriter-Regular.woff2' },
]
