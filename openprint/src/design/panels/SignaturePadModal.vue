<script setup lang="ts">
/**
 * SignaturePadModal —— 弹出式手写签名面板（WPS 式）
 *
 * 用户体验目标：点「签名」→ 弹小画板写出来 → 「插入」后作为对象落到主画布，
 * 避免在正文画布上直接乱画误改别的组件。
 *
 * - 笔迹以"笔画栈"存储（每笔 = 点序列 + 笔宽 + 笔色），支持「撤销 / 清空」并重绘；
 * - 确认时按实际笔迹包围盒裁剪透明留白，导出 PNG（2× 高清），控件宽高 = 包围盒(mm) 不变形；
 * - 落点：正文区默认位置（60mm, 60mm），与公式/图表一致。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { NModal, NSlider, NInputNumber, NColorPicker, NButton, NText, useMessage } from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'

const store = useDesignerStore()
const message = useMessage()

/** 画板逻辑尺寸（CSS px）；满宽映射 60mm，保证插入尺寸自然 */
const PAD_W = 480
const PAD_H = 220
/** 1 CSS px → mm（满宽 480px = 60mm） */
const PX_TO_MM = 60 / PAD_W
/** 导出倍率：导出 PNG 用 2× 保证打印清晰 */
const EXPORT_SCALE = 2

const canvasRef = ref<HTMLCanvasElement | null>(null)
/** 当前是否处于签名弹窗打开态（受 store 控制） */
const open = computed(() => store.signatureModalOpen)

interface Point { x: number; y: number }
interface Stroke { points: Point[]; penWidth: number; color: string }

const strokes = ref<Stroke[]>([])
const penWidth = ref(1)
const penColor = ref('#000000')
const drawing = ref(false)

const hasContent = computed(() => strokes.value.some((s) => s.points.length > 0))

const PRESET_COLORS = ['#000000', '#d4380d', '#1677ff', '#237804', '#722ed1']

let dpr = 1

function getCtx(): CanvasRenderingContext2D | null {
  const el = canvasRef.value
  if (!el) return null
  return el.getContext('2d')
}

/** 初始化画板尺寸 + 清空 */
function setupCanvas(): void {
  const el = canvasRef.value
  if (!el) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  el.width = Math.round(PAD_W * dpr)
  el.height = Math.round(PAD_H * dpr)
  el.style.width = `${PAD_W}px`
  el.style.height = `${PAD_H}px`
  redraw()
}

/** 重绘全部笔画（clear + replay），用于清空 / 撤销 / 尺寸就绪 */
function redraw(): void {
  const ctx = getCtx()
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, PAD_W * dpr, PAD_H * dpr)
  ctx.scale(dpr, dpr)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of strokes.value) drawStroke(ctx, s)
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.points.length === 0) return
  ctx.strokeStyle = s.color
  ctx.lineWidth = s.penWidth
  if (s.points.length === 1) {
    // 单点：画一个圆点，避免点一下没痕迹
    const p = s.points[0]!
    ctx.beginPath()
    ctx.arc(p.x, p.y, s.penWidth / 2, 0, Math.PI * 2)
    ctx.fillStyle = s.color
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(s.points[0]!.x, s.points[0]!.y)
  for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i]!.x, s.points[i]!.y)
  ctx.stroke()
}

function pointerPos(e: PointerEvent): Point {
  const el = canvasRef.value!
  const rect = el.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * PAD_W
  const y = ((e.clientY - rect.top) / rect.height) * PAD_H
  return { x: Math.max(0, Math.min(PAD_W, x)), y: Math.max(0, Math.min(PAD_H, y)) }
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault()
  const el = canvasRef.value
  if (!el) return
  el.setPointerCapture(e.pointerId)
  drawing.value = true
  const p = pointerPos(e)
  strokes.value.push({ points: [p], penWidth: penWidth.value, color: penColor.value })
  const ctx = getCtx()
  if (ctx) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.fillStyle = penColor.value
    ctx.beginPath()
    ctx.arc(p.x, p.y, penWidth.value / 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!drawing.value) return
  e.preventDefault()
  const stroke = strokes.value[strokes.value.length - 1]
  if (!stroke) return
  const p = pointerPos(e)
  const last = stroke.points[stroke.points.length - 1]!
  stroke.points.push(p)
  const ctx = getCtx()
  if (ctx) {
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = stroke.penWidth
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  }
}

function onPointerUp(e: PointerEvent): void {
  if (!drawing.value) return
  drawing.value = false
  canvasRef.value?.releasePointerCapture?.(e.pointerId)
}

function clearPad(): void {
  strokes.value = []
  redraw()
}

function undoStroke(): void {
  strokes.value.pop()
  redraw()
}

/** 计算笔迹在画板中的最小包围盒（CSS px） */
function trimmedBounds(): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes.value) {
    for (const p of s.points) {
      // 笔宽外扩半个线宽，避免裁掉边缘
      const r = s.penWidth / 2
      minX = Math.min(minX, p.x - r)
      minY = Math.min(minY, p.y - r)
      maxX = Math.max(maxX, p.x + r)
      maxY = Math.max(maxY, p.y + r)
    }
  }
  if (!Number.isFinite(minX)) return null
  const x = Math.max(0, Math.floor(minX))
  const y = Math.max(0, Math.floor(minY))
  const w = Math.min(PAD_W, Math.ceil(maxX)) - x
  const h = Math.min(PAD_H, Math.ceil(maxY)) - y
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/** 导出裁剪后的 PNG data-URI（EXPORT_SCALE 倍分辨率） */
function exportPng(): string | null {
  const bounds = trimmedBounds()
  if (!bounds) return null
  const el = canvasRef.value!
  const out = document.createElement('canvas')
  out.width = Math.round(bounds.w * EXPORT_SCALE)
  out.height = Math.round(bounds.h * EXPORT_SCALE)
  const octx = out.getContext('2d')!
  // 从主画板（backing 坐标 = css * dpr）裁剪对应区域到导出画板
  octx.drawImage(
    el,
    bounds.x * dpr,
    bounds.y * dpr,
    bounds.w * dpr,
    bounds.h * dpr,
    0,
    0,
    out.width,
    out.height,
  )
  return out.toDataURL('image/png')
}

const round1 = (v: number) => Math.round(v * 10) / 10

function confirmInsert(): void {
  if (!hasContent.value) {
    message.warning('请先写下签名')
    return
  }
  const src = exportPng()
  if (!src) {
    message.error('签名导出失败')
    return
  }
  const bounds = trimmedBounds()!
  const widthMm = Math.max(8, round1(bounds.w * PX_TO_MM))
  const heightMm = Math.max(6, round1(bounds.h * PX_TO_MM))
  // 拖入画布时记录落点；点击插入则回落到内容区默认位置
  const drop = store.pendingSignatureDrop
  store.pendingSignatureDrop = null
  store.addControlOfType(
    'signature',
    drop ?? { leftMm: 60, topMm: 60 },
    { src, penWidth: penWidth.value, color: penColor.value, width: widthMm, height: heightMm },
  )
  message.success('已插入签名')
  close()
}

function close(): void {
  store.pendingSignatureDrop = null
  store.closeSignaturePad()
}

// 每次打开重置画板
watch(open, (v) => {
  if (v) {
    strokes.value = []
    penWidth.value = 1
    penColor.value = '#000000'
    // 等 DOM 挂载后再初始化画板尺寸
    requestAnimationFrame(() => setupCanvas())
  }
})

onMounted(() => {
  if (open.value) requestAnimationFrame(() => setupCanvas())
})
</script>

<template>
  <NModal
    :show="open"
    preset="card"
    title="手写签名"
    style="width: 560px"
    :mask-closable="false"
    @update:show="(v: boolean) => !v && close()"
  >
    <div class="flex flex-col gap-3">
      <!-- 笔迹画板 -->
      <div class="signature-pad-wrap">
        <canvas
          ref="canvasRef"
          class="signature-pad"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointerleave="onPointerUp"
          @pointercancel="onPointerUp"
        />
      </div>

      <!-- 工具栏：笔色 + 笔宽 + 撤销/清空 -->
      <div class="flex items-center gap-3 flex-wrap">
        <div class="flex items-center gap-1">
          <span
            v-for="c in PRESET_COLORS"
            :key="c"
            class="color-dot"
            :class="{ 'color-dot-active': penColor === c }"
            :style="{ background: c }"
            @click="penColor = c"
          />
          <NColorPicker
            size="small"
            :modes="['hex']"
            :show-alpha="false"
            :value="penColor"
            style="width: 64px"
            @update:value="penColor = $event"
          />
        </div>

        <div class="flex items-center gap-2" style="min-width: 200px">
          <NText depth="3" style="font-size: 12px">画笔粗细</NText>
          <NSlider
            :value="penWidth"
            :min="1"
            :max="20"
            :step="1"
            style="width: 120px"
            @update:value="penWidth = $event"
          />
          <NInputNumber
            size="small"
            :value="penWidth"
            :min="1"
            :max="20"
            :step="1"
            style="width: 64px"
            @update:value="penWidth = $event ?? 1"
          />
        </div>

        <NButton size="small" tertiary :disabled="!strokes.length" @click="undoStroke">撤销</NButton>
        <NButton size="small" tertiary :disabled="!hasContent" @click="clearPad">清空</NButton>
      </div>

      <NText depth="3" style="font-size: 12px">
        在上方区域手写签名，确认后将以图片形式插入画布（可调位置/大小）。
      </NText>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton size="small" @click="close">取消</NButton>
        <NButton size="small" type="primary" :disabled="!hasContent" @click="confirmInsert">插入</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.signature-pad-wrap {
  display: flex;
  justify-content: center;
  padding: 8px;
  background: #fff;
  border: 1px dashed var(--brand-border);
  border-radius: 8px;
}
.signature-pad {
  touch-action: none;
  cursor: crosshair;
  border-radius: 4px;
  background:
    repeating-linear-gradient(0deg, transparent, transparent 21px, #eef0f3 21px, #eef0f3 22px);
}
.color-dot {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
  border: 2px solid transparent;
  box-sizing: border-box;
}
.color-dot-active {
  border-color: var(--brand-primary);
}
</style>
