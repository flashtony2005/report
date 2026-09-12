<script setup lang="ts">
/**
 * RulerOverlay —— SVG 标尺覆盖层
 *
 * 水平（顶）+ 垂直（左）标尺，mm 刻度自适应缩放密度。
 * 监听 CanvasDesigner.onViewportChange 驱动重绘，
 * 坐标遵循 页面左上角=(0,0) + 1mm=MM_TO_PX px 的约定。
 *
 * CanvasStage 已预留 RULER_THICK(20px) 给标尺，画布向右下偏移。
 */
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { useDesignerStore } from '@/design/stores/designer'
import { useUiStore } from '@/design/stores/ui'
import { MM_TO_PX, RULER_THICK, RULER_PALETTE_LIGHT, RULER_PALETTE_DARK } from '@/utils/constants'
import { getRulerBand, onRulerBandChange, type RulerBand } from './rulerHighlight'

interface Tick {
  coord: number
  major: boolean
  label: string | null
}

const props = defineProps<{
  stageWidth: number
  stageHeight: number
}>()

const store = useDesignerStore()
const uiStore = useUiStore()

const palette = computed(() =>
  uiStore.effectiveTheme !== 'light' ? RULER_PALETTE_DARK : RULER_PALETTE_LIGHT,
)

/* ---------- 刻度密度选择 ---------- */

function tickStep(zoom: number): number {
  if (zoom >= 2) return 1
  if (zoom >= 1) return 5
  if (zoom >= 0.5) return 10
  return 20
}

/* ---------- 水平标尺刻度 ---------- */

const hTicks = computed<Tick[]>(() => {
  const vp = store.viewport
  const zoom = vp.zoom
  const offsetX = vp.offsetX + RULER_THICK // 画布在 stage 内右移 20px
  const w = props.stageWidth
  const step = tickStep(zoom)

  // 可见 canvas mm 范围
  const startMm = Math.floor((-offsetX) / (MM_TO_PX * zoom))
  const endMm = Math.ceil((-offsetX + w) / (MM_TO_PX * zoom))
  const start = Math.floor(startMm / step) * step

  const ticks: Tick[] = []
  for (let mm = start; mm <= endMm; mm += step) {
    const x = mm * MM_TO_PX * zoom + offsetX
    if (x < RULER_THICK || x > w) continue
    ticks.push({ coord: x, major: true, label: String(mm) })
  }
  return ticks
})

/* ---------- 垂直标尺刻度 ---------- */

const vTicks = computed<Tick[]>(() => {
  const vp = store.viewport
  const zoom = vp.zoom
  const offsetY = vp.offsetY + RULER_THICK
  const h = props.stageHeight
  const step = tickStep(zoom)

  const startMm = Math.floor((-offsetY) / (MM_TO_PX * zoom))
  const endMm = Math.ceil((-offsetY + h) / (MM_TO_PX * zoom))
  const start = Math.floor(startMm / step) * step

  const ticks: Tick[] = []
  for (let mm = start; mm <= endMm; mm += step) {
    const y = mm * MM_TO_PX * zoom + offsetY
    if (y < RULER_THICK || y > h) continue
    ticks.push({ coord: y, major: true, label: String(mm) })
  }
  return ticks
})

/* ---------- 选中/拖拽元素在标尺上的高亮带 ---------- */

// rulerBand 是框架无关的共享状态（无 Vue 响应式），用 shallowRef 订阅保持响应式
const bandRef = shallowRef<RulerBand | null>(getRulerBand())
let unsubBand: (() => void) | null = null
onMounted(() => {
  unsubBand = onRulerBandChange((v) => (bandRef.value = v))
  // 补上挂载前发生过的更新（SmartGuides 可能在组件挂载前就已写入）
  bandRef.value = getRulerBand()
})
onBeforeUnmount(() => unsubBand?.())

const band = computed(() => {
  const hb = bandRef.value
  if (!hb) return null
  const vp = store.viewport
  const zoom = vp.zoom
  const offsetX = vp.offsetX + RULER_THICK
  const offsetY = vp.offsetY + RULER_THICK
  const x1 = hb.left * zoom + offsetX
  const x2 = (hb.left + hb.width) * zoom + offsetX
  const y1 = hb.top * zoom + offsetY
  const y2 = (hb.top + hb.height) * zoom + offsetY
  return {
    x1, x2, y1, y2,
    /** 顶标尺带宽度（px） */
    wPx: x2 - x1,
    /** 左标尺带高度（px） */
    hPx: y2 - y1,
    /** 元素宽度（mm） */
    widthMm: hb.width / MM_TO_PX,
    /** 元素高度（mm） */
    heightMm: hb.height / MM_TO_PX,
    /** 左标尺高度标签的旋转中心 y */
    hLabelCy: (y1 + y2) / 2,
  }
})
</script>

<template>
  <div
    class="pointer-events-none absolute inset-0 select-none"
    :style="{ zIndex: 10 }"
  >
    <svg :width="stageWidth" :height="stageHeight" class="block">
      <!-- 水平标尺背景 -->
      <rect
        x="0" y="0"
        :width="stageWidth" :height="RULER_THICK"
        :fill="palette.bgColor"
      />
      <!-- 水平标尺刻度线 -->
      <line
        v-for="t in hTicks" :key="'h' + t.coord"
        :x1="t.coord" :y1="t.coord % 2 === 0 ? 10 : 14"
        :x2="t.coord" :y2="RULER_THICK"
        :stroke="palette.tickColor"
        stroke-width="1"
      />
      <!-- 水平标尺文字 -->
      <text
        v-for="t in hTicks.filter(t => t.label)" :key="'ht' + t.coord"
        :x="t.coord + 2"
        :y="RULER_THICK - 5"
        :fill="palette.labelColor"
        font-size="10"
        font-family="Inter, PingFang SC, sans-serif"
      >{{ t.label }}</text>

      <!-- 垂直标尺背景 -->
      <rect
        x="0" y="0"
        :width="RULER_THICK" :height="stageHeight"
        :fill="palette.bgColor"
      />
      <!-- 垂直标尺刻度线 -->
      <line
        v-for="t in vTicks" :key="'v' + t.coord"
        :y1="t.coord" :x1="t.coord % 2 === 0 ? 10 : 14"
        :y2="t.coord" :x2="RULER_THICK"
        :stroke="palette.tickColor"
        stroke-width="1"
      />
      <!-- 垂直标尺文字 -->
      <text
        v-for="t in vTicks.filter(t => t.label)" :key="'vt' + t.coord"
        :y="t.coord + 8"
        :x="3"
        :fill="palette.labelColor"
        font-size="9"
        font-family="Inter, PingFang SC, sans-serif"
        transform-origin="0 0"
      >{{ t.label }}</text>

      <!-- 选中/拖拽元素高亮带：顶标尺带=宽度，左标尺带=高度，随移动丝滑滑动 -->
      <template v-if="band">
        <rect
          :x="band.x1" y="0"
          :width="Math.max(0, band.wPx)" :height="RULER_THICK"
          :fill="palette.bandColor" :stroke="palette.bandBorder" stroke-width="1"
        />
        <rect
          x="0" :y="band.y1"
          :width="RULER_THICK" :height="Math.max(0, band.hPx)"
          :fill="palette.bandColor" :stroke="palette.bandBorder" stroke-width="1"
        />
        <!-- 宽度标签（顶标尺带中央，px 足够宽才显示） -->
        <text
          v-if="band.wPx >= 26"
          :x="(band.x1 + band.x2) / 2" :y="RULER_THICK - 6"
          :fill="palette.bandText" font-size="10" text-anchor="middle"
          font-family="Inter, PingFang SC, sans-serif"
        >{{ band.widthMm.toFixed(1) }}</text>
        <!-- 高度标签（左标尺带中央，竖排；px 足够高才显示） -->
        <text
          v-if="band.hPx >= 26"
          :x="RULER_THICK / 2" :y="band.hLabelCy"
          :fill="palette.bandText" font-size="10" text-anchor="middle"
          :transform="`rotate(-90 ${RULER_THICK / 2} ${band.hLabelCy})`"
          font-family="Inter, PingFang SC, sans-serif"
        >{{ band.heightMm.toFixed(1) }}</text>
      </template>

      <!-- 角标（标尺交叉的方角） -->
      <rect
        x="0" y="0"
        :width="RULER_THICK" :height="RULER_THICK"
        :fill="palette.bgColor"
        stroke="transparent"
      />
    </svg>
  </div>
</template>
