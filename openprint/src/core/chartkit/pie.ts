/**
 * chartkit/pie —— 饼图 / 环形图（零依赖 SVG）
 *
 * 用 arcPath 画每个扇区（或环形），标签显示类目+百分比，底部可选图例。
 * 饼图通常只用 series[0]（每个数据点 = 一个扇区）。
 */
import { arcPath, escapeXml, seriesColor, truncate, legendStartX } from './core'
import { DEFAULT_PALETTE } from './types'
import type { ChartModel } from './types'

export function renderPie(model: ChartModel): string {
  const opt = model.options ?? {}
  const W = opt.width ?? 480
  const H = opt.height ?? 320
  const title = opt.title
  const showLegend = opt.showLegend ?? true
  const donut = opt.donut ?? false
  const valueLabel = opt.valueLabel ?? true

  const legendH = showLegend ? 24 : 0
  const titleH = title ? 22 : 0

  const cats = model.categories.length
    ? model.categories
    : (model.series[0]?.data ?? []).map((_, i) => `类目${i + 1}`)
  const data = (model.series[0]?.data ?? []).filter((v) => isFinite(v))
  const total = data.reduce((a, b) => a + Math.max(0, b), 0)
  if (data.length === 0 || total <= 0) {
    return placeholder(W, H, '暂无数据')
  }

  const cx = W / 2
  const cy = titleH + (H - titleH - legendH) / 2
  const rOuter = (Math.min(W * 0.82, H - titleH - legendH) / 2) * 0.92
  const rInner = donut ? rOuter * 0.56 : 0

  const palette = opt.palette ?? DEFAULT_PALETTE
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" font-family="'SourceHanSerifCN', 'PingFang SC', 'Microsoft YaHei', sans-serif">`)

  if (title) {
    parts.push(`<text x="${W / 2}" y="${16}" text-anchor="middle" font-size="13" font-weight="600" fill="#1f2329">${escapeXml(title)}</text>`)
  }

  let angle = 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(0, data[i]!)
    if (v <= 0) continue
    const sweep = (v / total) * 360
    const start = angle
    const end = angle + sweep
    angle = end
    const color = seriesColor({ name: cats[i] ?? '', data: [] }, i, opt)
    parts.push(`<path d="${arcPath(cx, cy, rOuter, start, end, rInner)}" fill="${color}" stroke="#ffffff" stroke-width="1"/>`)
    // 百分比标签
    if (valueLabel && sweep > 12) {
      const mid = (start + end) / 2
      const lr = donut ? (rOuter + rInner) / 2 : rOuter * 0.62
      const p = polarL(lr, mid)
      const pct = ((v / total) * 100).toFixed(0) + '%'
      parts.push(`<text x="${p.x.toFixed(1)}" y="${(p.y + 3).toFixed(1)}" text-anchor="middle" font-size="11" fill="#ffffff" font-weight="600">${pct}</text>`)
    }
  }

  if (showLegend) {
    const align = opt.labelAlign ?? 'center'
    let totalW = 0
    for (let i = 0; i < data.length; i++) {
      const name = cats[i] ?? `类目${i + 1}`
      totalW += 16 + name.length * 12 + 18
    }
    const startX = legendStartX(align, W, totalW, 12)
    let lx = startX
    let ly = H - legendH + 12
    for (let i = 0; i < data.length; i++) {
      const name = cats[i] ?? `类目${i + 1}`
      const color = seriesColor({ name, data: [] }, i, opt)
      const itemW = 16 + name.length * 12 + 18
      if (lx + itemW > W - 8 && lx > startX) {
        lx = startX
        ly += 16
      }
      parts.push(`<rect x="${lx}" y="${ly - 9}" width="11" height="11" rx="2" fill="${color}"/>`)
      parts.push(`<text x="${lx + 15}" y="${ly}" font-size="11" fill="#000000">${escapeXml(truncate(name, 10))}</text>`)
      lx += itemW
    }
  }

  parts.push('</svg>')
  return parts.join('')

  function polarL(r: number, angleDeg: number) {
    const theta = ((angleDeg - 90) * Math.PI) / 180
    return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) }
  }
}

function placeholder(W: number, H: number, text: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="#bbbbbb">${escapeXml(text)}</text></svg>`
}
