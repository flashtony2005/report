/**
 * chartkit/index —— 对外统一入口
 *
 * - `renderChartSvg(model)`：纯函数，ChartModel → 可缩放 SVG 字符串。
 * - `chartControlToModel(control)`：把设计器里的 ChartControl 协议对象转成 ChartModel
 *   （补默认值、剔除非法字段），供设计期 overlay 与运行期导出共用。
 * - `renderChartControl(control)`：一步到位，从 ChartControl 直接出 SVG 字符串。
 *
 * 整个模块零依赖、不碰 DOM，可在 Node / 测试环境运行。
 */
import type { ChartControl } from '../../types/control'
import type { ChartKind, ChartModel, ChartSeries } from './types'
import { renderBar } from './bar'
import { renderLine } from './line'
import { renderPie } from './pie'

export type { ChartKind, ChartModel, ChartSeries, ChartOptions } from './types'
export { DEFAULT_PALETTE } from './types'
export { renderBar } from './bar'
export { renderLine } from './line'
export { renderPie } from './pie'

export function renderChartSvg(model: ChartModel): string {
  switch (model.kind) {
    case 'bar':
      return renderBar(model)
    case 'line':
      return renderLine(model)
    case 'pie':
      return renderPie(model)
    default:
      return ''
  }
}

/** ChartControl（协议）→ ChartModel（渲染器输入），补齐缺省值 */
export function chartControlToModel(c: ChartControl): ChartModel {
  const series: ChartSeries[] = (c.series ?? []).map((s) => ({
    name: s.name ?? '',
    data: Array.isArray(s.data) ? s.data.filter((v) => typeof v === 'number' && isFinite(v)) : [],
    color: s.color,
  }))
  return {
    kind: c.kind,
    categories: Array.isArray(c.categories) ? c.categories.map(String) : [],
    series,
    options: c.options,
  }
}

/** 一步到位：ChartControl → 可缩放 SVG 字符串 */
export function renderChartControl(control: ChartControl): string {
  return renderChartSvg(chartControlToModel(control))
}
