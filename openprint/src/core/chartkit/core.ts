/**
 * chartkit/core —— 纯几何/文本工具（零依赖）
 *
 * 所有生成器共用的小工具：转义、数值格式化、线性刻度取整、饼图弧线路径。
 * 不依赖任何外部库，也不依赖 DOM（可在 Node / 测试环境跑）。
 */
import { DEFAULT_PALETTE, type ChartOptions, type ChartSeries } from './types'

/** XML/HTML 文本转义（防止类目/标题里的 & < > 破坏 SVG 结构） */
export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 数值格式化：整数去小数，小数保留最多 2 位 */
export function fmt(n: number): string {
  if (!isFinite(n)) return ''
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r)
}

/**
 * 计算「好看」的坐标轴上限：取数据最大值，向上取整到 1/2/5×10ⁿ 量级。
 * 例如 max=73 → 80；max=250 → 300；max=0 → 1。
 */
export function niceMax(max: number): number {
  if (max <= 0) return 1
  const exp = Math.floor(Math.log10(max))
  const base = Math.pow(10, exp)
  const frac = max / base
  let nice: number
  if (frac <= 1) nice = 1
  else if (frac <= 2) nice = 2
  else if (frac <= 5) nice = 5
  else nice = 10
  return nice * base
}

/** 取序列颜色：显式 color 优先，否则按调色板顺序取 */
export function seriesColor(series: ChartSeries, index: number, options?: ChartOptions): string {
  if (series.color) return series.color
  const palette = options?.palette ?? DEFAULT_PALETTE
  return palette[index % palette.length]!
}

/**
 * 极坐标 → 笛卡尔坐标。angleDeg 以「12 点方向为 0°、顺时针递增」表示，
 * 与饼图扇区习惯一致。
 */
export function polar(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const theta = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) }
}

/**
 * 饼图扇区路径（支持环形 donut）。
 * @param startAngle 起始角（度，顺时针从 12 点起）
 * @param endAngle   结束角（度）
 * @param rInner     内半径（donut>0 时 >0）
 */
export function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  startAngle: number,
  endAngle: number,
  rInner = 0,
): string {
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  // 整圆特例：单扇区 360° 用两段半圆弧画，否则 A 命令会因起止点重合而失效
  if (endAngle - startAngle >= 359.999) {
    const top = polar(cx, cy, rOuter, 0)
    const bottom = polar(cx, cy, rOuter, 180)
    let d = `M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${top.x.toFixed(2)} ${top.y.toFixed(2)} A ${rOuter} ${rOuter} 0 1 1 ${bottom.x.toFixed(2)} ${bottom.y.toFixed(2)} A ${rOuter} ${rOuter} 0 1 1 ${top.x.toFixed(2)} ${top.y.toFixed(2)} Z`
    if (rInner > 0) {
      const itop = polar(cx, cy, rInner, 0)
      const ibottom = polar(cx, cy, rInner, 180)
      d += ` M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${itop.x.toFixed(2)} ${itop.y.toFixed(2)} A ${rInner} ${rInner} 0 1 0 ${ibottom.x.toFixed(2)} ${ibottom.y.toFixed(2)} A ${rInner} ${rInner} 0 1 0 ${itop.x.toFixed(2)} ${itop.y.toFixed(2)} Z`
    }
    return d
  }
  const start = polar(cx, cy, rOuter, startAngle)
  const end = polar(cx, cy, rOuter, endAngle)
  // 环形：外弧(顺时针) + 内弧(逆时针) 组成闭合环段（不连圆心）
  if (rInner > 0) {
    const iStart = polar(cx, cy, rInner, startAngle)
    const iEnd = polar(cx, cy, rInner, endAngle)
    return (
      `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}` +
      ` L ${iEnd.x.toFixed(2)} ${iEnd.y.toFixed(2)} A ${rInner} ${rInner} 0 ${largeArc} 0 ${iStart.x.toFixed(2)} ${iStart.y.toFixed(2)} Z`
    )
  }
  // 实心饼：圆心 → 外起点 → 弧 → 圆心，形成真正到达圆心的楔形（修复"中间空白"）
  return `M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`
}

/** 截断过长标签（设计期/运行期共用） */
export function truncate(s: string, max = 12): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * 图例整体起始 x：left 直接用 leftPad；center/right 按单行总宽偏移。
 * 单行假设（多数图例一行放得下）；若实际换行，仍从 startX 起排，整体观感一致。
 */
export function legendStartX(
  align: 'left' | 'center' | 'right' | undefined,
  W: number,
  totalW: number,
  leftPad: number,
): number {
  if (align === 'center') return Math.max(leftPad, (W - totalW) / 2)
  if (align === 'right') return Math.max(leftPad, W - totalW - 8)
  return leftPad
}
