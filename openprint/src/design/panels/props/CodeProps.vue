<script setup lang="ts">
/**
 * CodeProps —— 条码 / 二维码控件属性（§5.7）
 * 内容三态与文本一致：固定值（直接输入编码）/ 变量（弹窗选字段）/ 表达式（弹窗插函数）。
 */
import { computed } from 'vue'
import { NSelect, NSwitch } from 'naive-ui'
import type { BarcodeControl, QrcodeControl } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'
import ContentValueEditor from './ContentValueEditor.vue'
import type { ContentMode } from './ContentValueEditor.vue'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as BarcodeControl | QrcodeControl | null)
const isBarcode = computed(() => control.value?.type === 'barcode')

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

const contentMode = computed<ContentMode>(() => {
  const c = control.value
  if (c?.contentType) return c.contentType
  return c?.binding ? 'variable' : 'fixed'
})

/** 模式切换：写 contentType + 清空其它两个字段（默认值由 ContentValueEditor 注入） */
function onModeChange(m: ContentMode): void {
  if (!control.value) return
  if (m === 'fixed') patch({ contentType: 'fixed', binding: undefined, expression: undefined })
  else if (m === 'variable') patch({ contentType: 'variable', expression: undefined })
  else patch({ contentType: 'expression', binding: undefined })
}

const barcodeFormats = [
  { label: 'CODE128', value: 'CODE128' },
  { label: 'EAN-13', value: 'EAN13' },
  { label: 'EAN-8', value: 'EAN8' },
  { label: 'CODE39', value: 'CODE39' },
  { label: 'ITF-14', value: 'ITF14' },
  { label: 'UPC-A', value: 'UPCA' },
]
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">{{ isBarcode ? '条码设置' : '二维码设置' }}</div>

    <ContentValueEditor
      :mode="contentMode"
      :value="control.value ?? ''"
      :binding="control.binding ?? ''"
      :expression="(control as BarcodeControl | QrcodeControl).expression ?? ''"
      placeholder="编码内容"
      single-line
      binding-default="order.orderNo"
      :expression-default="'{{order.orderNo}}'"
      @update:mode="onModeChange"
      @update:value="patch({ value: $event || undefined })"
      @update:binding="patch({ binding: $event })"
      @update:expression="patch({ expression: $event || undefined })"
    />

    <template v-if="isBarcode">
      <div class="props-row">
        <span class="props-label">格式</span>
        <NSelect
          size="small"
          :value="(control as BarcodeControl).format ?? 'CODE128'"
          :options="barcodeFormats"
          @update:value="patch({ format: $event })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">显示文字</span>
        <NSwitch
          size="small"
          :value="(control as BarcodeControl).showText ?? true"
          @update:value="patch({ showText: $event })"
        />
      </div>
    </template>

    <div v-else class="props-row">
      <span class="props-label">纠错级</span>
      <NSelect
        size="small"
        :value="(control as QrcodeControl).errorLevel ?? 'M'"
        :options="[
          { label: 'L（7%）', value: 'L' },
          { label: 'M（15%）', value: 'M' },
          { label: 'Q（25%）', value: 'Q' },
          { label: 'H（30%）', value: 'H' },
        ]"
        @update:value="patch({ errorLevel: $event })"
      />
    </div>
  </div>
</template>
