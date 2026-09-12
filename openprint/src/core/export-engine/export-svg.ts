/**
 * SVG 矢量导出 —— 把多页 HTML 直接包进嵌套 <svg><foreignObject>
 *
 * 产物是单文件、多页纵向堆叠的 SVG（每页一个 `<svg x y>`），
 * 浏览器 / Inkscape / 矢量软件都能打开，且因为是同一份 HTML+CSS，
 * 与预览、PDF、打印视觉完全一致。
 */
import { mmToPx } from '@/core/units'
import { renderPage, generateCss } from '@/core/renderer-html'
import type { LayoutResult } from '@/core/layout-engine/types'
import { layoutHasMath } from '@/core/layout-engine/control-scan'
import type { PageDecoration } from '@/types/template'
import { toXmlSafe } from './rasterize'
import { embedFontsInSvg, type FontFaceDef } from './fonts'

export async function documentToSvgString(
  result: LayoutResult,
  fonts?: FontFaceDef[],
  pageDecoration?: PageDecoration,
): Promise<string> {
  const { pageWidth, pageHeight } = result.metrics
  const w = Math.max(1, Math.ceil(mmToPx(pageWidth)))
  const h = Math.max(1, Math.ceil(mmToPx(pageHeight)))
  const css = generateCss(result.metrics, {
    screen: false,
    pageDecoration,
    hasMath: layoutHasMath(result),
  })

  const pages = result.pages
    .map((page, i) => {
      const safe = toXmlSafe(renderPage(page, pageDecoration?.watermark))
      const inner =
        `<div xmlns="http://www.w3.org/1999/xhtml">` +
        `<style>${css}</style>` +
        `<div class="op-doc"><div class="op-page-wrap">${safe}</div></div>` +
        `</div>`
      return (
        `<svg x="0" y="${i * h}" width="${w}" height="${h}">` +
        `<foreignObject x="0" y="0" width="${w}" height="${h}">${inner}</foreignObject>` +
        `</svg>`
      )
    })
    .join('\n')

  const totalH = h * result.pages.length
  let svg = (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}">` +
    `<rect x="0" y="0" width="${w}" height="${totalH}" fill="#ffffff"/>` +
    pages +
    `</svg>`
  )
  if (fonts?.length) svg = await embedFontsInSvg(svg, fonts)
  return svg
}
