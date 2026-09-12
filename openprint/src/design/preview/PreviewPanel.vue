<script setup lang="ts">
/**
 * PreviewPanel —— 多页打印预览（Phase 7 验收出口）
 *
 * ## 为什么用 iframe 而不是直接挂 DOM
 *
 * 渲染产物自带一整套 `@page` / `html,body` / `.op-*` 全局样式，直接注入设计器页面会：
 * 1. 被设计器的 reset / unocss 规则污染，预览和最终打印对不上（预览就失去意义）
 * 2. 反过来把 `@page`、`print-color-adjust` 泄漏给设计器，Ctrl+P 时打出画布
 *
 * iframe 用 `srcdoc` 装载，同源可访问 contentDocument，
 * 因此缩放（改 CSS 变量）和翻页（滚动定位）都不必重新渲染 HTML。
 *
 * ## 打印一致性
 *
 * 打印走 `iframe.contentWindow.print()`，打的就是预览的同一份 DOM 与同一份 CSS，
 * 从机制上保证「预览 = 打印」，而不是靠两套代码去"对齐"。
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  NButton,
  NPopover,
  NModal,
  NSpin,
  NTooltip,
  useMessage,
} from 'naive-ui'
import { render } from '@/core/sdk'
import type { RenderWarning } from '@/core/layout-engine/types'
import { mmToPx } from '@/core/units'
import { builtinFontFaceCss } from '@/core/fonts/loader'
import { useSystemFonts } from '@/design/composables/useSystemFonts'
import { useDataSourceStore } from '@/design/stores/dataSource'
import { useDesignerStore } from '@/design/stores/designer'
import { WARNING_LABEL, SCALE_MIN, SCALE_MAX, SCALE_STEP, clampScale } from './shared/preview-logic'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const store = useDesignerStore()
const dsStore = useDataSourceStore()
const message = useMessage()

const iframeRef = ref<HTMLIFrameElement | null>(null)
const scrollHostRef = ref<HTMLElement | null>(null)

const html = ref('')
const rendering = ref(false)
const errorText = ref('')
const warnings = ref<RenderWarning[]>([])
const totalPages = ref(0)
const currentPage = ref(1)
const pageWidthMm = ref(210)

const scale = ref(0.5)

const warningCount = computed(() => warnings.value.length)

/* ------------------------------- 渲染 ------------------------------- */

async function doRender(): Promise<void> {
  rendering.value = true
  errorText.value = ''
  try {
    const template = store.buildTemplate()
    const data = dsStore.previewData

    const res = await render({
      template,
      data,
      output: {
        screen: true,
        scale: 1,
        title: store.templateName,
        pageDecoration: {
          backgroundColor: store.pageSetup.backgroundColor ?? '#ffffff',
          watermark: store.pageSetup.watermark,
        },
      },
    })

    html.value = res.html
    warnings.value = res.warnings
    totalPages.value = res.pages
    pageWidthMm.value = res.result.metrics.pageWidth
    currentPage.value = 1

    await nextTick()
    // srcdoc 换了内容要等 load 才能拿到 contentDocument，交给 onIframeLoad 收尾
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : String(e)
    html.value = ''
    totalPages.value = 0
  } finally {
    rendering.value = false
  }
}

/* ------------------------------- 缩放 ------------------------------- */

function applyScale(): void {
  const doc = iframeRef.value?.contentDocument
  if (!doc) return
  doc.documentElement.style.setProperty('--op-scale', String(scale.value))
}

/** 适应宽度：按可视宽度反推缩放比（留 40px 给滚动条与留白） */
function fitWidth(): void {
  const host = iframeRef.value
  if (!host) return
  const avail = host.clientWidth - 40
  const pagePx = mmToPx(pageWidthMm.value)
  if (avail > 0 && pagePx > 0) scale.value = clampScale(Math.max(0.2, Math.round((avail / pagePx) * 100) / 100))
}

/** 按固定步长（25%）缩放：dir=1 放大 / -1 缩小 */
function zoomBy(dir: 1 | -1): void {
  scale.value = clampScale(scale.value + dir * SCALE_STEP)
}

/** Ctrl / ⌘ + 滚轮缩放：在 iframe 内容窗口上捕获，阻止浏览器页面缩放 */
function onPreviewWheel(e: WheelEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return
  e.preventDefault()
  e.stopPropagation()
  zoomBy(e.deltaY > 0 ? -1 : 1)
}

/** iframe 重新加载（srcdoc 变化）后 window 是新的，需要重新挂载 wheel 监听 */
let wheelWin: Window | null = null
function attachPreviewWheel(): void {
  const win = iframeRef.value?.contentWindow
  if (!win || win === wheelWin) return
  wheelWin = win
  win.addEventListener('wheel', onPreviewWheel, { passive: false })
}

watch(scale, applyScale)

/* ------------------------------- 翻页 ------------------------------- */

function pageEls(): HTMLElement[] {
  const doc = iframeRef.value?.contentDocument
  if (!doc) return []
  return Array.from(doc.querySelectorAll<HTMLElement>('.op-page-wrap'))
}

function gotoPage(n: number): void {
  const target = Math.min(Math.max(1, n), Math.max(1, totalPages.value))
  const el = pageEls()[target - 1]
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  currentPage.value = target
}

function syncCurrentPage(): void {
  const win = iframeRef.value?.contentWindow
  if (!win) return
  const top = win.scrollY + 60
  const els = pageEls()
  let idx = 0
  for (let i = 0; i < els.length; i++) {
    if (els[i]!.offsetTop <= top) idx = i
    else break
  }
  currentPage.value = idx + 1
}

function onIframeLoad(): void {
  applyScale()
  injectFonts()
  attachPreviewWheel()
  const win = iframeRef.value?.contentWindow
  win?.addEventListener('scroll', syncCurrentPage, { passive: true })
}

/** 向 iframe head 注入内置字体 @font-face（绝对 URL，srcdoc 内可加载同源 /fonts/）
 *  以及连接到打印客户端时的电脑系统字体 @font-face（src 指向客户端 /api/fonts/data） */
function injectFonts(): void {
  const doc = iframeRef.value?.contentDocument
  if (!doc || typeof window === 'undefined') return
  if (doc.getElementById('op-fonts')) return
  const style = doc.createElement('style')
  style.id = 'op-fonts'
  const sys = useSystemFonts().systemFontFaceCss()
  style.textContent = builtinFontFaceCss(window.location.origin) + (sys ? `\n/* 电脑系统字体（来自打印客户端）*/\n${sys}` : '')
  doc.head.appendChild(style)
}

/* ------------------------------- 打印 ------------------------------- */

function doPrint(): void {
  const win = iframeRef.value?.contentWindow
  if (!win) {
    message.warning('预览尚未就绪')
    return
  }
  // 打印时强制 1:1，否则浏览器会把预览缩放一起打进去
  const doc = iframeRef.value?.contentDocument
  doc?.documentElement.style.setProperty('--op-scale', '1')
  win.focus()
  win.print()
  applyScale()
}

/* ------------------------------- 生命周期 ------------------------------- */

watch(
  () => props.show,
  (v) => {
    if (v) void doRender()
  },
)

function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="props.show"
    display-directive="if"
    :mask-closable="false"
    transform-origin="center"
    @update:show="emit('update:show', $event)"
  >
    <div class="preview-shell">
      <!-- 工具条 -->
      <header class="preview-bar">
        <div class="flex items-center gap-2">
          <div class="i-carbon-document-preliminary text-16px" />
          <span class="text-14px font-medium">打印预览</span>
          <span class="text-12px op-60">{{ store.templateName }}</span>
        </div>

        <div class="flex items-center gap-2">
          <!-- 翻页 -->
          <NButton
            quaternary
            size="small"
            :disabled="currentPage <= 1"
            @click="gotoPage(currentPage - 1)"
          >
            <div class="i-carbon-chevron-up text-14px" />
          </NButton>
          <span class="text-12px tabular-nums">
            第 {{ currentPage }} / {{ totalPages || 1 }} 页
          </span>
          <NButton
            quaternary
            size="small"
            :disabled="currentPage >= totalPages"
            @click="gotoPage(currentPage + 1)"
          >
            <div class="i-carbon-chevron-down text-14px" />
          </NButton>

          <div class="bar-sep" />

          <!-- 告警 -->
          <NPopover v-if="warningCount" placement="bottom-end" trigger="click">
            <template #trigger>
              <NButton quaternary size="small" type="warning">
                <div class="i-carbon-warning-alt mr-1 text-14px" />
                {{ warningCount }} 条告警
              </NButton>
            </template>
            <div class="warn-list">
              <div v-for="(w, i) in warnings" :key="i" class="warn-item">
                <span class="warn-code">{{ WARNING_LABEL[w.code] ?? w.code }}</span>
                <span class="warn-msg">{{ w.message }}</span>
              </div>
            </div>
          </NPopover>

          <NButton size="small" @click="doRender">
            <div class="i-carbon-renew mr-1 text-14px" />
            重新渲染
          </NButton>
          <NButton size="small" type="primary" :disabled="!totalPages" @click="doPrint">
            <div class="i-carbon-printer mr-1 text-14px" />
            浏览器打印
          </NButton>
          <NButton quaternary size="small" @click="close">
            <div class="i-carbon-close text-16px" />
          </NButton>
        </div>
      </header>

      <!-- 预览区 -->
      <div ref="scrollHostRef" class="preview-body">
        <NSpin :show="rendering" class="h-full">
          <div v-if="errorText" class="preview-error">
            <div class="i-carbon-warning-alt mb-2 text-28px" />
            <div class="text-14px font-medium">渲染失败</div>
            <div class="mt-1 max-w-560px text-12px op-70">{{ errorText }}</div>
          </div>
          <iframe
            v-else
            ref="iframeRef"
            class="preview-frame"
            title="打印预览"
            sandbox="allow-same-origin allow-modals"
            :srcdoc="html"
            @load="onIframeLoad"
          />
        </NSpin>

        <!-- 右下角缩放：适应宽度 / − / 百分比 / +（步长 25%，Ctrl+滚轮同样生效） -->
        <div class="preview-zoom">
          <button type="button" class="zoom-btn" title="适应宽度" @click="fitWidth">
            <div class="i-carbon-fit-to-width text-14px" />
          </button>
          <button type="button" class="zoom-btn" title="缩小 25%" @click="zoomBy(-1)">−</button>
          <span class="zoom-value">{{ Math.round(scale * 100) }}%</span>
          <button type="button" class="zoom-btn" title="放大 25%" @click="zoomBy(1)">+</button>
        </div>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.preview-shell {
  display: flex;
  flex-direction: column;
  width: 880px;
  max-width: 94vw;
  height: 88vh;
  overflow: hidden;
  border-radius: 10px;
  background: var(--brand-surface);
  box-shadow: 0 20px 60px -10px rgba(0, 0, 0, 0.35);
}

.preview-bar {
  display: flex;
  height: 48px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--brand-border);
  padding: 0 12px;
  color: var(--brand-text-1);
}

.bar-sep {
  width: 1px;
  height: 18px;
  background: var(--brand-border);
}

.preview-body {
  position: relative;
  min-height: 0;
  flex: 1;
  background: var(--brand-bg);
}

.preview-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

.preview-error {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--brand-text-2);
  text-align: center;
}

/* 右下角缩放控件（适应宽度 / − / 百分比 / +） */
.preview-zoom {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: var(--brand-surface);
  border: 1px solid var(--brand-border);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.zoom-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--brand-text-2);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s;
}

.zoom-btn:hover {
  background: var(--brand-bg-hover);
  color: var(--brand-text-1);
}

.zoom-value {
  min-width: 48px;
  padding: 0 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--brand-text-1);
  text-align: center;
  user-select: none;
}

.warn-list {
  display: flex;
  max-height: 320px;
  max-width: 460px;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}

.warn-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.warn-code {
  flex: none;
  border-radius: 4px;
  background: rgba(240, 160, 32, 0.16);
  padding: 0 6px;
  color: #e08a00;
}

.warn-msg {
  color: var(--brand-text-2);
  word-break: break-all;
}

:deep(.n-spin-container),
:deep(.n-spin-content) {
  height: 100%;
}
</style>
