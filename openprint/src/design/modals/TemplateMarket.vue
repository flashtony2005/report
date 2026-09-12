<script setup lang="ts">
/**
 * TemplateMarket —— 模板市场弹窗（TopToolbar「模板市场」入口）
 * 左侧分类 + 右侧模板卡片网格；点击「使用」直接加载到画布（dirty 时确认）。
 */
import { computed, ref } from 'vue'
import { NButton, NEmpty, NInput, NModal, NText, useMessage } from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import { useConfirm } from '@/design/composables/useConfirm'
import {
  MARKET_CATEGORY_LABEL,
  MARKET_TEMPLATES,
  type MarketCategory,
  type MarketTemplate,
} from '@/repository/mock/data/market-templates'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const store = useDesignerStore()
const message = useMessage()
const { confirm } = useConfirm()

type Filter = 'all' | MarketCategory
const activeFilter = ref<Filter>('all')
const keyword = ref('')

const CATEGORY_ICON: Record<MarketCategory, string> = {
  invoice: 'i-carbon-document',
  report: 'i-carbon-analytics',
  receipt: 'i-carbon-receipt',
  thermal: 'i-carbon-document-horizontal',
  label: 'i-carbon-tag',
  resume: 'i-carbon-user',
  contract: 'i-carbon-document',
  doc: 'i-carbon-notebook',
}

const filtered = computed(() => {
  const kw = keyword.value.trim()
  return MARKET_TEMPLATES.filter((t) => {
    if (activeFilter.value !== 'all' && t.category !== activeFilter.value) return false
    if (kw && !`${t.name}${t.desc}`.toLowerCase().includes(kw.toLowerCase())) return false
    return true
  })
})

async function useTemplate(tpl: MarketTemplate): Promise<void> {
  if (store.dirty && !(await confirm(`使用「${tpl.name}」将覆盖当前未保存的改动。确定继续？`))) return
  store.loadTemplate({ id: tpl.id, name: tpl.name, data: tpl.build() })
  emit('update:show', false)
  message.success(`已载入模板：${tpl.name}`)
}

function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    title="模板市场"
    style="width: 780px; max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="flex h-480px gap-4">
      <!-- 左侧分类 -->
      <div class="w-130px flex-shrink-0 border-r border-brand-border pr-3">
        <div
          class="market-cat-item"
          :class="{ 'is-active': activeFilter === 'all' }"
          @click="activeFilter = 'all'"
        >
          <div class="i-carbon-template text-16px" />
          <span class="text-13px">全部</span>
          <span class="market-count">{{ MARKET_TEMPLATES.length }}</span>
        </div>
        <div
          v-for="(label, key) in MARKET_CATEGORY_LABEL"
          :key="key"
          class="market-cat-item"
          :class="{ 'is-active': activeFilter === key }"
          @click="activeFilter = key"
        >
          <div :class="CATEGORY_ICON[key]" class="text-16px" />
          <span class="text-13px">{{ label }}</span>
          <span class="market-count">{{ MARKET_TEMPLATES.filter((t) => t.category === key).length }}</span>
        </div>
      </div>

      <!-- 右侧模板卡片 -->
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="mb-2">
          <NInput v-model:value="keyword" size="small" placeholder="搜索模板名称 / 描述" clearable />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <NEmpty v-if="filtered.length === 0" description="没有匹配的模板" class="mt-16" />
          <div v-else class="grid grid-cols-2 gap-3 pr-1">
            <div v-for="tpl in filtered" :key="tpl.id" class="market-card">
              <!-- 迷你纸张缩略示意 -->
              <div class="flex items-center gap-3">
                <div class="mini-paper flex-shrink-0" :style="miniBox(tpl)">
                  <div class="mini-line" style="width: 70%" />
                  <div class="mini-line" style="width: 55%" />
                  <div class="mini-line" style="width: 80%" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <div :class="CATEGORY_ICON[tpl.category]" class="text-13px text-brand-text-3" />
                    <span class="truncate text-13px font-medium">{{ tpl.name }}</span>
                  </div>
                  <NText depth="3" class="block text-11px mt-0.5">{{ tpl.sizeLabel }}</NText>
                </div>
              </div>
              <NText depth="3" class="block text-12px leading-4 mt-2 market-desc">{{ tpl.desc }}</NText>
              <div class="mt-2">
                <NButton size="tiny" type="primary" secondary @click="useTemplate(tpl)">使用</NButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-between">
        <NText depth="3" class="text-12px">共 {{ MARKET_TEMPLATES.length }} 个预设模板，点击「使用」直接载入画布</NText>
        <NButton size="small" @click="close">关闭</NButton>
      </div>
    </template>
  </NModal>
</template>

<script lang="ts">
import type { CSSProperties } from 'vue'

/** 按纸张宽高比生成迷你缩略矩形（fit 52×64 盒） */
function aspect(wMm: number, hMm: number, maxW = 52, maxH = 64): { w: number; h: number } {
  const scale = Math.min(maxW / wMm, maxH / hMm)
  return { w: Math.max(24, Math.round(wMm * scale)), h: Math.max(16, Math.round(hMm * scale)) }
}

/** 计算迷你纸张尺寸（直接用条目上的纸张宽高，避免渲染时重建模板） */
function miniBox(tpl: MarketTemplate): CSSProperties {
  const size = aspect(tpl.pageW, tpl.pageH)
  return { width: `${size.w}px`, height: `${size.h}px` }
}
</script>

<style scoped>
.market-cat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  margin-bottom: 2px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--brand-text-2);
  transition:
    background 0.15s,
    color 0.15s;
}
.market-cat-item:hover {
  background: var(--brand-surface-hover, rgba(128, 128, 128, 0.08));
}
.market-cat-item.is-active {
  background: rgba(22, 119, 255, 0.12);
  color: var(--brand-primary);
}
.market-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--brand-text-3);
}
.market-card {
  display: flex;
  flex-direction: column;
  padding: 12px;
  border: 1px solid var(--brand-border);
  border-radius: 10px;
  background: var(--brand-surface);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.market-card:hover {
  border-color: var(--brand-primary);
  box-shadow: 0 2px 8px rgba(22, 119, 255, 0.12);
}
.market-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 迷你纸张：淡蓝描边 + 三条示意线 */
.mini-paper {
  border: 1px solid #b9d2ff;
  border-radius: 2px;
  background: #f6f9ff;
  padding: 3px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
}
.mini-line {
  height: 2px;
  border-radius: 1px;
  background: #c3d6ff;
}
</style>
