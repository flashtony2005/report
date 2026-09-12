<script setup lang="ts">
/**
 * ChartProps —— 图表控件属性面板
 *
 * 编辑：图表类型（条形/折线/饼图）、标题、类目、序列（名称/颜色/数值）、外观选项。
 * 数据为纯前端手工录入（与表格的「数据源绑定」解耦，v1 先不做绑定）。
 * 所有改动经 store.updateControl 写入，触发 store.canvasTick → ChartViewLayer 实时重绘。
 */
import { computed } from 'vue'
import { NInput, NInputNumber, NColorPicker, NSwitch, NSelect, NButton } from 'naive-ui'
import type { ChartControl } from '@/types/control'
import type { ChartSeries } from '@/core/chartkit/types'
import { useDesignerStore } from '@/design/stores/designer'
import {
  addSeriesAt,
  alignSeriesData,
  categoriesPatch,
  categoriesText as categoriesTextOf,
  removeSeriesAt,
  seriesColorOf,
  seriesDataText as seriesDataTextOf,
  setSeriesColorAt,
  setSeriesNameAt,
  showLegendDefault,
} from './shared/chart-props-logic'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as ChartControl | null)

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

function patchOption(key: string, value: unknown): void {
  if (!control.value) return
  patch({ options: { ...control.value.options, [key]: value } })
}

const kind = computed({
  get: () => control.value?.kind ?? 'bar',
  set: (v: 'bar' | 'line' | 'pie') => patch({ kind: v }),
})

const title = computed({
  get: () => control.value?.options?.title ?? '',
  set: (v: string) => patchOption('title', v || undefined),
})

const isLine = computed(() => kind.value === 'line')
const isPie = computed(() => kind.value === 'pie')

/* ------------------------------- 类目编辑 ------------------------------- */
const categoriesText = computed({
  get: () => categoriesTextOf(control.value),
  set: (v: string) => patch(categoriesPatch(control.value as ChartControl, v)),
})

/* ------------------------------- 序列编辑 ------------------------------- */
const series = computed<ChartSeries[]>(() => control.value?.series ?? [])

function seriesName(i: number): string {
  return series.value[i]?.name ?? ''
}
function setSeriesName(i: number, v: string): void {
  patch({ series: setSeriesNameAt(series.value, i, v) })
}
function seriesColor(i: number): string {
  return seriesColorOf(series.value, i)
}
function setSeriesColor(i: number, v: string): void {
  patch({ series: setSeriesColorAt(series.value, i, v) })
}
function seriesDataText(i: number): string {
  return seriesDataTextOf(series.value, i)
}
function setSeriesData(i: number, raw: string): void {
  const cats = control.value?.categories ?? []
  patch({ series: alignSeriesData(series.value, i, raw, cats) })
}
function addSeries(): void {
  const cats = control.value?.categories ?? []
  patch({ series: addSeriesAt(series.value, cats) })
}
function removeSeries(i: number): void {
  patch({ series: removeSeriesAt(series.value, i) })
}

/* ------------------------------- 外观开关 ------------------------------- */
const showLegend = computed({
  get: () => showLegendDefault(control.value?.options, series.value.length),
  set: (v: boolean) => patchOption('showLegend', v),
})
const showAxis = computed({
  get: () => control.value?.options?.showAxis ?? true,
  set: (v: boolean) => patchOption('showAxis', v),
})
const showGrid = computed({
  get: () => control.value?.options?.showGrid ?? true,
  set: (v: boolean) => patchOption('showGrid', v),
})
const valueLabel = computed({
  get: () => control.value?.options?.valueLabel ?? false,
  set: (v: boolean) => patchOption('valueLabel', v),
})
const labelAlign = computed({
  get: () => control.value?.options?.labelAlign ?? 'center',
  set: (v: 'left' | 'center' | 'right') => patchOption('labelAlign', v),
})
const smooth = computed({
  get: () => control.value?.options?.smooth ?? false,
  set: (v: boolean) => patchOption('smooth', v),
})
const area = computed({
  get: () => control.value?.options?.area ?? false,
  set: (v: boolean) => patchOption('area', v),
})
const donut = computed({
  get: () => control.value?.options?.donut ?? false,
  set: (v: boolean) => patchOption('donut', v),
})
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">图表类型</div>
    <div class="props-row">
      <span class="props-label">类型</span>
      <NSelect
        size="small"
        :value="kind"
        :options="[
          { label: '条形图', value: 'bar' },
          { label: '折线图', value: 'line' },
          { label: '饼图', value: 'pie' },
        ]"
        @update:value="kind = $event"
      />
    </div>

    <div class="props-row">
      <span class="props-label">标题</span>
      <NInput size="small" :value="title" placeholder="图表标题" @update:value="title = $event" />
    </div>

    <div class="props-title">类目</div>
    <div class="props-row">
      <span class="props-label">类目</span>
      <NInput
        size="small"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 6 }"
        :value="categoriesText"
        placeholder="每行一个类目（x 轴标签 / 扇区名）"
        @update:value="categoriesText = $event"
      />
    </div>

    <div class="props-title">
      数据序列
      <NButton size="tiny" secondary type="primary" class="ml-auto" @click="addSeries">+ 序列</NButton>
    </div>
    <div v-for="(s, i) in series" :key="i" class="chart-series">
      <div class="props-row">
        <span class="props-label">名称</span>
        <NInput size="small" :value="seriesName(i)" @update:value="(v: string) => setSeriesName(i, v)" />
        <NColorPicker
          size="small"
          :modes="['hex']"
          :value="seriesColor(i)"
          @update:value="(v: string) => setSeriesColor(i, v)"
        />
        <NButton
          v-if="series.length > 1"
          size="tiny"
          quaternary
          type="error"
          @click="removeSeries(i)"
        >
          删
        </NButton>
      </div>
      <div class="props-row">
        <span class="props-label">数值</span>
        <NInput
          size="small"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          :value="seriesDataText(i)"
          :placeholder="isPie ? '每行一个扇区数值' : '每行一个数值（与类目对应）'"
          @update:value="(v: string) => setSeriesData(i, v)"
        />
      </div>
    </div>

    <div class="props-title">外观</div>
    <div v-if="!isPie" class="props-row">
      <span class="props-label">坐标轴</span>
      <NSwitch size="small" :value="showAxis" @update:value="showAxis = $event" />
    </div>
    <div v-if="!isPie" class="props-row">
      <span class="props-label">网格线</span>
      <NSwitch size="small" :value="showGrid" @update:value="showGrid = $event" />
    </div>
    <div class="props-row">
      <span class="props-label">图例</span>
      <NSwitch size="small" :value="showLegend" @update:value="showLegend = $event" />
    </div>
    <div class="props-row">
      <span class="props-label">数据标签</span>
      <NSwitch size="small" :value="valueLabel" @update:value="valueLabel = $event" />
    </div>
    <div class="props-row">
      <span class="props-label">图例对齐</span>
      <NSelect
        size="small"
        :value="labelAlign"
        :options="[
          { label: '左对齐', value: 'left' },
          { label: '居中', value: 'center' },
          { label: '右对齐', value: 'right' },
        ]"
        @update:value="labelAlign = $event"
      />
    </div>
    <div v-if="isLine" class="props-row">
      <span class="props-label">平滑曲线</span>
      <NSwitch size="small" :value="smooth" @update:value="smooth = $event" />
    </div>
    <div v-if="isLine" class="props-row">
      <span class="props-label">面积填充</span>
      <NSwitch size="small" :value="area" @update:value="area = $event" />
    </div>
    <div v-if="isPie" class="props-row">
      <span class="props-label">环形</span>
      <NSwitch size="small" :value="donut" @update:value="donut = $event" />
    </div>
  </div>
</template>

<style scoped>
.chart-series {
  border: 1px dashed var(--brand-border);
  border-radius: 8px;
  padding: 6px 8px;
  margin-bottom: 8px;
  background: var(--brand-surface);
}
.ml-auto {
  margin-left: auto;
}
</style>
