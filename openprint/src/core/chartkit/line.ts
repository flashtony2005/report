/**
 * chartkit/line —— 折线图（零依赖 SVG）
 *
 * 多序列折线 + 坐标轴 + 可选网格 + 图例 + 数据标签。
 * 支持 smooth（Catmull-Rom 平滑曲线）与 area（折线下方面积填充）。
 */
import { escapeXml, fmt, niceMax, seriesColor, truncate, legendStartX } from './core'
import type { ChartModel } from './types'

interface Pt { x: number; y: number }

function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return pts.length ? `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}` : ''
  let d = `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`
  const t = 1 / 6
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) * t
    const c1y = p1.y + (p2.y - p0.y) * t
    const c2x = p2.x - (p3.x - p1.x) * t
    const c2y = p2.y - (p3.y - p1.y) * t
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  return d
}

export function renderLine(model: ChartModel): string {
  const opt = model.options ?? {}
  const W = opt.width ?? 480
  const H = opt.height ?? 320
  const title = opt.title
  const showAxis = opt.showAxis ?? true
  const showGrid = opt.showGrid ?? true
  const showLegend = opt.showLegend ?? model.series.length > 1
  const valueLabel = opt.valueLabel ?? false
  const smooth = opt.smooth ?? false
  const area = opt.area ?? false

  const legendH = showLegend ? 22 : 0
  const titleH = title ? 22 : 0
  const mTop = 10 + titleH
  const mRight = 16
  const mBottom = (showAxis ? 42 : 22) + legendH
  const mLeft = showAxis ? 44 : 16

  const px0 = mLeft
  const py0 = mTop
  const px1 = W - mRight
  const py1 = H - mBottom
  const plotW = Math.max(1, px1 - px0)
  const plotH = Math.max(1, py1 - py0)

  const cats = model.categories.length
    ? model.categories
    : (model.series[0]?.data ?? []).map((_, i) => String(i + 1))
  const n = cats.length

  const allVals: number[] = []
  for (const s of model.series) for (const v of s.data) if (isFinite(v)) allVals.push(v)
  if (model.series.length === 0 || n === 0 || allVals.length === 0) {
    return placeholder(W, H, '暂无数据')
  }

  const yMax = niceMax(Math.max(0, ...allVals))
  const band = plotW / Math.max(1, n)

  // 预计算每序列的每个点
  const seriesPts = model.series.map((s, si) => {
    const color = seriesColor(s, si, opt)
    const pts: Pt[] = []
    for (let c = 0; c < n; c++) {
      const val = s.data[c] ?? 0
      const x = n > 1 ? px0 + band * (c + 0.5) : (px0 + px1) / 2
      const y = py1 - (Math.max(0, val) / yMax) * plotH
      pts.push({ x, y })
    }
    return { color, pts, name: s.name }
  })

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" font-family="'SourceHanSerifCN', 'PingFang SC', 'Microsoft YaHei', sans-serif">`)

  if (title) {
    parts.push(`<text x="${W / 2}" y="${16}" text-anchor="middle" font-size="13" font-weight="600" fill="#1f2329">${escapeXml(title)}</text>`)
  }

  if (showAxis) {
    const ticks = 4
    for (let i = 0; i <= ticks; i++) {
      const v = (yMax / ticks) * i
      const y = py1 - (v / yMax) * plotH
      if (showGrid && i > 0) {
        parts.push(`<line x1="${px0}" y1="${y.toFixed(1)}" x2="${px1}" y2="${y.toFixed(1)}" stroke="#EEEEEE" stroke-width="1"/>`)
      }
      parts.push(`<text x="${px0 - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="#000000">${fmt(v)}</text>`)
    }
    parts.push(`<line x1="${px0}" y1="${py0}" x2="${px0}" y2="${py1}" stroke="#cccccc" stroke-width="1"/>`)
    parts.push(`<line x1="${px0}" y1="${py1}" x2="${px1}" y2="${py1}" stroke="#cccccc" stroke-width="1"/>`)
    for (let c = 0; c < n; c++) {
      const x = px0 + band * (c + 0.5)
      // x 轴类目标签：始终以类目为基准居中于对应点正下方，并与图表留一点间距
      parts.push(`<text x="${x.toFixed(1)}" y="${(py1 + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="#5a6068">${escapeXml(truncate(String(cats[c] ?? '')))}</text>`)
    }
  }

  for (const sp of seriesPts) {
    if (area && sp.pts.length > 1) {
      let d = smooth ? smoothPath(sp.pts) : `M ${sp.pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}`
      const last = sp.pts[sp.pts.length - 1]!
      const first = sp.pts[0]!
      d += ` L ${last.x.toFixed(1)} ${py1} L ${first.x.toFixed(1)} ${py1} Z`
      parts.push(`<path d="${d}" fill="${sp.color}" fill-opacity="0.15"/>`)
    }
    const lineD = smooth ? smoothPath(sp.pts) : (sp.pts.length ? `M ${sp.pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')}` : '')
    if (lineD) parts.push(`<path d="${lineD}" fill="none" stroke="${sp.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
    for (const p of sp.pts) {
      parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="#ffffff" stroke="${sp.color}" stroke-width="1.6"/>`)
    }
  }
  if (valueLabel) {
    for (let si = 0; si < seriesPts.length; si++) {
      const sp = seriesPts[si]!
      const series = model.series[si]!
      for (let c = 0; c < sp.pts.length; c++) {
        const v = series.data[c] ?? 0
        parts.push(`<text x="${sp.pts[c]!.x.toFixed(1)}" y="${(sp.pts[c]!.y - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#000000">${fmt(v)}</text>`)
      }
    }
  }

  if (showLegend) {
    const align = opt.labelAlign ?? 'center'
    let totalW = 0
    for (let s = 0; s < seriesPts.length; s++) {
      const name = seriesPts[s]!.name || `系列${s + 1}`
      totalW += 16 + name.length * 12 + 18
    }
    const startX = legendStartX(align, W, totalW, px0)
    let lx = startX
    let ly = py1 + (showAxis ? 40 : 16)
    for (let s = 0; s < seriesPts.length; s++) {
      const name = seriesPts[s]!.name || `系列${s + 1}`
      const color = seriesPts[s]!.color
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
}

function placeholder(W: number, H: number, text: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="#bbbbbb">${escapeXml(text)}</text></svg>`
}
