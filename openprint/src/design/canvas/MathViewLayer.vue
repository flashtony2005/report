<script setup lang="ts">
/**
 * MathViewLayer —— 公式 HTML overlay（方案 A 的载体，类比 ChartViewLayer）
 *
 * 设计期公式**不**由 Fabric 画位图，而是用 mathkit 渲染的 KaTeX HTML
 * 绝对定位覆盖在画布上，transform 与 Fabric 节点 + 视口实时同步。
 * 公式数据由右侧属性面板编辑（latex 源码 + 字号 / 颜色）。
 *
 * 本层：
 * - 平时整层 `pointer-events:none`，点击照旧落到 Fabric（选中 / 拖拽 / 缩放不受影响）
 *
 * 几何与内容组装全部走框架无关的 `overlay-logic`（React 端同名组件共用同一份）。
 */
import { computed, ref } from 'vue'
import { useDesignerStore } from '@/design/stores/designer'
import { PrintMath } from './controls/PrintMath'
import { renderMathControl } from '@/core/mathkit'
import type { MathControl } from '@/types/control'
import { collectOverlayItems, overlayItemStyle, type OverlayItem } from './overlay-logic'

const store = useDesignerStore()
const layerRef = ref<HTMLElement | null>(null)

/**
 * 每个公式一项：几何取自 Fabric 对象（拖拽/缩放实时），内容取自 store 模型。
 * canvasTick 是显式依赖 —— Fabric 对象不是响应式的，靠画布事件驱动重算。
 */
const items = computed<OverlayItem[]>(() => {
  void store.canvasTick
  void store.controls
  void store.zones
  return collectOverlayItems<PrintMath>({
    canvas: store.designer?.canvas ?? null,
    store,
    isTarget: (o): o is PrintMath => o instanceof PrintMath,
    type: 'math',
    render: (c) => renderMathControl(c as MathControl),
  })
})
</script>

<template>
  <div ref="layerRef" class="op-math-overlay absolute inset-0 overflow-hidden">
    <div
      v-for="it in items"
      :key="it.id"
      class="op-math-overlay__item"
      :data-math-id="it.id"
      :style="overlayItemStyle(it)"
      v-html="it.html"
    />
  </div>
</template>

<style scoped>
.op-math-overlay {
  /* 平时完全透明于鼠标：所有交互照旧交给 Fabric */
  pointer-events: none;
}

.op-math-overlay__item {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
