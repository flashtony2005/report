/**
 * ChartViewLayer —— 图表 HTML/SVG overlay（React 版，方案 A 的载体）
 *
 * 与 Vue 版 `canvas/ChartViewLayer.vue` 职责一致，且**共用同一份几何/内容组装**
 * （`@/design/canvas/overlay-logic`）：设计期图表不由 Fabric 画位图，而是用 chartkit
 * 生成的原生 SVG 绝对定位覆盖在画布上，transform 与 Fabric 节点 + 视口实时同步。
 * 设计期与运行期导出共用同一份产物（设计即打印）。
 *
 * 图表数据由右侧属性面板编辑，所以本层：
 * - 平时整层 `pointer-events:none`，点击照旧落到 Fabric
 * - 不做 contenteditable / 工具栏，只负责把 SVG 画到位
 *
 * 响应式契约：Fabric 对象不是响应式的，overlay 只能靠 `canvasTick`
 * （画布变换打点）驱动重算 —— 这与 Vue 版 `void store.canvasTick` 是同一手法。
 */
import { useMemo } from 'react'
import { PrintChart } from '@/design/canvas/controls/PrintChart'
import { renderChartControl } from '@/core/chartkit'
import { collectOverlayItems, overlayItemStyle, type OverlayItem } from '@/design/canvas/overlay-logic'
import type { ChartControl } from '@/types/control'
import { getCanvasHost, useDesignerStore } from '../stores/designer'
import './overlay-layers.css'

export default function ChartViewLayer() {
  const canvasTick = useDesignerStore((s) => s.canvasTick)
  const controls = useDesignerStore((s) => s.controls)
  const zones = useDesignerStore((s) => s.zones)

  const items = useMemo<OverlayItem[]>(() => {
    void canvasTick
    return collectOverlayItems<PrintChart>({
      canvas: getCanvasHost()?.canvas ?? null,
      store: { controls, zones },
      isTarget: (o): o is PrintChart => o instanceof PrintChart,
      type: 'chart',
      render: (c) => renderChartControl(c as ChartControl),
    })
  }, [canvasTick, controls, zones])

  return (
    <div className="op-chart-overlay" data-testid="chart-overlay">
      {items.map((it) => (
        <div
          key={it.id}
          className="op-chart-overlay__item"
          data-chart-id={it.id}
          style={overlayItemStyle(it)}
          // SVG 字符串来自 chartkit（可信内容，与 Vue 端 v-html 同源）
          dangerouslySetInnerHTML={{ __html: it.html }}
        />
      ))}
    </div>
  )
}
