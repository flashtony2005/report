/**
 * Export Engine —— 三格式导出（PDF / JPG / SVG）
 *
 * 纯 TypeScript、零框架依赖（与 designer-vue 解耦，headless 阶段可直接复用）。
 * 真相来源统一是 `sdk.render()` 的 HTML 产物，因此：
 *   - 预览 = 打印 = 导出 三者视觉一致
 *   - 支持数据绑定 + 超长表格分页 + 中文（系统字体）
 *
 * 导出语义：
 * - PDF：单文件、多页（位图 PDF，思源宋体内联）
 * - JPG：每页一个文件（多页时按 `name-1.jpg` 命名）
 * - SVG：单文件、多页纵向堆叠（矢量，含 foreignObject）
 * - HTML：单文件、多页纵向（矢量、自包含，默认内联字体，任意浏览器可打开）
 */
import type { RenderRequest } from '@/core/sdk'
import { render } from '@/core/sdk'
import type { LayoutResult } from '@/core/layout-engine/types'
import { documentToPdf } from './export-pdf'
import { documentToSvgString } from './export-svg'
import { documentToHtml } from './export-html'
import { pageToJpg } from './export-image'
import { downloadBlob } from './util'
import type { FontFaceDef } from './fonts'
import { qualityToScale, type PrintQuality } from '@/core/quality'

export type { FontFaceDef } from './fonts'

export type ExportFormat = 'pdf' | 'jpg' | 'svg' | 'html'

export interface ExportOptions {
  /** 高清倍率 1/2/3（默认 3·288dpi·最高清），可传 4 更锐；被 quality 覆盖 */
  scale?: number
  /**
   * 清晰度预设（语义化，推荐）：`low`=96dpi / `medium`=192dpi / `high`=288dpi。
   * 比裸 `scale` 更直观；被显式 `scale` 覆盖。文件导出无打印机概念，不传则取 high。
   */
  quality?: PrintQuality
  /** 文件名（不含扩展名）；多页 JPG 会追加 -页码 */
  filename?: string
  /** 位图背景色，默认白 */
  background?: string
  /** 自定义字体（同源 URL），嵌入 JPG/SVG 栅格化产物使导出不丢字体；html 导出时为内联清单 */
  fonts?: FontFaceDef[]
  /**
   * PDF 位图底图压缩格式（仅 PDF 导出生效，默认 `'png'` 无损最清晰）：
   * - `'png'`：无损，文字/线条边缘锐利，打印推荐；
   * - `'jpeg'`：体积小，仅体积敏感场景。
   */
  pdfImageType?: 'jpeg' | 'png'
  /**
   * 是否内联字体（仅 html 导出生效，**默认 `true`**——导出文件需自包含，任意环境打开不丢字体）。
   * KaTeX 公式字体始终强制内联。
   */
  embedFonts?: boolean
}

export interface ExportOutcome {
  blobs: Blob[]
  filenames: string[]
  mime: string
}

/**
 * 渲染 + 导出一站式入口。PDF/SVG 单文件多页，JPG 每页一个文件。
 * 调用方逐一下载即可。
 */
export async function exportDocument(
  request: RenderRequest,
  format: ExportFormat,
  options: ExportOptions = {},
): Promise<ExportOutcome> {
  const res = await render(request)
  const result: LayoutResult = res.result
  const name = (options.filename ?? 'openprint-document').trim() || 'openprint-document'
  const scale = options.scale ?? qualityToScale(options.quality) ?? 3
  const bg = options.background ?? '#ffffff'
  // 页面装饰（背景色 + 水印）统一来自渲染请求 output，三格式导出共享
  const deco = request.output?.pageDecoration

  if (format === 'pdf') {
    const blob = await documentToPdf(result, {
      scale,
      imageType: options.pdfImageType ?? 'png',
      pageDecoration: deco,
    })
    return { blobs: [blob], filenames: [`${name}.pdf`], mime: 'application/pdf' }
  }

  if (format === 'svg') {
    const svg = await documentToSvgString(result, options.fonts, deco)
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    return { blobs: [blob], filenames: [`${name}.svg`], mime: 'image/svg+xml' }
  }

  // HTML：单文件多页纵向（矢量、自包含，默认内联字体）
  if (format === 'html') {
    const html = await documentToHtml(request, result, {
      fonts: options.fonts,
      embedFonts: options.embedFonts,
    })
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    return { blobs: [blob], filenames: [`${name}.html`], mime: 'text/html' }
  }

  // JPG：每页一个文件
  const blobs = await Promise.all(
    result.pages.map((_, i) =>
      pageToJpg(result, i, { scale, background: bg, fonts: options.fonts, pageDecoration: deco }),
    ),
  )
  const filenames = blobs.map((_, i) =>
    blobs.length > 1 ? `${name}-${i + 1}.jpg` : `${name}.jpg`,
  )
  return { blobs, filenames, mime: 'image/jpeg' }
}

export { downloadBlob, pageToJpg, documentToSvgString, documentToPdf, documentToHtml }
export type { RenderRequest } from '@/core/sdk'
export type { LayoutResult } from '@/core/layout-engine/types'
export type { PdfOptions as ExportPdfOptions } from './export-pdf'
export type { PageImageOptions } from './rasterize'
