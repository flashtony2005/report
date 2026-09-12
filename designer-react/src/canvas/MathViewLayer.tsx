/**
 * MathViewLayer —— 公式 HTML overlay（React 版，方案 A 的载体）
 *
 * 与 Vue 版 `canvas/MathViewLayer.vue` 职责一致，且共用同一份几何/内容组装
 * （`@/design/canvas/overlay-logic`）：设计期公式不由 Fabric 画位图，而是用 mathkit
 * 渲染的 KaTeX HTML 绝对定位覆盖在画布上，transform 与 Fabric 节点 + 视口实时同步。
 * 公式数据由右侧属性面板编辑（latex 源码 + 字号 / 颜色）。
 *
 * 本层：平时整层 `pointer-events:none`，点击照旧落到 Fabric。
 */
import { useMemo } from 'react'
import { PrintMath } from '@/design/canvas/controls/PrintMath'
import { renderMathControl } from '@/core/mathkit'
import { collectOverlayItems, overlayItemStyle, type OverlayItem } from '@/design/canvas/overlay-logic'
import type { MathControl } from '@/types/control'
import { getCanvasHost, useDesignerStore } from '../stores/designer'
import './overlay-layers.css'

export default function MathViewLayer() {
  const canvasTick = useDesignerStore((s) => s.canvasTick)
  const controls = useDesignerStore((s) => s.controls)
  const zones = useDesignerStore((s) => s.zones)

  const items = useMemo<OverlayItem[]>(() => {
    void canvasTick
    return collectOverlayItems<PrintMath>({
      canvas: getCanvasHost()?.canvas ?? null,
      store: { controls, zones },
      isTarget: (o): o is PrintMath => o instanceof PrintMath,
      type: 'math',
      render: (c) => renderMathControl(c as MathControl),
    })
  }, [canvasTick, controls, zones])

  return (
    <div className="op-math-overlay" data-testid="math-overlay">
      {items.map((it) => (
        <div
          key={it.id}
          className="op-math-overlay__item"
          data-math-id={it.id}
          style={overlayItemStyle(it)}
          // KaTeX HTML 来自 mathkit（可信内容，与 Vue 端 v-html 同源）
          dangerouslySetInnerHTML={{ __html: it.html }}
        />
      ))}
    </div>
  )
}
