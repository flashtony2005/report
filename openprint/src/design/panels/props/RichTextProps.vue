<script setup lang="ts">
/**
 * RichTextProps —— 富文本控件属性（§5.8）
 * tiptap 编辑器通过 defineAsyncComponent 懒加载，避免拖入/浏览时加载重型依赖。
 */
import { computed, defineAsyncComponent } from 'vue'
import { NInputNumber } from 'naive-ui'
import type { RichTextControl } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'

const RichTextEditor = defineAsyncComponent(() => import('./RichTextEditor.vue'))

const store = useDesignerStore()
const control = computed(() => store.selectedControl as RichTextControl | null)

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">内容</div>
    <div class="mb-1 text-11px text-brand-text-3">在此输入富文本，画布实时预览</div>
    <RichTextEditor
      :model-value="control.value ?? ''"
      @update:model-value="patch({ value: $event })"
    />
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">尺寸</div>
    <div class="grid grid-cols-2 gap-2">
      <div class="props-row">
        <span class="props-label">宽</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.width"
          :min="1"
          @update:value="patch({ width: $event ?? control.width })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">高</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.height"
          :min="1"
          @update:value="patch({ height: $event ?? control.height })"
        />
      </div>
    </div>
  </div>
</template>
