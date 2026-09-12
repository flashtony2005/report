/**
 * ChartProps 共享逻辑（P4.2）—— Vue / React 两端同源。
 *
 * 从 ChartProps.vue 抽出的数据编辑纯函数：类目编辑（序列长度对齐）、
 * 序列增删改（名称/颜色/数值对齐类目数）、外观开关默认值。
 * 颜色取自 @/core/chartkit 的 DEFAULT_PALETTE（纯 TS 两端可用）。
 */
import type { ChartControl } from '@/types/control'
import type { ChartSeries } from '@/core/chartkit/types'
import { DEFAULT_PALETTE } from '@/core/chartkit'

/* ------------------------------- 类目 ------------------------------- */

/** 类目文本 → patch：同时把各序列数据长度对齐到新类目数（缺位补 0） */
export function categoriesPatch(c: ChartControl, text: string): Record<string, unknown> {
  const cats = text.split('\n').map((s) => s.trim())
  const series = (c.series ?? []).map((s) => ({
    ...s,
    data: cats.map((_, i) => s.data[i] ?? 0),
  }))
  return { categories: cats, series }
}

/** 类目数组 → 多行文本（编辑框显示用） */
export function categoriesText(c: ChartControl | null | undefined): string {
  return (c?.categories ?? []).join('\n')
}

/* ------------------------------- 序列 ------------------------------- */

export function setSeriesNameAt(series: ChartSeries[], i: number, v: string): ChartSeries[] {
  return series.map((s, idx) => (idx === i ? { ...s, name: v } : s))
}

export function setSeriesColorAt(series: ChartSeries[], i: number, v: string): ChartSeries[] {
  return series.map((s, idx) => (idx === i ? { ...s, color: v } : s))
}

/** 序列数据文本 → 对齐类目数的数值数组（非数值缺位补 0） */
export function alignSeriesData(series: ChartSeries[], i: number, raw: string, cats: string[]): ChartSeries[] {
  const nums = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number)
  const aligned = cats.map((_, idx) => (Number.isFinite(nums[idx]) ? nums[idx]! : 0))
  return series.map((s, idx) => (idx === i ? { ...s, data: aligned } : s))
}

/** 序列数据数组 → 多行文本 */
export function seriesDataText(series: ChartSeries[], i: number): string {
  return (series[i]?.data ?? []).join('\n')
}

/** 新增序列：名称按序号、数值与类目对齐、颜色按调色板轮转 */
export function addSeriesAt(series: ChartSeries[], cats: string[]): ChartSeries[] {
  return [
    ...series,
    {
      name: `系列${series.length + 1}`,
      data: cats.map(() => 0),
      color: DEFAULT_PALETTE[series.length % DEFAULT_PALETTE.length]!,
    },
  ]
}

/** 删除序列（至少保留 1 条） */
export function removeSeriesAt(series: ChartSeries[], i: number): ChartSeries[] {
  if (series.length <= 1) return series
  return series.filter((_, idx) => idx !== i)
}

/** 序列颜色：未设置时按调色板回落 */
export function seriesColorOf(series: ChartSeries[], i: number): string {
  return series[i]?.color ?? DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]!
}

/* ------------------------------- 外观开关默认值 ------------------------------- */

export type ChartOptionsLike = Partial<NonNullable<ChartControl['options']>> | undefined

/** 图例默认值：多序列时默认显示 */
export function showLegendDefault(opts: ChartOptionsLike, seriesCount: number): boolean {
  return opts?.showLegend ?? seriesCount > 1
}

export function boolOptionDefault(opts: ChartOptionsLike, key: 'showAxis' | 'showGrid' | 'valueLabel' | 'smooth' | 'area' | 'donut', fallback: boolean): boolean {
  return (opts?.[key] as boolean | undefined) ?? fallback
}
