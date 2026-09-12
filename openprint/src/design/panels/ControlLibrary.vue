<script setup lang="ts">
/**
 * ControlLibrary —— 可拖拽控件源（控件库面板）
 * 卡片可拖拽入画布；页眉/页脚为点击插入（单例）；未开放的类型置灰。
 */
import { computed, ref } from 'vue'
import { NInput, NScrollbar } from 'naive-ui'
import type { AnyControl, ControlType } from '@/types/control'
import { startControlDrag } from '@/design/hooks/control-drag'
import { useDesignerStore } from '@/design/stores/designer'

interface ControlItem {
  type:
    | ControlType
    | 'zone-header'
    | 'zone-footer'
    | 'pageno'
    | 'pagebreak'
    | 'condblock'
    | 'datablock'
    | 'circle'
    | 'labelgrid'
  label: string
  icon: string
  disabled?: boolean
  /** 拖入/插入时的初始属性补丁（如圆形 shape） */
  init?: Partial<AnyControl>
}

interface Category {
  name: string
  items: ControlItem[]
}

const store = useDesignerStore()
const keyword = ref('')

const categories: Category[] = [
  {
    name: '常用组件',
    items: [
      { type: 'text', label: '文本', icon: 'i-carbon-letter-tt' },
      { type: 'image', label: '图片', icon: 'i-carbon-image' },
      { type: 'barcode', label: '条码', icon: 'i-carbon-barcode' },
      { type: 'qrcode', label: '二维码', icon: 'i-carbon-qr-code' },
      { type: 'rect', label: '矩形', icon: 'i-carbon-square-outline' },
      { type: 'circle', label: '圆形', icon: 'i-carbon-circle-dash', init: { shape: 'circle' } },
      { type: 'line', label: '线条', icon: 'i-carbon-subtract' },
      { type: 'table', label: '表格', icon: 'i-carbon-grid' },
    ],
  },
  {
    name: '布局组件',
    items: [
      { type: 'zone-header', label: '页眉', icon: 'i-carbon-row' },
      { type: 'zone-footer', label: '页脚', icon: 'i-carbon-row' },
      { type: 'pageno', label: '页码', icon: 'i-carbon-page-number' },
      { type: 'labelgrid', label: '标签网格', icon: 'i-carbon-grid' },
    ],
  },
  {
    name: '高级组件',
    items: [
      { type: 'richtext', label: '富文本', icon: 'i-carbon-text-annotation-toggle' },
      { type: 'math', label: '公式', icon: 'i-carbon-function-math' },
      { type: 'signature', label: '签名', icon: 'i-carbon-pen' },
    ],
  },
  {
    name: '图表组件',
    items: [
      { type: 'chart', label: '条形图', icon: 'i-carbon-chart-bar', init: { kind: 'bar' as const } },
      { type: 'chart', label: '折线图', icon: 'i-carbon-chart-line', init: { kind: 'line' as const } },
      { type: 'chart', label: '饼图', icon: 'i-carbon-chart-pie', init: { kind: 'pie' as const } },
    ],
  },
  {
    name: '业务组件',
    items: [
      { type: 'pagebreak', label: '分页符', icon: 'i-carbon-document-horizontal', disabled: true },
      { type: 'condblock', label: '条件块', icon: 'i-carbon-branch', disabled: true },
      { type: 'datablock', label: '数据块', icon: 'i-carbon-cube', disabled: true },
    ],
  },
]

const filtered = computed(() => {
  const kw = keyword.value.trim()
  if (!kw) return categories
  return categories
    .map((c) => ({ ...c, items: c.items.filter((i) => i.label.includes(kw)) }))
    .filter((c) => c.items.length > 0)
})

function onDragStart(e: DragEvent, item: ControlItem): void {
  if (item.disabled) return
  // 签名拖入画布时走弹窗手写（见 useDragAdd 的 onDrop 特例），这里正常发起拖拽即可
  // 圆形/页码复用已有类型：圆形=rect+shape 补丁；页码=text+{{page}} 内容
  let dragType: ControlType
  if (item.type === 'zone-header' || item.type === 'zone-footer') {
    dragType = 'zone'
  } else if (item.type === 'circle') {
    dragType = 'rect'
  } else if (item.type === 'pageno') {
    dragType = 'text'
  } else {
    dragType = item.type as ControlType
  }
  const init: Partial<AnyControl> | undefined =
    item.type === 'pageno' ? { value: '{{page}}', name: '页码' } : item.type === 'zone-header'
      ? { zone: 'header' as const }
      : item.type === 'zone-footer'
        ? { zone: 'footer' as const }
        : item.init
  startControlDrag(e, dragType, init)
}

function onClick(item: ControlItem): void {
  if (item.disabled) return
  if (item.type === 'zone-header') store.addZone('header')
  else if (item.type === 'zone-footer') store.addZone('footer')
  else if (item.type === 'circle') {
    // 圆形点击插入到内容区默认位置（复用 rect 类型 + shape 补丁）
    store.addControlOfType('rect', { leftMm: 60, topMm: 60 }, { shape: 'circle' })
  } else if (item.type === 'pageno') {
    // 页码 = 文本控件 + {{page}} 页码变量（分页引擎每页注入）
    store.addControlOfType('text', { leftMm: 60, topMm: 60 }, { value: '{{page}}', name: '页码' })
  } else if (item.type === 'richtext') {
    store.addControlOfType('richtext', { leftMm: 60, topMm: 60 })
  } else if (item.type === 'chart') {
    // 图表：点击插入到内容区默认位置（条形/折线/饼图由 init.kind 决定）
    store.addControlOfType('chart', { leftMm: 60, topMm: 60 }, item.init)
  } else if (item.type === 'math') {
    // 公式：点击插入到内容区默认位置
    store.addControlOfType('math', { leftMm: 60, topMm: 60 })
  } else if (item.type === 'signature') {
    // 签名：打开弹出式手写画板（WPS 式），确认后插入主画布
    store.openSignaturePad()
  } else if (item.type === 'labelgrid') {
    // 标签网格：点击插入一张默认 3 列商品标签（拖拽同理，走 startControlDrag）
    store.addControlOfType('labelgrid', { leftMm: 60, topMm: 60 })
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="p-2">
      <NInput v-model:value="keyword" size="small" placeholder="搜索组件" clearable />
    </div>
    <NScrollbar class="flex-1 min-h-0">
      <div class="px-2 pb-2">
        <div v-for="cat in filtered" :key="cat.name" class="mb-3">
          <div class="mb-1.5 text-12px text-brand-text-3">{{ cat.name }}</div>
          <div class="grid grid-cols-3 gap-1.5">
            <div
              v-for="item in cat.items"
              :key="item.type"
              class="control-card"
              :class="{ 'is-disabled': item.disabled }"
              :draggable="!item.disabled"
              @dragstart="onDragStart($event, item)"
              @click="onClick(item)"
            >
              <div :class="item.icon" class="text-18px" />
              <div class="mt-1 text-12px">{{ item.label }}</div>
            </div>
          </div>
        </div>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.control-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 4px;
  border: 1px solid var(--brand-border);
  border-radius: 8px;
  background: var(--brand-surface);
  cursor: grab;
  color: var(--brand-text-2);
  transition:
    border-color 0.15s,
    color 0.15s,
    box-shadow 0.15s;
  user-select: none;
}
.control-card:hover {
  border-color: var(--brand-primary);
  color: var(--brand-primary);
  box-shadow: 0 1px 4px rgba(22, 119, 255, 0.15);
}
.control-card.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.control-card.is-disabled:hover {
  border-color: var(--brand-border);
  color: var(--brand-text-2);
  box-shadow: none;
}
</style>
