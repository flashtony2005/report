<script setup lang="ts">
/**
 * ZoneProps —— 页眉/页脚区域控件属性（§5.14.3）：高度 / 每页重复
 * 页码变量 {{page}} / {{pageTotal}} 仅在 zone 内文本生效（渲染期注入）。
 */
import { computed } from 'vue'
import { NInputNumber, NSwitch, NAlert } from 'naive-ui'
import type { ZoneControl } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as ZoneControl | null)

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">{{ control.zone === 'header' ? '页眉区域' : '页脚区域' }}</div>

    <div class="props-row">
      <span class="props-label" style="min-width: 72px">高度 (mm)</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="control.zoneHeight"
        :min="5"
        :max="80"
        :precision="1"
        @update:value="patch({ zoneHeight: $event ?? 20, height: $event ?? 20 })"
      />
    </div>

    <div class="props-row">
      <span class="props-label" style="min-width: 72px">每页重复</span>
      <NSwitch
        size="small"
        :value="control.repeat ?? true"
        @update:value="patch({ repeat: $event })"
      />
    </div>

    <NAlert type="info" :bordered="false" class="text-12px">
      区域内文本支持页码变量：<code v-text="'{{page}}'" /> / <code v-text="'{{pageTotal}}'" />，渲染时自动注入。
      直接把控件拖入色带即可成为子组件。
    </NAlert>
  </div>
</template>
