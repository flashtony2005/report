<script setup lang="ts">
/**
 * CanvasStage —— 画布舞台：Fabric canvas + 标尺覆盖层 + 拖放接收
 * DOM 结构遵循《标尺与辅助系统》§3.2：根元素 .canvas-stage，
 * Fabric canvas 与 RulerOverlay 同级，标尺层 pointer-events:none。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDesignerStore } from '@/design/stores/designer'
import { useUiStore } from '@/design/stores/ui'
import { useDragAdd } from '@/design/hooks/useDragAdd'
import { useHotkey } from '@/design/hooks/useHotkey'
import { loadBuiltinFonts } from '@/core/fonts/loader'
import RulerOverlay from './rulers/RulerOverlay.vue'
import TableViewLayer from './TableViewLayer.vue'
import ChartViewLayer from './ChartViewLayer.vue'
import MathViewLayer from './MathViewLayer.vue'
import { RULER_THICK } from '@/utils/constants'

const store = useDesignerStore()
const uiStore = useUiStore()

const stageRef = ref<HTMLElement | null>(null)
const canvasHostRef = ref<HTMLElement | null>(null)
const canvasElRef = ref<HTMLCanvasElement | null>(null)
const stageWidth = ref(0)
const stageHeight = ref(0)
/** 画布内核挂载就绪后再渲染表格 HTML overlay，避免 attachCanvas 前 getObjects() 取不到对象 */
const canvasReady = ref(false)

useDragAdd(canvasHostRef)
useHotkey()

// 页边距参考线显隐随 ui 开关联动（画布挂载后才生效）
watch(
  () => uiStore.showMarginGuides,
  (v) => store.designer?.setMarginGuidesVisible(v),
)

// 网格显隐/间距/颜色随 gridConfig 联动（仅视觉参考，不吸附元素）
watch(
  () => store.gridConfig.visible,
  (visible) => store.designer?.setGridVisible(visible),
)
watch(
  () => store.gridConfig.sizeMm,
  (sizeMm) => store.designer?.setGridSize(sizeMm),
)
watch(
  () => store.gridConfig.color,
  (color) => store.designer?.setGridColor(color),
)

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!canvasElRef.value || !canvasHostRef.value || !stageRef.value) return
  const host = canvasHostRef.value
  stageWidth.value = host.clientWidth
  stageHeight.value = host.clientHeight
  store.attachCanvas(canvasElRef.value, host)
  canvasReady.value = true
  // 初始同步页边距参考线显隐开关
  store.designer?.setMarginGuidesVisible(uiStore.showMarginGuides)
  // 初始同步网格（视觉 + 间距 + 颜色；网格不吸附元素）
  store.designer?.setGridVisible(store.gridConfig.visible)
  store.designer?.setGridSize(store.gridConfig.sizeMm)
  store.designer?.setGridColor(store.gridConfig.color)
  // 内置字体（思源黑体/宋体/楷体等）注册到 document.fonts，加载完成后刷新画布让 Fabric 生效
  void loadBuiltinFonts().then(() => {
    document.fonts?.ready.then(() => store.designer?.canvas.requestRenderAll()).catch(() => undefined)
  })
  // 启动恢复：本地存储有上次保存的模板则加载（无后端全链路可用）
  void store.restoreLastTemplate()
  // dev 调试句柄
  if (import.meta.env.DEV) {
    ;(window as unknown as { __op: unknown }).__op = store
  }

  resizeObserver = new ResizeObserver(() => {
    stageWidth.value = host.clientWidth
    stageHeight.value = host.clientHeight
  })
  resizeObserver.observe(host)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  store.detachCanvas()
})
</script>

<template>
  <div ref="stageRef" class="canvas-stage relative h-full w-full overflow-hidden bg-[#e8eaed]">
    <!-- Fabric canvas 宿主（留出标尺厚度） -->
    <div
      ref="canvasHostRef"
      class="absolute"
      :style="{ top: `${RULER_THICK}px`, left: `${RULER_THICK}px`, right: '0', bottom: '0' }"
    >
      <canvas ref="canvasElRef" style="touch-action: none" />
      <!-- 表格 HTML overlay（方案 A）：与 Fabric 节点同步，平时不拦截指针 -->
      <TableViewLayer v-if="canvasReady" />
      <!-- 图表 SVG overlay（方案 A）：同上，原生 SVG 矢量覆盖 -->
      <ChartViewLayer v-if="canvasReady" />
      <!-- 公式 KaTeX HTML overlay（方案 A）：同上，KaTeX 矢量字体覆盖 -->
      <MathViewLayer v-if="canvasReady" />
    </div>

    <!-- 标尺覆盖层（只看不拦截事件） -->
    <RulerOverlay v-if="stageWidth > 0" :stage-width="stageWidth" :stage-height="stageHeight" />
  </div>
</template>
