<script setup lang="ts">
/**
 * TableStylePickerModal —— 表格「样式库」预览弹窗（Excel 式快速切换）。
 *
 * 不再是下拉框盲选：以网格卡片展示每种预设的**真实渲染效果**（与设计画布 / 预览 / PDF
 * 同一份 `.op-table` CSS），点击卡片即应用并关闭。预设元信息来自 table-style-presets.ts。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { NButton, NModal, NText } from 'naive-ui'
import type { TableStylePreset } from '@/types/control'
import { tableCss } from '@/core/renderer-html/css-generator'
import { TABLE_STYLE_PRESETS } from '@/design/canvas/table-style-presets'

const props = defineProps<{
  show: boolean
  /** 当前已选预设（用于高亮） */
  current?: TableStylePreset
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'select', key: TableStylePreset): void
}>()

/** 预览样例行（与渲染端同构：is-header / is-data / is-summary 类驱动预设视觉效果） */
const SAMPLE_ROWS = `
  <tr class="is-header"><td>产品</td><td>数量</td><td>金额</td></tr>
  <tr class="is-data"><td>商品 A</td><td>12</td><td>240.00</td></tr>
  <tr class="is-data"><td>商品 B</td><td>8</td><td>160.00</td></tr>
  <tr class="is-data"><td>商品 C</td><td>5</td><td>90.00</td></tr>
  <tr class="is-summary"><td>合计</td><td>25</td><td>490.00</td></tr>`

/** 为某个预设生成一张可点击的预览表 HTML（无用户输入，v-html 安全） */
function previewHtml(key: TableStylePreset): string {
  const borders = TABLE_STYLE_PRESETS.find((p) => p.key === key)?.borders ?? 'all'
  return (
    `<table class="op-table b-${borders} va-middle ts-${key}">` +
    `<colgroup><col style="width:42%"><col style="width:20%"><col style="width:38%"></colgroup>` +
    `<tbody>${SAMPLE_ROWS}</tbody></table>`
  )
}

/** 全局注入 .op-table 规则，使弹窗内的预览表（不在 .op-table-overlay 内）正确着色 */
const STYLE_ID = 'op-style-gallery-css'
function injectGlobalTableCss(): void {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = tableCss()
  document.head.appendChild(el)
}
function removeGlobalTableCss(): void {
  document.getElementById(STYLE_ID)?.remove()
}

onMounted(injectGlobalTableCss)
onBeforeUnmount(removeGlobalTableCss)

const presets = computed(() => TABLE_STYLE_PRESETS)

function pick(key: TableStylePreset): void {
  emit('select', key)
  emit('update:show', false)
}
function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    display-directive="if"
    title="表格样式库"
    :mask-closable="false"
    style="width: 720px; max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <NText depth="3" class="text-12px">
      点击任意样式即可套用，画布 / 预览 / 导出效果与此预览完全一致（类似 Excel 表格样式快速切换）。
    </NText>

    <div class="ts-gallery">
      <button
        v-for="p in presets"
        :key="p.key"
        type="button"
        class="style-card"
        :class="{ 'is-selected': p.key === props.current }"
        @click="pick(p.key)"
      >
        <div class="style-preview" v-html="previewHtml(p.key)" />
        <div class="style-meta">
          <span class="style-label">{{ p.label }}</span>
          <span class="i-carbon-checkmark-outline style-check" />
        </div>
        <div class="style-desc">{{ p.desc }}</div>
      </button>
    </div>

    <template #footer>
      <div class="flex justify-end">
        <NButton size="small" @click="close">取消</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.ts-gallery {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  max-height: 62vh;
  overflow: auto;
  padding: 2px;
}

.style-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.05s;
}
.style-card:hover {
  border-color: #2f54eb;
  box-shadow: 0 2px 10px rgba(47, 84, 235, 0.12);
}
.style-card:active {
  transform: translateY(1px);
}
.style-card.is-selected {
  border: 2px solid #2f54eb;
  background: #f5f8ff;
  padding: 7px;
}

.style-preview {
  border: 1px solid #eee;
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}
/* 预览表压缩内边距 / 字号，使缩略图紧凑且不溢出卡片 */
.style-preview :deep(.op-table) {
  width: 100%;
  font-size: 9px;
}
.style-preview :deep(.op-table td) {
  padding: 2px 4px;
}

.style-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.style-label {
  font-size: 13px;
  font-weight: 600;
}
.style-check {
  font-size: 15px;
  color: #2f54eb;
  opacity: 0;
}
.style-card.is-selected .style-check {
  opacity: 1;
}
.style-desc {
  font-size: 11px;
  color: #8a8f99;
  line-height: 1.3;
}
</style>
