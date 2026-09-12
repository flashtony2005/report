<script setup lang="ts">
/**
 * ChartViewLayer —— 图表 HTML/SVG overlay（方案 A 的载体）
 *
 * 与 TableViewLayer 同构：设计期图表**不**由 Fabric 画位图，而是用 chartkit 生成的
 * 原生 SVG 绝对定位覆盖在画布上，transform 与 Fabric 节点 + 视口实时同步。
 * SVG 字符串由 chartkit 生成，设计期与运行期导出共用同一份产物（设计即打印）。
 *
 * 图表数据由右侧属性面板编辑（而非单元格内联编辑），所以本层：
 * - 平时整层 `pointer-events:none`，点击照旧落到 Fabric（选中 / 拖拽 / 缩放不受影响）
 * - 不做 contenteditable / 工具栏，只负责把 SVG 画到位
 *
 * 几何与内容组装全部走框架无关的 `overlay-logic`（React 端同名组件共用同一份），
 * 本组件只是它的 Vue 响应式外壳。
 */
import { computed, ref } from 'vue'
import { useDesignerStore } from '@/design/stores/designer'
import { PrintChart } from './controls/PrintChart'
import { renderChartControl } from '@/core/chartkit'
import type { ChartControl } from '@/types/control'
import { collectOverlayItems, overlayItemStyle, type OverlayItem } from './overlay-logic'

const store = useDesignerStore()
const layerRef = ref<HTMLElement | null>(null)

/**
 * 每个图表一项：几何取自 Fabric 对象（拖拽/缩放实时），内容取自 store 模型。
 * canvasTick 是显式依赖 —— Fabric 对象不是响应式的，靠画布事件驱动重算。
 */
const items = computed<OverlayItem[]>(() => {
  void store.canvasTick
  void store.controls
  void store.zones
  return collectOverlayItems<PrintChart>({
    canvas: store.designer?.canvas ?? null,
    store,
    isTarget: (o): o is PrintChart => o instanceof PrintChart,
    type: 'chart',
    render: (c) => renderChartControl(c as ChartControl),
  })
})
</script>

<template>
  <div ref="layerRef" class="op-chart-overlay absolute inset-0 overflow-hidden">
    <div
      v-for="it in items"
      :key="it.id"
      class="op-chart-overlay__item"
      :data-chart-id="it.id"
      :style="overlayItemStyle(it)"
      v-html="it.html"
    />
  </div>
</template>

<style scoped>
.op-chart-overlay {
  /* 平时完全透明于鼠标：所有交互照旧交给 Fabric */
  pointer-events: none;
}

.op-chart-overlay__item {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  overflow: hidden;
}

/* SVG 填满宿主框，矢量随容器缩放清晰 */
.op-chart-overlay__item :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
