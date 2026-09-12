/**
 * chartkit/bar —— 垂直分组条形图（零依赖 SVG）
 *
 * 输出一串 <rect>（按序列分组并排）+ 坐标轴 + 可选网格 + 图例 + 数据标签。
 * 全部用逻辑坐标（viewBox），实际尺寸由外层容器缩放，矢量清晰。
 */
import { escapeXml, fmt, niceMax, seriesColor, truncate, legendStartX } from './core'
import type { ChartModel } from './types'

export function renderBar(model: ChartModel): string {
  const opt = model.options ?? {}
  const W = opt.width ?? 480
  const H = opt.height ?? 320
  const title = opt.title
  const showAxis = opt.showAxis ?? true
  const showGrid = opt.showGrid ?? true
  const showLegend = opt.showLegend ?? model.series.length > 1
  const valueLabel = opt.valueLabel ?? false

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
  const inner = band * 0.74
  const sCount = model.series.length
  const barW = inner / Math.max(1, sCount)

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" font-family="'SourceHanSerifCN', 'PingFang SC', 'Microsoft YaHei', sans-serif">`)

  if (title) {
    parts.push(`<text x="${W / 2}" y="${16}" text-anchor="middle" font-size="13" font-weight="600" fill="#1f2329">${escapeXml(title)}</text>`)
  }

  // 网格 + y 轴刻度
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
    // 基线
    parts.push(`<line x1="${px0}" y1="${py1}" x2="${px1}" y2="${py1}" stroke="#cccccc" stroke-width="1"/>`)
  }

  // 柱体
  for (let c = 0; c < n; c++) {
    const cx = px0 + band * (c + 0.5)
    const groupX0 = cx - inner / 2
    for (let s = 0; s < sCount; s++) {
      const val = model.series[s]!.data[c] ?? 0
      if (!isFinite(val)) continue
      const h = (Math.max(0, val) / yMax) * plotH
      const x = groupX0 + s * barW
      const y = py1 - h
      const color = seriesColor(model.series[s]!, s, opt)
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.9).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${color}" rx="1.5"/>`)
      if (valueLabel && h > 0) {
        parts.push(`<text x="${(x + barW * 0.45).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#000000">${fmt(val)}</text>`)
      }
    }
    // x 轴标签：始终以类目为基准居中于对应条带正下方，并与图表留一点间距
    if (showAxis) {
      parts.push(`<text x="${cx.toFixed(1)}" y="${(py1 + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="#5a6068">${escapeXml(truncate(String(cats[c] ?? '')))}</text>`)
    }
  }

  // 图例
  if (showLegend) {
    const align = opt.labelAlign ?? 'center'
    let totalW = 0
    for (let s = 0; s < sCount; s++) {
      const name = model.series[s]!.name || `系列${s + 1}`
      totalW += 16 + name.length * 12 + 18
    }
    const startX = legendStartX(align, W, totalW, px0)
    let lx = startX
    let ly = py1 + (showAxis ? 40 : 16)
    for (let s = 0; s < sCount; s++) {
      const name = model.series[s]!.name || `系列${s + 1}`
      const color = seriesColor(model.series[s]!, s, opt)
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
