<script setup lang="ts">
/**
 * BindingEditor —— 绑定路径编辑器（点选 path，非手敲）
 * Phase 5：接 dataSource store 的扁平字段列表，替换 Phase 3 的硬编码 MOCK_FIELDS。
 *
 * 传了 `options` 就用外部给的选项 —— 表格「数据设置 → 数据源」传的是**数组表**
 * （见 `tableSourceOptions`）：表格数据源必须是数组路径，喂字段列表会"全是列、没有表"。
 */
import { computed } from 'vue'
import { NSelect } from 'naive-ui'
import { useDataSourceStore } from '@/design/stores/dataSource'

const props = defineProps<{
  value?: string
  placeholder?: string
  /** 外部选项；不传则回退到数据源的扁平字段列表 */
  options?: { label: string; value: string }[]
  /** 选项为空时的提示 */
  emptyHint?: string
}>()

const emit = defineEmits<{
  'update:value': [value: string | undefined]
}>()

const dsStore = useDataSourceStore()

const innerOptions = computed(() => {
  if (props.options) return props.options
  return dsStore.flatFields.map((f) => ({
    label: `${f.label}（${f.path}）`,
    value: f.path,
  }))
})

/** 菜单空态文案：有选项时是"没搜到"，没选项时才是"该数据源没有明细表" */
const emptyText = computed(() =>
  innerOptions.value.length ? '没有匹配项' : (props.emptyHint ?? '暂无可选项'),
)

const innerValue = computed({
  get: () => props.value ?? null,
  set: (v: string | null) => emit('update:value', v ?? undefined),
})
</script>

<template>
  <NSelect
    v-model:value="innerValue"
    :options="innerOptions"
    size="small"
    filterable
    tag
    clearable
    :placeholder="placeholder ?? '选择或输入绑定字段'"
    :loading="dsStore.loading"
  >
    <template #empty>
      <div class="px-2 py-1 text-12px op-60">{{ emptyText }}</div>
    </template>
  </NSelect>
</template>
