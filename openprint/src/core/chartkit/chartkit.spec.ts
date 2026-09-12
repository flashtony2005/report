import { describe, it, expect } from 'vitest'
import {
  renderChartSvg,
  chartControlToModel,
  renderChartControl,
  DEFAULT_PALETTE,
} from './index'
import type { ChartModel } from './types'

const barModel: ChartModel = {
  kind: 'bar',
  categories: ['一月', '二月', '三月'],
  series: [
    { name: '销量', data: [12, 19, 8] },
    { name: '退货', data: [3, 5, 2] },
  ],
}

const lineModel: ChartModel = {
  kind: 'line',
  categories: ['周一', '周二', '周三'],
  series: [{ name: '温度', data: [20, 25, 22] }],
}

const pieModel: ChartModel = {
  kind: 'pie',
  categories: ['苹果', '香蕉', '橙子'],
  series: [{ name: '销量', data: [10, 20, 30] }],
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('chartkit · 产出结构', () => {
  it('三种图表都返回以 <svg 开头、以 </svg> 结尾的可缩放 SVG', () => {
    for (const m of [barModel, lineModel, pieModel]) {
      const svg = renderChartSvg(m)
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
      expect(svg).toContain('viewBox="0 0')
      expect(svg).toContain('width="100%"')
    }
  })

  it('bar 为每个(序列×类目)生成一个 <rect>', () => {
    const svg = renderChartSvg(barModel)
    // 2 序列 × 3 类目 = 6 根柱（柱体 rx=1.5，区别于图例色块 rx=2）
    expect(count(svg, 'rx="1.5"')).toBe(6)
  })

  it('line 含一条折线路径 + 每个点一个圆点', () => {
    const svg = renderChartSvg(lineModel)
    expect(count(svg, '<circle')).toBe(3)
    expect(svg).toContain('<path')
  })

  it('pie 为每个正数扇区生成一个 <path>', () => {
    const svg = renderChartSvg(pieModel)
    expect(count(svg, '<path')).toBe(3)
    // 百分比标签
    expect(svg).toContain('%')
  })

  it('pie 环形(donut) 每个扇区的 path 含内外两段弧(共 2 个 A 命令)', () => {
    const normal = renderChartSvg(pieModel)
    const donut = renderChartSvg({ ...pieModel, options: { donut: true } })
    // 3 个扇区：普通每个 1 段弧；环形每个 2 段弧（外圈+内圈）
    expect(count(normal, ' A ')).toBe(3)
    expect(count(donut, ' A ')).toBe(6)
  })

  it('饼图实心扇区必须到达圆心(修复"中间空白")', () => {
    const normal = renderChartSvg(pieModel)
    const donut = renderChartSvg({ ...pieModel, options: { donut: true } })
    // 默认 480×320 无标题无环形：圆心 (240,148)，楔形路径应以 "M 240.00 148.00" 起笔
    expect(normal).toContain('M 240.00 148.00')
    // 环形是环段，不应从圆心起笔
    expect(donut).not.toContain('M 240.00 148.00')
  })
})

describe('chartkit · 空/异常数据兜底', () => {
  it('空数据渲染占位提示，不抛错', () => {
    const svg = renderChartSvg({ kind: 'bar', categories: [], series: [] })
    expect(svg).toContain('暂无数据')
  })

  it('饼图总量为 0 时不画扇区', () => {
    const svg = renderChartSvg({ kind: 'pie', categories: ['a', 'b'], series: [{ name: 's', data: [0, 0] }] })
    expect(svg).toContain('暂无数据')
  })
})

describe('chartkit · 文本转义', () => {
  it('标题中的 & < > 被转义，不会破坏 SVG 结构', () => {
    const svg = renderChartSvg({ ...barModel, options: { title: 'A & B <C> "D"' } })
    expect(svg).not.toContain('A & B')
    expect(svg).toContain('A &amp; B &lt;C&gt;')
  })
})

describe('chartkit · ChartControl 映射', () => {
  it('chartControlToModel 补齐缺省并过滤非有限值', () => {
    const m = chartControlToModel({
      type: 'chart',
      id: 'c1',
      kind: 'line',
      left: 0,
      top: 0,
      width: 60,
      height: 40,
      categories: ['x', 'y'],
      series: [{ name: 's', data: [1, NaN, 3] }],
    })
    expect(m.kind).toBe('line')
    expect(m.series[0]!.data).toEqual([1, 3])
    expect(m.categories).toEqual(['x', 'y'])
  })

  it('renderChartControl 从协议对象直接出 SVG', () => {
    const svg = renderChartControl({
      type: 'chart',
      id: 'c2',
      kind: 'pie',
      left: 0,
      top: 0,
      width: 50,
      height: 50,
      categories: ['a', 'b'],
      series: [{ name: 's', data: [1, 2] }],
    })
    expect(svg).toContain('<svg')
    expect(DEFAULT_PALETTE.length).toBeGreaterThan(0)
  })
})
