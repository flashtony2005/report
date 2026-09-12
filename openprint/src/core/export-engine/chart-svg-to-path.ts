/**
 * chart-svg-to-path —— 把图表 SVG 里的 <text> 转成矢量 <path> 字形轮廓
 *
 * 背景：jsPDF 只能内嵌 TrueType(glyf) 字体，无法内嵌 CFF/OpenType 字体；
 * 思源宋体 .ttf 实为 CFF，jsPDF 内嵌会静默失败 → 矢量图表中文标签变空白。
 * 解决：在导出 PDF 的矢量路径里，用 opentype.js 把每个字形展开为 path，
 * 文本即成为与字体无关的矢量轮廓，svg2pdf 直接画 path，中文不再丢。
 *
 * 仅 export-pdf 的图表矢量路径按需动态调用，不进主包、不影响设计期/预览。
 */
const SERIF_TTF_URL = '/fonts/SourceHanSerifCN-Regular.ttf'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fontPromise: Promise<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadFont(): Promise<any | null> {
  if (!fontPromise) {
    fontPromise = (async () => {
      try {
        const res = await fetch(SERIF_TTF_URL)
        if (!res.ok) return null
        const buf = await res.arrayBuffer()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ot: any = await import('opentype.js')
        const parse = ot.parse ?? ot.default?.parse ?? ot.default
        return parse(buf)
      } catch {
        return null
      }
    })()
  }
  return fontPromise
}

/**
 * 把图表 SVG 字符串里的所有 <text> 替换为字形轮廓 <path>。
 * 字体加载失败/解析异常时原样返回（交给 svg2pdf，最坏情况该页走栅格兜底）。
 */
export async function outlineChartSvgText(svg: string): Promise<string> {
  const font = await loadFont()
  if (!font) return svg

  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const svgEl = doc.documentElement
  if (!svgEl || svgEl.nodeName.toLowerCase() !== 'svg') return svg

  const texts = Array.from(svgEl.getElementsByTagName('text'))
  for (const t of texts) {
    const text = t.textContent ?? ''
    if (!text) {
      t.remove()
      continue
    }
    const x = parseFloat(t.getAttribute('x') ?? '0') || 0
    const y = parseFloat(t.getAttribute('y') ?? '0') || 0
    const fontSize = parseFloat(t.getAttribute('font-size') ?? '10') || 10
    const fill = t.getAttribute('fill') || '#000000'
    const anchor = (t.getAttribute('text-anchor') || 'start').toLowerCase()

    const scale = fontSize / font.unitsPerEm
    const total = font.getAdvanceWidth(text, fontSize)
    let startX = x
    if (anchor === 'middle') startX = x - total / 2
    else if (anchor === 'end') startX = x - total

    const ds: string[] = []
    let cursor = startX
    for (const ch of text) {
      const g = font.charToGlyph(ch)
      if (!g) continue
      const gp = g.getPath(cursor, y, fontSize)
      const d = gp.toPathData(2)
      if (d && d.trim()) ds.push(d)
      cursor += (g.advanceWidth || 0) * scale
    }

    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', ds.join(' '))
    path.setAttribute('fill', fill)
    if (t.parentNode) t.parentNode.replaceChild(path, t)
  }

  return new XMLSerializer().serializeToString(svgEl)
}
