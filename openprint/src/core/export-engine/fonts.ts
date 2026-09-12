/**
 * 字体嵌入工具 —— 让栅格化产物（PNG / JPG / PDF）与矢量 SVG / 无头打印 HTML 也能用上「自定义字体」。
 *
 * ## 为什么需要它
 * - 预览 / 浏览器打印：字体由主文档或 iframe 的 `@font-face` 提供，正常生效。
 * - 但 PNG/JPG/PDF 走 `SVG <foreignObject>` 光栅化，而 `<img>` 加载的 SVG 是**隔离上下文**，
 *   看不到父文档的 `@font-face`，只能用系统字体（PingFang SC / 系统 sans-serif 兜底）。
 *   若模板指定了「思源宋体」等自定义字体，栅格化产物会丢字体。
 * - 解法：把字体以 `@font-face(data-URI)` 直接写进 SVG / HTML 本身，隔离上下文也能用。
 *
 * 仅当 `fonts` 显式传入才做网络读取（同源本地字体），默认不联网，符合零网络铁律。
 */
export interface FontFaceDef {
  /** 字体族名，必须与模板 CSS 中的 font-family 一致 */
  family: string
  /** 同源字体文件 URL（.woff2 / .ttf / .otf / .woff） */
  src: string
  weight?: string | number
  style?: string
}

function fontFormat(src: string): string {
  const ext = (src.split('?')[0] ?? '').split('.').pop()?.toLowerCase()
  if (ext === 'ttf') return 'truetype'
  if (ext === 'otf') return 'opentype'
  if (ext === 'woff2') return 'woff2'
  if (ext === 'eot') return 'embedded-opentype'
  return 'woff'
}

function fontMime(src: string): string {
  const ext = (src.split('?')[0] ?? '').split('.').pop()?.toLowerCase()
  if (ext === 'ttf') return 'font/ttf'
  if (ext === 'otf') return 'font/otf'
  if (ext === 'eot') return 'application/vnd.ms-fontobject'
  if (ext === 'woff') return 'font/woff'
  return 'font/woff2'
}

/**
 * data-URI 缓存：同一 src 只 fetch + base64 一次。
 * 导出 PDF / 多页图片时每页都会 embedFonts，思源宋体 TTF 10MB+，
 * 逐页重复请求 + base64 会让 N 页导出线性放大内存与时间（20 页 ≈ 数百 MB 瞬时占用）。
 */
const dataUriCache = new Map<string, Promise<string>>()

async function fetchFontDataUriCached(src: string): Promise<string> {
  const hit = dataUriCache.get(src)
  if (hit) return hit
  const p = fetchFontDataUri(src).catch((err: unknown) => {
    // 失败不留坏缓存，允许后续重试
    dataUriCache.delete(src)
    throw err
  })
  dataUriCache.set(src, p)
  return p
}

/** 测试/热更新用：清空字体 data-URI 缓存 */
export function clearFontDataUriCache(): void {
  dataUriCache.clear()
  uriCache.clear()
}

async function fetchFontDataUri(src: string): Promise<string> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`字体加载失败 ${src}: ${res.status}`)
  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${fontMime(src)};base64,${btoa(bin)}`
}

function buildFontFaceCss(defs: FontFaceDef[], dataUris: string[]): string {
  return defs
    .map(
      (d, i) =>
        `@font-face{font-family:"${d.family}";src:url(${dataUris[i]}) format("${fontFormat(
          d.src,
        )}");font-weight:${d.weight ?? 'normal'};font-style:${d.style ?? 'normal'};}`,
    )
    .join('')
}

const XHTML_DIV = '<div xmlns="http://www.w3.org/1999/xhtml">'

/** 把字体以 data-URI @font-face 嵌进 SVG（每个 xhtml div 顶部）—— 供 rasterize / SVG 矢量导出使用
 * 单个字体加载失败（文件缺失 / 网络异常）时跳过该字体，走系统字体兜底，不阻塞导出。 */
const uriCache = new Map<string, Promise<string | null>>()

async function defUri(d: FontFaceDef): Promise<string | null> {
  // 按内容签名缓存（调用方可能每次新建 FontFaceDef 对象，按引用缓存会失效）
  const key = `${d.src}|${d.family}|${d.weight ?? 'normal'}|${d.style ?? 'normal'}`
  let p = uriCache.get(key)
  if (!p) {
    p = fetchFontDataUriCached(d.src).catch(() => null)
    uriCache.set(key, p)
  }
  const uri = await p
  // 失败（文件缺失/网络异常）不留坏缓存：清掉后下次导出可重试，
  // 否则一次瞬时故障会让该字体在整个会话里永久失效
  if (uri === null) uriCache.delete(key)
  return uri
}

/** 把字体以 data-URI @font-face 嵌进 SVG（每个 xhtml div 顶部）—— 供 rasterize / SVG 矢量导出使用
 * 单个字体加载失败（文件缺失 / 网络异常）时跳过该字体，走系统字体兜底，不阻塞导出。 */
export async function embedFontsInSvg(svg: string, defs: FontFaceDef[]): Promise<string> {
  if (!defs.length) return svg
  const pairs = await Promise.all(
    defs.map(async (d) => {
      const uri = await defUri(d)
      return uri ? { d, uri } : null
    }),
  )
  const ok = pairs.filter((p): p is { d: FontFaceDef; uri: string } => p !== null)
  if (!ok.length) return svg
  const css = `<style>${buildFontFaceCss(ok.map((p) => p.d), ok.map((p) => p.uri))}</style>`
  return svg.split(XHTML_DIV).join(`${XHTML_DIV}${css}`)
}

/** 把字体以 data-URI @font-face 嵌进 HTML <head> —— 供无头静默打印文档使用
 * 单个字体加载失败（文件缺失 / 网络异常）时跳过该字体，走系统字体兜底，不阻塞打印。 */
export async function embedFontsInHtml(html: string, defs: FontFaceDef[]): Promise<string> {
  if (!defs.length) return html
  const pairs = await Promise.all(
    defs.map(async (d) => {
      const uri = await defUri(d)
      return uri ? { d, uri } : null
    }),
  )
  const ok = pairs.filter((p): p is { d: FontFaceDef; uri: string } => p !== null)
  if (!ok.length) return html
  const style = `<style>${buildFontFaceCss(ok.map((p) => p.d), ok.map((p) => p.uri))}</style>`
  if (html.includes('</head>')) return html.replace('</head>', `${style}</head>`)
  return `${style}${html}`
}
