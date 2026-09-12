<script setup lang="ts">
/**
 * ImageProps —— 图片控件属性（§5.8）
 * inline 上传转 Base64 / url 外链 / binding 绑定字段（asset 后续接资源目录）
 */
import { computed, ref } from 'vue'
import { NInput, NInputNumber, NSelect, NButton, NUpload, type UploadCustomRequestOptions } from 'naive-ui'
import type { ImageControl, ImageValueMode } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'
import VariableModal from './VariableModal.vue'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as ImageControl | null)

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

const mode = computed({
  get: (): ImageValueMode => control.value?.value?.mode ?? 'inline',
  set: (m: ImageValueMode) => {
    patch({ value: { mode: m, content: '' } })
  },
})

function patchContent(content: string): void {
  if (!control.value) return
  patch({ value: { mode: mode.value, content } })
}

/** 上传 → Base64 inline（§5.8 默认来源，自包含离线可用） */
function onUpload({ file }: UploadCustomRequestOptions): void {
  const raw = file.file
  if (!raw) return
  const reader = new FileReader()
  reader.onload = () => {
    patchContent(reader.result as string)
  }
  reader.readAsDataURL(raw)
}

/** 绑定字段 → 变量选择弹窗（与文本组件一致：全部单据字段 + 类型 + 示例值） */
const varModalShow = ref(false)
function onVarConfirm(path: string): void {
  patchContent(path)
}
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">图片来源</div>

    <div class="props-row">
      <span class="props-label">方式</span>
      <NSelect
        v-model:value="mode"
        size="small"
        :options="[
          { label: '上传图片', value: 'inline' },
          { label: '图片 URL', value: 'url' },
          { label: '绑定字段', value: 'binding' },
        ]"
      />
    </div>

    <div v-if="mode === 'inline'" class="props-row">
      <NUpload :show-file-list="false" accept="image/*" :custom-request="onUpload">
        <NButton size="small" dashed block>选择图片（转 Base64 内联）</NButton>
      </NUpload>
    </div>
    <div v-else-if="mode === 'url'" class="props-row">
      <NInput
        size="small"
        :value="control.value?.content ?? ''"
        placeholder="https://…"
        @update:value="patchContent"
      />
    </div>
    <div v-else class="props-row img-var-row">
      <NInput
        size="small"
        :value="control.value?.content ?? ''"
        placeholder="字段路径，如 order.photoUrl"
        @update:value="patchContent"
      />
      <NButton size="small" @click="varModalShow = true">
        <template #icon><span class="i-carbon-list-dropdown" /></template>
        选择字段
      </NButton>
    </div>
  </div>

  <VariableModal
    v-model:show="varModalShow"
    :binding="control?.value?.mode === 'binding' ? (control.value.content ?? '') : ''"
    @confirm="onVarConfirm"
  />

  <div v-if="control" class="props-section">
    <div class="props-title">显示</div>
    <div class="props-row">
      <span class="props-label">填充</span>
      <NSelect
        size="small"
        :value="control.fit ?? 'contain'"
        :options="[
          { label: '包含 contain', value: 'contain' },
          { label: '覆盖 cover', value: 'cover' },
          { label: '拉伸 fill', value: 'fill' },
          { label: '原始 none', value: 'none' },
        ]"
        @update:value="patch({ fit: $event })"
      />
    </div>
    <div class="props-row">
      <span class="props-label">圆角</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="control.cornerRadius ?? 0"
        :min="0"
        @update:value="patch({ cornerRadius: $event ?? 0 })"
      />
    </div>
  </div>
</template>

<style scoped>
.img-var-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.img-var-row :deep(.n-input) {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
