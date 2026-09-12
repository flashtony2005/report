<script setup lang="ts">
/**
 * SignatureProps —— 手写签名属性面板
 * 预览笔迹 + 回显画笔粗细/笔色 + 「重新签名」（重新打开手写画板）。
 * 位置/大小/锁定/删除等通用属性由 CommonProps 负责。
 */
import { computed } from 'vue'
import { NButton, NText } from 'naive-ui'
import type { SignatureControl } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as SignatureControl | null)

function reSign(): void {
  store.openSignaturePad()
}
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">签名</div>

    <div class="props-row">
      <div class="signature-preview">
        <img v-if="control.src" :src="control.src" alt="签名预览" />
        <span v-else class="text-12px text-brand-text-3">尚未签名</span>
      </div>
    </div>

    <div class="props-row">
      <span class="props-label">画笔粗细</span>
      <NText style="font-size: 12px">{{ control.penWidth ?? 1 }} px</NText>
    </div>

    <div class="props-row">
      <span class="props-label">笔色</span>
      <span
        class="color-swatch"
        :style="{ background: control.color ?? '#000000' }"
      />
    </div>

    <div class="props-row">
      <NButton size="small" type="primary" block @click="reSign">重新签名</NButton>
    </div>
  </div>
</template>

<style scoped>
.signature-preview {
  width: 100%;
  min-height: 70px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  background: #fff;
  border: 1px dashed var(--brand-border);
  border-radius: 8px;
}
.signature-preview img {
  max-width: 100%;
  max-height: 120px;
  object-fit: contain;
}
.color-swatch {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--brand-border);
}
</style>
