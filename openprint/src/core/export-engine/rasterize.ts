/**
 * 栅格化工具 —— 把单页渲染 HTML 变成位图
 *
 * ## 为什么用 SVG <foreignObject>
 *
 * 设计器/渲染引擎的"真相来源"是 `render()` 产出的 HTML/CSS（§2 单一真相源）。
 * 要把 HTML 变成 PNG/JPG，浏览器原生只有两条路：
 * 1. html2canvas 之类的库（要新依赖，且零网络铁律下不想引）
 * 2. 把 HTML 塞进 SVG 的 `<foreignObject>`，再交给 `<img>`/`canvas` 光栅化
 *
 * 这里走第 2 条：纯浏览器 API、零依赖、中文靠系统字体（PingFang SC / 思源）渲染。
 *
 * ## 已知边界
 * - `<foreignObject>` 在 Chromium / Firefox 用 `<img src=svg>` 光栅化是支持的；
 *   Safari 出于安全限制**不支持** img 里的 foreignObject，需要换 html2canvas 才能覆盖。
 *   当前目标浏览器为 Chromium 内核，足够。
 * - 内嵌资源必须同源或 data URI（本设计器图片已走 data URI，条码/二维码是内联 SVG）。
 */
import { mmToPx } from '@/core/units'
import { renderPage, generateCss } from '@/core/renderer-html'
import type { LayoutResult } from '@/core/layout-engine/types'
import { layoutHasMath } from '@/core/layout-engine/control-scan'
import type { PageDecoration } from '@/types/template'
import { embedFontsInSvg, type FontFaceDef } from './fonts'
import { KATEX_FONT_DEFS } from '@/core/mathkit/katex-css'

/** HTML 转 XML 安全的 void 标签集合（foreignObject 走 XML 解析，未闭合会整页渲染失败） */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * 把渲染产物里可能出现的不规范 HTML 修成 XML 安全：
 * - void 标签补自闭合 `/>`
 * - 内嵌 `<svg>` 确保带 SVG 命名空间（否则 XHTML 命名空间下不渲染）
 */
export function toXmlSafe(html: string): string {
  const fixed = html.replace(
    /<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*>/g,
    (m, tag: string, attrs: string) => {
      const t = tag.toLowerCase()
      if (VOID_TAGS.has(t)) {
        const clean = attrs.replace(/\/\s*$/, '')
        return `<${t}${clean} />`
      }
      return m
    },
  )
  // 给缺命名空间的内嵌 svg 补上（负向预查：后面到 > 之间不含 xmlns= 才补）
  return fixed.replace(/<svg(?![^>]*\bxmlns=)/g, '<svg xmlns="http://www.w3.org/2000/svg"')
}

/** 单页 HTML + 样式 → 可直接光栅化的 SVG 字符串 */
export function buildPageSvg(
  pageHtml: string,
  css: string,
  pageWidthMm: number,
  pageHeightMm: number,
): string {
  const w = Math.max(1, Math.ceil(mmToPx(pageWidthMm)))
  const h = Math.max(1, Math.ceil(mmToPx(pageHeightMm)))
  const safe = toXmlSafe(pageHtml)
  const inner =
    `<div xmlns="http://www.w3.org/1999/xhtml">` +
    `<style>${css}</style>` +
    `<div class="op-doc"><div class="op-page-wrap">${safe}</div></div>` +
    `</div>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${inner}</foreignObject>` +
    `</svg>`
  )
}

/** SVG 光栅化超时（ms）：部分环境对 <foreignObject> 支持差 / onload 永不触发，
 * 超时则降级返回白底空 canvas，不让单页失败拖垮整份导出。 */
const SVG_RASTER_TIMEOUT = 4000

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error('SVG 光栅化超时（环境不支持 foreignObject 或资源跨域）'))
    }, SVG_RASTER_TIMEOUT)
    img.onload = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(img)
    }
    img.onerror = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error('SVG 光栅化失败（浏览器不支持 foreignObject 或资源跨域）'))
    }
    img.src = src
  })
}

/** SVG 字符串 → 高清 canvas（scale 倍图，填白底避免透明）。超时/失败时降级白底空 canvas
 *
 * ## 为什么用 data: URL 而不是 blob: URL（血泪教训，勿改回）
 * Chromium 安全策略：经 `blob:` URL 加载的、含 `<foreignObject>` 的 SVG 会被判定为
 * 「来源不纯净」，drawImage 后 canvas 被污染，toBlob/toDataURL 抛
 * "Tainted canvases may not be exported"。同一 SVG 改用 `data:` URL 加载则不污染。
 * （实测对照：blob+FO=TAINTED，blob+纯矢量=clean，data+FO=clean，data+纯矢量=clean）
 */
/** 把 SVG 根节点的显示宽高放大 scale 倍（viewBox 不变），让 foreignObject 以高分原生渲染，
 * 而不是低分渲染后再插值放大 —— 这是打印/导出文字清晰的关键。
 * 血泪：低分 SVG 渲染成位图后再 drawImage 放大 = 只是像素插值，文字发虚；
 * 放大 SVG 的 width/height（viewBox 不动）则内容矢量重排到高分画布，边缘锐利。 */
function scaleSvgViewport(svg: string, scale: number): string {
  if (!Number.isFinite(scale) || scale === 1) return svg
  return svg.replace(
    /<svg([^>]*?)\bwidth="([\d.]+)"([^>]*?)\bheight="([\d.]+)"/,
    (m, p1: string, w: string, p2: string, h: string) =>
      `<svg${p1}width="${Math.round(parseFloat(w) * scale)}"${p2}height="${Math.round(parseFloat(h) * scale)}"`,
  )
}

/**
 * canvas 安全上限（Chromium 实测约束，超限 canvas 被静默置空 → 整页空白）：
 * - 面积上限 ≈ 2.68 亿 px（16384²），留余量取 2.5 亿
 * - 单边上限 65535，留余量取 32767（兼顾 <img> 解码路径）
 * 超限时按比例下调倍率：页面物理尺寸（mm）不变，只降位图分辨率。
 */
export const MAX_CANVAS_AREA = 250_000_000
export const MAX_CANVAS_SIDE = 32767

/** 面积/边长护栏内允许的最大倍率（scale 只降不升） */
export function capScaleByArea(baseW: number, baseH: number, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 1) return Math.max(1, scale || 1)
  const w = Math.max(1, baseW)
  const h = Math.max(1, baseH)
  let max = Infinity
  const area = w * h
  if (area > 0) max = Math.min(max, Math.sqrt(MAX_CANVAS_AREA / area))
  max = Math.min(max, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h)
  return Math.max(1, Math.min(scale, max))
}

export async function svgToCanvas(svg: string, scale: number, bg: string): Promise<HTMLCanvasElement> {
  // 先读未缩放的基准尺寸，套面积/边长护栏得到有效倍率（只降不升），
  // 避免 2400dpi 等高超档位把 canvas 顶爆（Chromium 超限静默空白）
  const base = svg.match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/)
  const baseW = Math.max(1, base ? parseFloat(base[1]!) : 794)
  const baseH = Math.max(1, base ? parseFloat(base[2]!) : 1123)
  const effScale = capScaleByArea(baseW, baseH, scale)
  // 再放大 SVG 显示尺寸，再加载：img 本身就是高分位图，canvas 无需再插值放大
  const scaled = scaleSvgViewport(svg, effScale)
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(scaled)
  // fallback 尺寸从放大后的 SVG 宽高推导（取不到再用 A4×scale 兜底）
  const dim = scaled.match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/)
  const cw = Math.max(1, Math.round(dim ? parseFloat(dim[1]!) : 794 * effScale))
  const ch = Math.max(1, Math.round(dim ? parseFloat(dim[2]!) : 1123 * effScale))
  const fallback = (): HTMLCanvasElement => {
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, cw, ch)
    }
    return canvas
  }
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    // img.width/height 已是高分目标尺寸，drawImage 原样铺绘，不再缩放插值
    canvas.width = Math.max(1, img.width)
    canvas.height = Math.max(1, img.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return fallback()
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    return canvas
  } catch {
    // 环境不支持 foreignObject 光栅化（如 happy-dom）→ 降级白底空 canvas，不阻塞导出
    return fallback()
  }
}

export interface PageImageOptions {
  scale?: number
  background?: string
  type?: 'image/png' | 'image/jpeg'
  /**
   * JPEG 编码质量 0-1，默认 **1（最高清）**。
   * 注：quality=1 比 0.92 体积大约 30-60%，但仍是 PNG 的零头；
   * 对票据/报表这类对清晰度敏感的打印件值得。
   */
  quality?: number
  /** 自定义字体（同源 URL），嵌入 SVG 使栅格化产物不丢字体 */
  fonts?: FontFaceDef[]
  /** 页面装饰（背景色 + 水印），使导出与预览一致 */
  pageDecoration?: PageDecoration
}

/* ------------------------- 图片内联（防 canvas taint） ------------------------- */

/** 1×1 透明 PNG，外部图片加载失败时的降级占位（避免整页导出失败） */
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** <img> 的 src（双引号或单引号） */
const IMG_SRC_RE = /<img\b[^>]*?\bsrc=(["'])([^"']*)\1/gi
/** CSS url(...) 引用（background / @font-face 等，仅图片类会被内联） */
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi
/** SVG <image> 的 href / xlink:href */
const SVG_IMAGE_RE = /<image\b[^>]*?\b(?:xlink:)?href=(["'])([^"']*)\1/gi

async function fetchAsDataUri(src: string): Promise<{ uri: string; mime: string }> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`资源加载失败 ${src}: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return { uri: `data:${mime};base64,${btoa(bin)}`, mime }
}

/** 收集页面 HTML 里所有外部资源引用（img src / CSS url / SVG image href） */
function collectExternalSrcs(html: string): Set<string> {
  const srcs = new Set<string>()
  const add = (src: string | undefined) => {
    const s = (src ?? '').trim()
    if (!s || /^data:/i.test(s) || /^#/.test(s) || /^blob:/i.test(s)) return
    srcs.add(s)
  }
  for (const m of html.matchAll(IMG_SRC_RE)) add(m[2])
  for (const m of html.matchAll(CSS_URL_RE)) add(m[2])
  for (const m of html.matchAll(SVG_IMAGE_RE)) add(m[2])
  return srcs
}

/**
 * 把页面 HTML 里所有外部图片（http / 相对路径）内联成 data URI。
 * 否则 SVG <foreignObject> 加载跨域图片会污染 canvas，toBlob 抛
 * "Tainted canvases may not be exported"。失败/跨域图片降级为透明占位，不阻塞导出。
 */
export async function inlinePageImages(html: string): Promise<string> {
  const srcs = collectExternalSrcs(html)
  if (!srcs.size) return html

  const resolved = new Map<string, string>()
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        const { uri } = await fetchAsDataUri(src)
        resolved.set(src, uri)
      } catch {
        resolved.set(src, TRANSPARENT_PNG)
      }
    }),
  )

  // 替换 <img src>（双/单引号）
  let out = html.replace(IMG_SRC_RE, (tag, quote: string, src: string) => {
    const uri = resolved.get(src.trim())
    return uri ? tag.replace(`src=${quote}${src}${quote}`, `src=${quote}${uri}${quote}`) : tag
  })
  // 替换 CSS url(...)
  out = out.replace(CSS_URL_RE, (tag, quote: string, src: string) => {
    const uri = resolved.get(src.trim())
    return uri ? `url(${quote}${uri}${quote})` : tag
  })
  // 替换 SVG <image href / xlink:href>
  out = out.replace(SVG_IMAGE_RE, (tag, quote: string, src: string) => {
    const uri = resolved.get(src.trim())
    return uri ? tag.replace(/href=(["'])[^"']*\1/i, `href=${quote}${uri}${quote}`) : tag
  })
  return out
}

/** 把某一页渲染成位图 Blob（PNG / JPG 共用） */
export async function pageToImageBlob(
  result: LayoutResult,
  index: number,
  opts: PageImageOptions = {},
): Promise<Blob> {
  const page = result.pages[index]
  if (!page) throw new Error(`页码越界：${index}`)
  const deco = opts.pageDecoration
  const css = generateCss(result.metrics, {
    screen: false,
    pageDecoration: deco,
    hasMath: layoutHasMath(result),
  })
  // 先内联图片为 data URI，再进 SVG 栅格化 —— 防止外部图污染 canvas 导致 toBlob 失败
  const pageHtml = await inlinePageImages(renderPage(page, deco?.watermark))
  let svg = buildPageSvg(pageHtml, css, result.metrics.pageWidth, result.metrics.pageHeight)
  // 含公式的页面追加 KaTeX 字体（data-URI 注入，解决 SVG 隔离上下文取不到公共字体的问题）
  const extraFonts: FontFaceDef[] = pageHtml.includes('katex') ? KATEX_FONT_DEFS : []
  if (opts.fonts?.length || extraFonts.length) {
    svg = await embedFontsInSvg(svg, [...(opts.fonts ?? []), ...extraFonts])
  }
  const canvas = await svgToCanvas(svg, opts.scale ?? 3, opts.background ?? '#ffffff')
  const type = opts.type ?? 'image/png'
  const quality = type === 'image/jpeg' ? opts.quality ?? 1 : undefined
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 失败'))),
      type,
      quality,
    )
  })
}
