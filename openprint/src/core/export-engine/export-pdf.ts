/**
 * PDF 导出 —— jsPDF 动态 import（不进主包）
 *
 * ## 位图底图默认 PNG（无损 · 最清晰）
 * 早期为压体积改过 JPEG，但纯文字/线条在白底上即使 quality=1 也会被 8×8 DCT
 * 引入极轻环状伪影，300dpi 打印放大后边缘发虚、不如 PNG 锐利。
 * 现回归 PNG（无损）：以体积换清晰度，导出/打印文字边缘真正锐利。
 * 体积敏感场景可传 `imageType: 'jpeg'`，但默认走 PNG 保清晰。
 *
 * ## 图表走矢量（svg2pdf）
 * 设计器一切以 SVG 为真相源。为让图表在 PDF 里达到「印刷级矢量」：
 * 1. 每页先**剥离 chart 控件** → 栅格化（文本/表格位图底图）→ addImage 作背景；
 * 2. 再遍历该页 chart 节点，把 SVG 里的 `<text>` 用 opentype.js 展开为**矢量字形轮廓**，
 *    再用 `svg2pdf` 把其 SVG 以**矢量**注入 jsPDF 对应 mm 盒；
 *    （关键：jsPDF 只能内嵌 TrueType 字体、无法内嵌 CFF/OpenType，而思源宋体恰为 CFF，
 *     直接注册会静默失败导致中文标签空白——转轮廓后文字与字体完全解耦，中文必现。）
 *
 * 兜底：
 * - 图表被旋转 → 整页退回旧的全栅格化（旋转在矢量叠加里不易对齐）；
 * - 单个图表矢量失败/字形展开失败 → 该图表单独栅格化后叠加（图表保持 PNG 以保边缘锐利）；
 * - 整页矢量叠加彻底失败 → 整页退回全栅格化（仍是位图，但保证有图）。
 *
 * 非图表页（无 chart 控件）仍走原全栅格化位图路径，行为与旧版一致。
 */
import type { LayoutResult, LayoutPage, PlacedNode, PlacedControl } from '@/core/layout-engine/types'
import { pageToImageBlob, buildPageSvg, svgToCanvas } from './rasterize'
import { embedFontsInSvg, type FontFaceDef } from './fonts'
import type { PageDecoration } from '@/types/template'
import { blobToDataURL } from './util'
import { mmv } from '@/core/renderer-html/css-generator'
import { dpiToScale } from '@/core/units'
import { outlineChartSvgText } from './chart-svg-to-path'

/** 思源宋体 —— 位图底图（含非图表文本）内联字体，保证中文衬线效果 */
const PDF_FONTS: FontFaceDef[] = [
  { family: '思源宋体', src: '/fonts/SourceHanSerifCN-Regular.ttf', weight: 400 },
]

export interface PdfOptions {
  /**
   * 渲染分辨率（DPI）：按打印机实际 DPI 栅格化（内部换算 scale = dpi / 96），
   * 与打印端分辨率一致可避免客户端二次重采样导致「打不准」。
   * 与 `scale` 同时给出时 **dpi 优先**；两者都缺省回退 scale 3（288dpi）。
   * 注意：实际倍率还会被 canvas 面积护栏下调（页面 mm 尺寸不变，仅降分辨率）。
   */
  dpi?: number
  /** 高清倍率，1=96dpi / 2=192dpi / 3=288dpi（默认·最高清），可传 4 更锐；被 dpi 覆盖 */
  scale?: number
  /** 页面装饰（背景色 + 水印），使 PDF 与预览一致 */
  pageDecoration?: PageDecoration
  /**
   * 位图底图的压缩格式（默认 `'png'`，无损最清晰）：
   * - `'png'`：无损，文字/线条边缘真正锐利，打印推荐；体积较大（纯文字页 ~10+ MB）。
   * - `'jpeg'`：体积小（~1-2 MB），仅体积敏感场景使用，清晰度略逊于 PNG。
   * 图表矢量叠加路径不受影响（图表本身走 svg2pdf 矢量注入）。
   */
  imageType?: 'jpeg' | 'png'
  /**
   * 逐页栅格化进度回调。`current` 从 1 起，`total` 为总页数。
   * 每完成一页调用一次（在 addImage / 矢量叠加之后），供上层推进进度条。
   */
  onPage?: (current: number, total: number) => void
}

/** 把 PdfOptions 的 imageType 解析成 canvas.toBlob 的 MIME 与 addImage 的格式名 */
function imgSpec(imageType: 'jpeg' | 'png'): { mime: 'image/jpeg' | 'image/png'; addImageFmt: 'JPEG' | 'PNG' } {
  return imageType === 'png'
    ? { mime: 'image/png', addImageFmt: 'PNG' }
    : { mime: 'image/jpeg', addImageFmt: 'JPEG' }
}

function isChartNode(n: PlacedNode): n is PlacedControl {
  return n.kind === 'control' && (n as PlacedControl).control.type === 'chart'
}

/** 返回去掉所有 chart 控件后的页面副本（不影响原对象） */
function stripCharts(page: LayoutPage): LayoutPage {
  const f = <T extends PlacedNode>(nodes: T[]): T[] => nodes.filter((n) => !isChartNode(n)) as T[]
  return { ...page, header: f(page.header), body: f(page.body), footer: f(page.footer) }
}

interface ChartBox {
  left: number
  top: number
  width: number
  height: number
  angle: number
  svg: string
}

/** 收集页面内所有 chart 控件（含其 mm 盒与 SVG） */
function chartsOf(page: LayoutPage): ChartBox[] {
  const out: ChartBox[] = []
  for (const sec of [page.header, page.body, page.footer]) {
    for (const n of sec) {
      if (!isChartNode(n)) continue
      const c = n as PlacedControl
      if (c.content.kind !== 'svg') continue
      out.push({
        left: n.left,
        top: n.top,
        width: n.width,
        height: n.height,
        angle: n.angle ?? 0,
        svg: c.content.svg,
      })
    }
  }
  return out
}

/** 单图表栅格化（svg2pdf 失败时的兜底，保证不丢图） */
async function rasterizeChart(chartSvg: string, wMm: number, hMm: number, scale: number): Promise<string> {
  const inner = `<div style="width:${mmv(wMm)};height:${mmv(hMm)};overflow:hidden">${chartSvg}</div>`
  let svg = buildPageSvg(inner, '', wMm, hMm)
  svg = await embedFontsInSvg(svg, PDF_FONTS)
  const canvas = await svgToCanvas(svg, scale, '#ffffff')
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
  if (!blob) throw new Error('图表栅格化失败')
  return blobToDataURL(blob)
}

/** SVG 字符串 → 挂到 DOM 的 SVGSVGElement（svg2pdf 需要真实节点以读取几何） */
function svgElementFromString(str: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(str, 'image/svg+xml')
  return doc.documentElement as unknown as SVGSVGElement
}

export async function documentToPdf(result: LayoutResult, opts: PdfOptions = {}): Promise<Blob> {
  const mod = await import('jspdf')
  const JsPDF = (mod as unknown as { jsPDF?: typeof mod.default; default: typeof mod.default }).jsPDF ?? mod.default
  const { pageWidth: w, pageHeight: h } = result.metrics
  const orientation = w > h ? 'landscape' : 'portrait'
  // dpi 优先：按打印机实际分辨率栅格化（scale = dpi / 96）；无 dpi 再看 scale，缺省 3（288dpi）
  const scale = opts.dpi && opts.dpi > 0 ? dpiToScale(opts.dpi) : (opts.scale ?? 3)
  const imageType: 'jpeg' | 'png' = opts.imageType ?? 'png'
  const { addImageFmt } = imgSpec(imageType)

  const doc = new JsPDF({ unit: 'mm', format: [w, h], orientation })

  for (let i = 0; i < result.pages.length; i++) {
    if (i > 0) doc.addPage([w, h], orientation)

    const page = result.pages[i]!
    const charts = chartsOf(page)
    // 有图表且该页图表都未旋转 → 走矢量；否则全栅格化（含图表）
    const useVector = charts.length > 0 && charts.every((c) => c.angle === 0)

    if (!useVector) {
      const dataUrl = await rasterizePageFull(result, i, scale, opts.pageDecoration, imageType)
      doc.addImage(dataUrl, addImageFmt, 0, 0, w, h)
      continue
    }

    // 矢量路径：先栅格化"剥掉图表"的底图，再把图表以矢量叠加（文字已转轮廓，无需内嵌字体）
    const strippedResult: LayoutResult = {
      ...result,
      pages: result.pages.map((p, idx) => (idx === i ? stripCharts(p) : p)),
    }
    const baseUrl = await rasterizePageFull(strippedResult, i, scale, opts.pageDecoration, imageType)
    doc.addImage(baseUrl, addImageFmt, 0, 0, w, h)

    let allVectorOk = true
    for (const ch of charts) {
      try {
        // 字形转轮廓：把 <text> 展开为矢量 path，避免 jsPDF 无法内嵌 CFF 字体导致中文空白
        const outlinedSvg = await outlineChartSvgText(ch.svg)
        const el = svgElementFromString(outlinedSvg)
        el.style.position = 'absolute'
        el.style.left = '-99999px'
        el.style.top = '0'
        document.body.appendChild(el)
        try {
          const { svg2pdf } = await import('svg2pdf.js')
          await svg2pdf(el, doc, { x: ch.left, y: ch.top, width: ch.width, height: ch.height })
        } finally {
          document.body.removeChild(el)
        }
      } catch {
        // 该图表矢量失败 → 单独栅格化兜底（图表保持 PNG 以保边缘锐利，体积可控）
        try {
          const img = await rasterizeChart(ch.svg, ch.width, ch.height, scale)
          doc.addImage(img, 'PNG', ch.left, ch.top, ch.width, ch.height)
        } catch {
          allVectorOk = false
        }
      }
    }

    // 兜底：若整页矢量叠加彻底失败，重渲染该页（含图表）作位图背景
    if (!allVectorOk) {
      // 当前页已 addImage 了"剥图底图"，需替换为含图表的整页位图。
      // 顺序处理下最后一页动作即本页，删除后重建即可，不影响其它页。
      const pageCount = doc.getNumberOfPages()
      doc.deletePage(pageCount)
      doc.addPage([w, h], orientation)
      const fallback = await rasterizePageFull(result, i, scale, opts.pageDecoration, imageType)
      doc.addImage(fallback, addImageFmt, 0, 0, w, h)
    }

    // 每完成一页回调一次（current 从 1 起），上层据此推进进度条
    opts.onPage?.(i + 1, result.pages.length)
  }

  return doc.output('blob')
}

/** 整页栅格化（含图表），封装原 pageToImageBlob 调用 */
async function rasterizePageFull(
  result: LayoutResult,
  index: number,
  scale: number,
  pageDecoration: PageDecoration | undefined,
  imageType: 'jpeg' | 'png',
): Promise<string> {
  const { mime } = imgSpec(imageType)
  const blob = await pageToImageBlob(result, index, {
    type: mime,
    scale,
    background: pageDecoration?.backgroundColor ?? '#ffffff',
    fonts: PDF_FONTS,
    pageDecoration,
  })
  return blobToDataURL(blob)
}
