<script setup lang="ts">
/**
 * VariableModal —— 变量（字段绑定）选择弹窗
 * 按表分组展示数据源全部字段：字段名 / 路径 / 类型标签 / 示例值，
 * 点击选中后在底部预览绑定路径，确定后回写 binding。
 * 示例值取自 ds.previewData（合成/真实数据），暂无则回退 FieldDef.sample。
 */
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NModal, NScrollbar } from 'naive-ui'
import type { FieldDef } from '@/types/datasource'
import { useDataSourceStore } from '@/design/stores/dataSource'
import { sampleOfField, typeMeta } from './shared/sample-value'

const props = defineProps<{
  show: boolean
  /** 当前绑定路径（用于弹窗内高亮） */
  binding?: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: [value: string]
}>()

const ds = useDataSourceStore()
const search = ref('')
const selectedPath = ref('')

/* ----------------------------- 按表分组（ds.fieldTree） ----------------------------- */
const grouped = computed(() =>
  ds.fieldTree.map((g) => ({
    table: g.table,
    fields: g.fields,
  })),
)

const totalCount = computed(() => ds.flatFields.length)

/** 搜索过滤：字段名 / 路径 / 类型 / 示例值 */
const filteredGroups = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return grouped.value
  return grouped.value
    .map((g) => ({
      ...g,
      fields: g.fields.filter(
        (f) =>
          f.label.toLowerCase().includes(kw) ||
          f.path.toLowerCase().includes(kw) ||
          typeMeta(f).label.includes(kw) ||
          String(sampleOf(f)).toLowerCase().includes(kw),
      ),
    }))
    .filter((g) => g.fields.length > 0)
})

/* ----------------------------- 示例值提取 ----------------------------- */
/** 示例值提取逻辑已抽到 shared/sample-value.ts（两端同源，spec 把关） */
function sampleOf(f: FieldDef): string {
  return sampleOfField(f, ds.previewData)
}

/* ----------------------------- 选中与确认 ----------------------------- */
function selectField(f: FieldDef): void {
  selectedPath.value = f.path
}

function onConfirm(): void {
  if (selectedPath.value) emit('confirm', selectedPath.value)
  emit('update:show', false)
}
function onCancel(): void {
  emit('update:show', false)
}

/** 展示绑定字面量（避免模板直接写 {{ }}） */
function bindLiteral(path: string): string {
  return `{{${path}}}`
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      search.value = ''
      selectedPath.value = props.binding ?? ''
      // 弹窗独立可用：数据源未初始化（未打开过「数据源」面板）时主动加载字段
      void ds.init()
    }
  },
)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="选择字段"
    style="width: 640px; max-width: 92vw"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="var-modal">
      <div class="var-top">
        <NInput
          v-model:value="search"
          size="small"
          placeholder="搜索字段名 / 路径 / 类型 / 示例值"
          clearable
          class="var-search"
        />
        <span class="var-count">共 {{ totalCount }} 个字段</span>
      </div>

      <NScrollbar class="var-list">
        <div v-for="g in filteredGroups" :key="g.table.id" class="var-group">
          <div class="var-group-label">{{ g.table.name }}</div>
          <button
            v-for="f in g.fields"
            :key="f.path"
            type="button"
            class="var-fn"
            :class="{ 'var-fn--active': selectedPath === f.path }"
            @click="selectField(f)"
          >
            <div class="var-fn-head">
              <span class="var-fn-name">{{ f.label }}</span>
              <span class="var-fn-type" :style="{ color: typeMeta(f).color }">{{ typeMeta(f).label }}</span>
              <code class="var-fn-path">{{ f.path }}</code>
            </div>
            <div class="var-fn-sample">示例：{{ sampleOf(f) }}</div>
          </button>
        </div>
        <NEmpty
          v-if="filteredGroups.length === 0"
          :description="ds.loading ? '字段加载中…' : search ? '无匹配字段' : '暂无数据源字段'"
          class="var-empty"
        />
      </NScrollbar>

      <div class="var-foot">
        <span class="var-foot-label">已选</span>
        <code class="var-foot-path">{{ selectedPath ? bindLiteral(selectedPath) : '（未选择）' }}</code>
      </div>
    </div>

    <template #footer>
      <div class="var-footer">
        <NButton size="small" @click="onCancel">取消</NButton>
        <NButton size="small" type="primary" :disabled="!selectedPath" @click="onConfirm">确定</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.var-modal {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 460px;
}
.var-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.var-search {
  flex: 1 1 auto;
}
.var-count {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--n-text-color-3, #888);
}
.var-list {
  flex: 1 1 auto;
  min-height: 0;
}
.var-group {
  margin-bottom: 10px;
}
.var-group-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--n-text-color-3, #888);
  margin: 6px 2px;
}
.var-fn {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--brand-surface);
  border: 1px solid var(--brand-border);
  border-radius: 6px;
  padding: 7px 9px;
  margin-bottom: 6px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.var-fn:hover {
  border-color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 6%, transparent);
}
.var-fn--active {
  border-color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--brand-primary);
}
.var-fn-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.var-fn-name {
  font-weight: 600;
  font-size: 13px;
}
.var-fn-type {
  font-size: 11px;
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 4px;
  line-height: 1.5;
  opacity: 0.85;
}
.var-fn-path {
  font-size: 11px;
  color: var(--n-text-color-3, #888);
  background: rgba(127, 127, 127, 0.1);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.var-fn-sample {
  font-size: 12px;
  color: var(--n-text-color-2, #aaa);
  margin-top: 3px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.var-empty {
  padding-top: 24px;
}
.var-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--brand-border);
  padding-top: 8px;
}
.var-foot-label {
  font-size: 12px;
  color: var(--n-text-color-3, #888);
}
.var-foot-path {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.var-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
