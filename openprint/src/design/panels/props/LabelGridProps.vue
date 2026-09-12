<script setup lang="ts">
/**
 * LabelGridProps —— 标签网格属性面板
 *
 * 一张纸平铺 N 张标签卡的**纯布局控制台**：列数、行数、间距、卡片尺寸、网格线开关与线型。
 * 可选「数据源」数组路径（如 items）：配置后卡片数跟随数据条数，每卡注入 {row,rowIndex}，
 * 卡内控件绑定 {{row.字段}} / {{rowIndex + 1}} 逐卡不同（流水号/条码/二维码）。
 */
import { computed } from 'vue'
import { NButton, NInput, NInputNumber, NSelect, NText, NTooltip, NSwitch } from 'naive-ui'
import type { LabelGridControl } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'
import { resolveGridGeometry } from '@/core/layout-engine/label-grid'
import {
  contentWidthOf,
  fitCardPatch,
  geometryPatch as geometryPatchOf,
  maxColumnsOf,
  rowsHeightPatch,
  visibleRowsOf,
} from './shared/label-grid-props-logic'
import { CONTROL_TYPE_LABEL } from '@/design/canvas/controls'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as LabelGridControl | null)

/** 卡内绑定示例（写成常量引用，避免在模板 mustache 里嵌套 {{ }} 触发表达式解析错误） */
const BIND_ROW_EXAMPLE = '{{row.字段}}'
const BIND_ROW_INDEX_EXAMPLE = '{{rowIndex + 1}}'

const geo = computed(() =>
  control.value
    ? resolveGridGeometry(control.value)
    : { columns: 3, gapX: 2, gapY: 2, cardWidth: 0, cardHeight: 0 },
)

/** 页面内容区宽度（列数上限提示用） */
const contentWidth = computed(() => contentWidthOf(store.pageSetup))

/** 按当前卡片宽 + 间距，内容区最多能放几列 */
const maxColumns = computed(() => maxColumnsOf(contentWidth.value, geo.value))

/** 网格容器可见行数（渲染期数据更多时会自动继续跨页） */
const visibleRows = computed(() => visibleRowsOf(control.value, geo.value))

function patch(p: Partial<LabelGridControl>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

/** 改列数/卡片宽/间距后，容器宽度跟着重算，保证包围盒 = 实际铺满范围（所见即所得） */
function patchGeometry(p: Partial<LabelGridControl>): void {
  const c = control.value
  if (!c) return
  patch(geometryPatchOf(c, p, visibleRows.value))
}

/** 行数直接决定容器高度 */
function setRows(rows: number): void {
  patch(rowsHeightPatch(geo.value, rows))
}

/** 卡片尺寸按模板内容包围盒收紧 */
function fitCardToContent(): void {
  const c = control.value
  if (!c) return
  patch(fitCardPatch(c, visibleRows.value))
}

/** 列数拉满内容区 */
function fillColumns(): void {
  patchGeometry({ columns: maxColumns.value })
}

/** 首卡子组件显示名 */
function childName(ch: { type: string; name?: string }): string {
  return ch.name ?? CONTROL_TYPE_LABEL[ch.type] ?? ch.type
}

/** 删除首卡中的某个子组件 */
function removeChild(id: string): void {
  if (control.value) store.removeLabelGridChild(control.value.id, id)
}

/** 清空首卡内容 */
function clearChildren(): void {
  if (control.value) store.clearLabelGridChildren(control.value.id)
}
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">标签网格</div>

    <div class="props-row">
      <span class="props-label">显示网格线</span>
      <NSwitch
        :value="control.showLines ?? true"
        @update:value="patch({ showLines: $event })"
      />
    </div>
    <div class="props-row">
      <span class="props-label">线型</span>
      <NSelect
        :value="control.lineStyle ?? 'solid'"
        size="small"
        :disabled="!(control.showLines ?? true)"
        :options="[
          { label: '实线', value: 'solid' },
          { label: '虚线', value: 'dashed' },
        ]"
        style="width: 96px"
        @update:value="patch({ lineStyle: $event })"
      />
    </div>
    <div class="props-row" style="margin-top: 4px">
      <span class="props-label">数据源</span>
      <NInput
        size="small"
        :value="control.dataSource ?? ''"
        placeholder="数组路径，如 items"
        style="width: 148px"
        @update:value="patch({ dataSource: ($event ?? '').trim() || undefined })"
      />
    </div>
    <div class="props-row">
      <NText depth="3" style="font-size: 12px; line-height: 1.5">
        留空：纯布局平铺（每卡相同）。填数组路径（如 <code>items</code>）：卡片数跟随数据条数，
        每卡注入 <code>row</code> / <code>rowIndex</code>，卡内控件绑定
        <code>{{ BIND_ROW_EXAMPLE }}</code> 逐卡不同（流水号 / 条码 / 二维码）。
      </NText>
    </div>

    <div class="props-row" style="margin-top: 6px">
      <span class="props-label">列数</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="control.columns ?? 3"
        :min="1"
        :max="50"
        :step="1"
        style="width: 96px"
        @update:value="patchGeometry({ columns: $event ?? 1 })"
      />
      <NTooltip>
        <template #trigger>
          <NButton size="tiny" quaternary style="margin-left: 6px" @click="fillColumns">铺满</NButton>
        </template>
        按卡片宽度把列数拉到内容区上限（{{ maxColumns }} 列）
      </NTooltip>
    </div>

    <div class="props-row">
      <span class="props-label">行数</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="visibleRows"
        :min="1"
        :max="200"
        :step="1"
        style="width: 96px"
        @update:value="setRows($event ?? 1)"
      />
      <NText depth="3" style="font-size: 12px; margin-left: 6px">多行自动跨页平铺</NText>
    </div>

    <div class="grid grid-cols-2 gap-2" style="margin-top: 4px">
      <div class="props-row">
        <span class="props-label">卡宽</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="geo.cardWidth"
          :min="1"
          :step="0.5"
          :precision="1"
          @update:value="patchGeometry({ cardWidth: $event ?? 1 })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">卡高</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="geo.cardHeight"
          :min="1"
          :step="0.5"
          :precision="1"
          @update:value="patchGeometry({ cardHeight: $event ?? 1 })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">横间距</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="geo.gapX"
          :min="0"
          :step="0.5"
          :precision="1"
          @update:value="patchGeometry({ gapX: $event ?? 0 })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">纵间距</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="geo.gapY"
          :min="0"
          :step="0.5"
          :precision="1"
          @update:value="patchGeometry({ gapY: $event ?? 0 })"
        />
      </div>
    </div>

    <div class="props-row" style="margin-top: 8px; gap: 6px">
      <NButton size="tiny" secondary @click="fitCardToContent">卡片贴合内容</NButton>
    </div>

    <div class="props-row">
      <NText depth="3" style="font-size: 12px">
        每页 {{ geo.columns * visibleRows }} 张 · 卡片模板含 {{ control.children.length }} 个元素
      </NText>
    </div>

    <div
      v-if="control.children.length"
      class="props-row"
      style="flex-direction: column; align-items: stretch; gap: 4px; margin-top: 8px"
    >
      <div class="props-label">首卡元素（{{ control.children.length }}）· 拖入新组件即复制到每卡，画布上可直接选中/拖动</div>
      <div
        v-for="ch in control.children"
        :key="ch.id"
        class="child-item"
      >
        <span class="truncate text-12px" style="flex: 1">{{ childName(ch) }}</span>
        <NButton text size="tiny" class="child-del" @click.stop="removeChild(ch.id)">
          <div class="i-carbon-close text-12px text-brand-text-3" />
        </NButton>
      </div>
      <NButton size="tiny" tertiary type="error" style="align-self: flex-start" @click="clearChildren">
        清空首卡
      </NButton>
    </div>
  </div>
</template>

<style scoped>
code {
  padding: 0 3px;
  font-size: 11px;
  background: var(--brand-fill, rgba(120, 130, 145, 0.12));
  border-radius: 3px;
}
.child-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--brand-fill, rgba(120, 130, 145, 0.1));
}
.child-del:hover {
  color: var(--brand-error, #d03050) !important;
}
</style>
