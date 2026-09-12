<script setup lang="ts">
/**
 * RightPanel —— 右栏属性面板
 * 选中控件 → 通用属性 + 类型属性；无选中 → 页面设置（纸张预设 / 方向 / 边距）。
 * 样式与事件本就分散在各控件 Props 与协议层，故不再设独立 tab。
 */
import { computed, ref, type Component } from 'vue'
import {
  NSelect,
  NInputNumber,
  NEmpty,
  NText,
  NColorPicker,
  NSwitch,
  NInput,
  NButton,
} from 'naive-ui'
import { useDesignerStore, DEFAULT_WATERMARK } from '@/design/stores/designer'
import type { WatermarkConfig } from '@/types/template'
import CommonProps from '@/design/panels/props/CommonProps.vue'
import TextProps from '@/design/panels/props/TextProps.vue'
import TableProps from '@/design/panels/props/TableProps.vue'
import ImageProps from '@/design/panels/props/ImageProps.vue'
import ZoneProps from '@/design/panels/props/ZoneProps.vue'
import CodeProps from '@/design/panels/props/CodeProps.vue'
import ShapeProps from '@/design/panels/props/ShapeProps.vue'
import RichTextProps from '@/design/panels/props/RichTextProps.vue'
import ChartProps from '@/design/panels/props/ChartProps.vue'
import MathProps from '@/design/panels/props/MathProps.vue'
import SignatureProps from '@/design/panels/props/SignatureProps.vue'
import LabelGridProps from '@/design/panels/props/LabelGridProps.vue'

const store = useDesignerStore()
const control = computed(() => store.selectedControl)

const propsComponent = computed<Component | null>(() => {
  switch (control.value?.type) {
    case 'text':
      return TextProps
    case 'table':
      return TableProps
    case 'image':
      return ImageProps
    case 'zone':
      return ZoneProps
    case 'barcode':
    case 'qrcode':
      return CodeProps
    case 'rect':
    case 'line':
      return ShapeProps
    case 'richtext':
      return RichTextProps
    case 'chart':
      return ChartProps
    case 'math':
      return MathProps
    case 'signature':
      return SignatureProps
    case 'labelgrid':
      return LabelGridProps
    default:
      return null
  }
})

/** 当前选中预设（自定义时回退到 custom） */
const selectedPreset = ref<string>('a4')

const PAPER_PRESETS = [
  { label: 'A4（210 × 297 mm）', value: 'a4', width: 210, height: 297 },
  { label: 'A5（148 × 210 mm）', value: 'a5', width: 148, height: 210 },
  { label: 'A6（105 × 148 mm）', value: 'a6', width: 105, height: 148 },
  { label: '热敏 58mm（58 × 297 mm）', value: 'thermal58', width: 58, height: 297 },
  { label: '热敏 80mm（80 × 297 mm）', value: 'thermal80', width: 80, height: 297 },
  { label: '小票（80 × 150 mm）', value: 'receipt', width: 80, height: 150 },
  { label: '自定义', value: 'custom', width: 210, height: 297 },
]

function setPaper(preset: string): void {
  selectedPreset.value = preset
  if (preset === 'custom') return
  const p = PAPER_PRESETS.find((x) => x.value === preset)
  if (!p) return
  store.pageSetup.width = p.width
  store.pageSetup.height = p.height
  store.pageSetup.orientation = p.width <= p.height ? 'portrait' : 'landscape'
  store.designer?.setPage(store.pageSetup)
  store.reflowBody()
}

function setMargin(side: 'top' | 'bottom' | 'left' | 'right', v: number | null): void {
  store.pageSetup.margin[side] = v ?? 0
  store.designer?.setPage(store.pageSetup)
  store.reflowBody()
}

function setOrientation(v: 'portrait' | 'landscape'): void {
  const { width, height } = store.pageSetup
  // 方向切换时交换宽高，保证语义一致
  if ((v === 'landscape') !== width > height) {
    store.pageSetup.width = height
    store.pageSetup.height = width
  }
  store.pageSetup.orientation = v
  store.designer?.setPage(store.pageSetup)
  store.reflowBody()
}

function setCustomSize(side: 'width' | 'height', v: number | null): void {
  store.pageSetup[side] = v ?? 0
  store.pageSetup.orientation = (store.pageSetup.width ?? 0) <= (store.pageSetup.height ?? 0) ? 'portrait' : 'landscape'
  store.designer?.setPage(store.pageSetup)
  store.reflowBody()
}

/* ------------------------------ 页面外观 ------------------------------ */

function setBackground(c: string): void {
  store.pageSetup.backgroundColor = c
  store.applyPageDecoration()
}

function setWatermark(patch: Partial<WatermarkConfig>): void {
  const base = store.pageSetup.watermark ?? { ...DEFAULT_WATERMARK }
  store.pageSetup.watermark = { ...base, ...patch }
  store.applyPageDecoration()
}

const watermark = computed<WatermarkConfig>(() => store.pageSetup.watermark ?? { ...DEFAULT_WATERMARK })
</script>

<template>
  <div class="flex h-full flex-col bg-brand-surface">
    <div class="flex items-center justify-between border-b border-brand-border px-3 py-2">
      <span class="text-13px font-medium">属性</span>
    </div>

    <div class="flex-1 overflow-y-auto">
      <!-- 画布网格设置（运行时视图状态，辅助设计，不持久化；常驻顶部，始终可见） -->
      <div class="props-section">
        <div class="props-title">画布网格</div>
        <div class="props-row">
          <span class="props-label">显示网格</span>
          <NSwitch
            size="small"
            :value="store.gridConfig.visible"
            @update:value="store.setGrid({ visible: $event })"
          />
        </div>
        <div class="props-row">
          <span class="props-label" style="min-width: 56px">间距(mm)</span>
          <NInputNumber
            size="small"
            button-placement="both"
            :value="store.gridConfig.sizeMm"
            :min="1"
            :step="1"
            style="width: 100px"
            @update:value="store.setGrid({ sizeMm: $event ?? 5 })"
          />
        </div>
        <div class="props-row">
          <span class="props-label" style="min-width: 56px">颜色</span>
          <div style="width: 100px">
            <NColorPicker
              size="small"
              :modes="['hex']"
              :show-alpha="true"
              :value="store.gridConfig.color"
              :disabled="!store.gridConfig.visible"
              @update:value="store.setGrid({ color: $event })"
            />
          </div>
        </div>
      </div>

      <!-- 页面外观（背景色 + 水印；随模板持久化；常驻顶部，始终可见） -->
      <div class="props-section">
        <div class="props-title">页面外观</div>
        <div class="props-row">
          <span class="props-label">页面背景</span>
          <div style="width: 100px">
            <NColorPicker
              size="small"
              :modes="['hex']"
              :show-alpha="true"
              :value="store.pageSetup.backgroundColor ?? '#ffffff'"
              @update:value="setBackground($event)"
            />
          </div>
        </div>

        <div class="props-row" style="margin-top: 4px">
          <span class="props-label">水印</span>
          <NSwitch
            size="small"
            :value="watermark.enabled"
            @update:value="setWatermark({ enabled: $event })"
          />
        </div>

        <template v-if="watermark.enabled">
          <div class="props-row" style="margin-top: 4px">
            <span class="props-label" style="min-width: 56px">文本</span>
            <NInput
              size="small"
              :value="watermark.text"
              style="width: 160px"
              @update:value="setWatermark({ text: $event })"
            />
          </div>
          <div class="props-row">
            <span class="props-label" style="min-width: 56px">颜色</span>
            <div style="width: 100px">
              <NColorPicker
                size="small"
                :modes="['hex']"
                :show-alpha="true"
                :value="watermark.color"
                @update:value="setWatermark({ color: $event })"
              />
            </div>
          </div>
          <div class="props-row">
            <span class="props-label" style="min-width: 56px">字号(mm)</span>
            <NInputNumber
              size="small"
              button-placement="both"
              :value="watermark.fontSize"
              :min="1"
              :step="1"
              style="width: 100px"
              @update:value="setWatermark({ fontSize: $event ?? 16 })"
            />
          </div>
          <div class="props-row">
            <span class="props-label" style="min-width: 56px">角度(°)</span>
            <NInputNumber
              size="small"
              button-placement="both"
              :value="watermark.rotation"
              :step="1"
              style="width: 100px"
              @update:value="setWatermark({ rotation: $event ?? 45 })"
            />
          </div>
          <div class="props-row">
            <span class="props-label">全页平铺</span>
            <NSwitch
              size="small"
              :value="watermark.tile"
              @update:value="setWatermark({ tile: $event })"
            />
          </div>
        </template>
      </div>

      <!-- 选中控件：通用 + 类型属性 -->
      <template v-if="control">
        <component :is="propsComponent" v-if="propsComponent" />
        <CommonProps />
      </template>

      <!-- 无选中：页面设置 -->
      <div v-else class="props-section">
        <div class="props-title">页面设置</div>

        <!-- 手动分页：加页 / 减页 + 物理页数 -->
        <div class="props-row">
          <span class="props-label" style="min-width: 56px">分页</span>
          <div class="flex items-center gap-2">
            <NButton size="tiny" quaternary circle :disabled="store.pageCount <= 1" @click="store.removePage()">
              −
            </NButton>
            <span class="text-12px">共 {{ store.pageCount }} 页</span>
            <NButton size="tiny" quaternary circle @click="store.addPage()">＋</NButton>
          </div>
        </div>

        <!-- 页码导航：点击跳转到对应页（属性面板调整的是该页参数，全局共享纸张设置） -->
        <div class="flex flex-wrap gap-1 pt-1 pb-2">
          <button
            v-for="i in store.pageCount"
            :key="i"
            type="button"
            class="page-chip"
            :class="{ 'page-chip-active': store.activePage === i - 1 }"
            @click="store.goToPage(i - 1)"
          >
            第 {{ i }} 页
          </button>
        </div>

        <div class="props-row">
          <span class="props-label" style="min-width: 56px">纸张</span>
          <NSelect size="small" :options="PAPER_PRESETS" :value="selectedPreset" @update:value="setPaper" />
        </div>

        <!-- 自定义：显示可编辑宽高 -->
        <div v-if="selectedPreset === 'custom'" class="grid grid-cols-2 gap-2">
          <div class="props-row">
            <span class="props-label">宽</span>
            <NInputNumber size="small" button-placement="both" :value="store.pageSetup.width" :min="1" @update:value="setCustomSize('width', $event)" />
          </div>
          <div class="props-row">
            <span class="props-label">高</span>
            <NInputNumber size="small" button-placement="both" :value="store.pageSetup.height" :min="1" @update:value="setCustomSize('height', $event)" />
          </div>
        </div>

        <div class="props-row">
          <span class="props-label" style="min-width: 56px">方向</span>
          <NSelect
            size="small"
            :value="store.pageSetup.orientation"
            :options="[
              { label: '纵向', value: 'portrait' },
              { label: '横向', value: 'landscape' },
            ]"
            @update:value="setOrientation"
          />
        </div>

        <!-- 边距调整：实时反映到画布参考线（画布上的蓝色虚线即内容区） -->
        <div class="props-row" style="margin-top: 4px">
          <span class="props-label" style="min-width: 56px">页边距</span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="props-row">
            <span class="props-label">上</span>
            <NInputNumber size="small" button-placement="both" :value="store.pageSetup.margin.top" :min="0" @update:value="setMargin('top', $event)" />
          </div>
          <div class="props-row">
            <span class="props-label">下</span>
            <NInputNumber size="small" button-placement="both" :value="store.pageSetup.margin.bottom" :min="0" @update:value="setMargin('bottom', $event)" />
          </div>
          <div class="props-row">
            <span class="props-label">左</span>
            <NInputNumber size="small" button-placement="both" :value="store.pageSetup.margin.left" :min="0" @update:value="setMargin('left', $event)" />
          </div>
          <div class="props-row">
            <span class="props-label">右</span>
            <NInputNumber size="small" button-placement="both" :value="store.pageSetup.margin.right" :min="0" @update:value="setMargin('right', $event)" />
          </div>
        </div>

        <!-- 边距锁定：默认开启限制正文在边距内移动（边距=设计安全区）；关闭后自由移动（边距仅参考线，内外都会打印） -->
        <div class="props-row" style="margin-top: 4px">
          <span class="props-label" style="min-width: 56px">边距锁定</span>
          <NSwitch
            size="small"
            :value="store.marginLocked"
            @update:value="store.setMarginLocked($event)"
          />
          <NText depth="3" style="font-size: 12px; margin-left: 6px">
            {{ store.marginLocked ? '限制在边距内' : '可自由移动' }}
          </NText>
        </div>

        <NEmpty description="在画布上选中控件以编辑属性" class="mt-8" size="small" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-chip {
  padding: 1px 8px;
  font-size: 12px;
  line-height: 20px;
  color: var(--brand-text-secondary);
  background: transparent;
  border: 1px solid var(--brand-border);
  border-radius: 10px;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background-color 0.15s;
}
.page-chip:hover {
  color: var(--brand-primary);
  border-color: var(--brand-primary);
}
.page-chip-active {
  color: #fff;
  background: var(--brand-primary);
  border-color: var(--brand-primary);
}
</style>
