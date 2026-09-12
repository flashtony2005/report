<script setup lang="ts">
/**
 * ExpressionModal —— 表达式编辑器弹窗
 * 分类展示内置函数 / 字段，点击插入片段；底部实时预览求值结果。
 * 引擎：@/core/layout-engine/expression（interpolate + FUNCTIONS）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NColorPicker, NEmpty, NInput, NModal, NScrollbar, NTabPane, NTabs, NTag } from 'naive-ui'
import { useDataSourceStore } from '@/design/stores/dataSource'
import {
  PRESET_COLORS,
  buildSampleCtx,
  evalExpressionPreview,
  filterCatalog,
  insertSnippetAtCursor,
  normalizePickedHex,
} from './shared/expression-logic'

const props = defineProps<{
  show: boolean
  /** 初始表达式（来自文本控件的 expression 字段） */
  expression?: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: [value: string]
}>()

const ds = useDataSourceStore()
const innerExpr = ref(props.expression ?? '')
const search = ref('')
const activeTab = ref<'func' | 'field'>('func')
const taRef = ref<HTMLTextAreaElement | null>(null)

/* ----------------------------- 样例上下文（实时预览） ----------------------------- */
/** 样例求值上下文来自共享 buildSampleCtx（两端同源） */
const sampleCtx = computed(() => buildSampleCtx(ds.previewData))

/* ----------------------------- 搜索过滤 ----------------------------- */
const filteredCatalog = computed(() => filterCatalog(search.value))

/* ----------------------------- 实时预览 ----------------------------- */
const preview = computed(() => evalExpressionPreview(innerExpr.value, sampleCtx.value))

/* ----------------------------- 插入逻辑 ----------------------------- */
/** 字符串计算在共享 insertSnippetAtCursor（两端同源），这里只做 DOM 光标/焦点 */
function insertSnippet(snippet: string): void {
  const ta = taRef.value
  if (!ta) {
    const r = insertSnippetAtCursor(innerExpr.value, snippet)
    innerExpr.value = r.next
    return
  }
  const start = ta.selectionStart ?? innerExpr.value.length
  const end = ta.selectionEnd ?? innerExpr.value.length
  const r = insertSnippetAtCursor(innerExpr.value, snippet, start, end)
  innerExpr.value = r.next
  nextTick(() => {
    ta.focus()
    ta.setSelectionRange(r.caret, r.caret)
  })
}

/* ----------------------------- 颜色插入 ----------------------------- */
/** NColorPicker 确认选色（:actions="['confirm']"，避免拖动过程实时插入）；hex 规范化走共享逻辑 */
function onColorPicked(hex: string): void {
  const norm = normalizePickedHex(hex)
  if (!norm) return
  insertSnippet(`'${norm}'`)
}

/* ----------------------------- 弹窗开关 ----------------------------- */
watch(
  () => props.show,
  (v) => {
    if (v) {
      innerExpr.value = props.expression ?? ''
      search.value = ''
      nextTick(() => taRef.value?.focus())
    }
  },
)

function onConfirm(): void {
  emit('confirm', innerExpr.value)
  emit('update:show', false)
}
function onCancel(): void {
  emit('update:show', false)
}

/** 供模板展示的「字面量」片段（避免在模板里直接写 {{ }} 导致编译器误判） */
const sampleExpr = "{{order.total | currency:'CNY'}}"
function bindLiteral(path: string): string {
  return `{{${path}}}`
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="表达式编辑器"
    style="width: 760px; max-width: 92vw"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="expr-modal">
      <!-- 左：函数 / 字段 -->
      <div class="expr-left">
        <NTabs v-model:value="activeTab" type="segment" size="small">
          <NTabPane name="func" tab="函数" />
          <NTabPane name="field" tab="字段" />
        </NTabs>

        <NInput
          v-if="activeTab === 'func'"
          v-model:value="search"
          size="small"
          placeholder="搜索函数 / 说明"
          clearable
          class="expr-search"
        />

        <NScrollbar class="expr-list" :class="{ 'expr-list--tabs': activeTab === 'func' }">
          <!-- 函数目录 -->
          <template v-if="activeTab === 'func'">
            <div v-for="cat in filteredCatalog" :key="cat.key" class="expr-cat">
              <div class="expr-cat-label">{{ cat.label }}</div>
              <button
                v-for="item in cat.items"
                :key="item.id"
                type="button"
                class="expr-fn"
                @click="insertSnippet(item.snippet)"
              >
                <div class="expr-fn-head">
                  <span class="expr-fn-name">{{ item.label }}</span>
                  <code class="expr-fn-snip">{{ item.snippet }}</code>
                </div>
                <div class="expr-fn-desc">{{ item.description }}</div>
                <div v-if="item.note" class="expr-fn-note">注：{{ item.note }}</div>
              </button>
            </div>
            <NEmpty v-if="filteredCatalog.length === 0" description="无匹配函数" class="expr-empty" />
          </template>

          <!-- 字段列表 -->
          <template v-else>
            <button
              v-for="f in ds.flatFields"
              :key="f.path"
              type="button"
              class="expr-fn"
              @click="insertSnippet(`{{${f.path}}}`)"
            >
              <div class="expr-fn-head">
                <span class="expr-fn-name">{{ f.label }}</span>
                <code class="expr-fn-snip">{{ f.path }}</code>
              </div>
              <div class="expr-fn-desc">点击插入字段绑定：{{ bindLiteral(f.path) }}</div>
            </button>
            <NEmpty v-if="ds.flatFields.length === 0" description="暂无数据源字段" class="expr-empty" />
          </template>
        </NScrollbar>
      </div>

      <!-- 右：编辑 + 预览 -->
      <div class="expr-right">
        <div class="expr-right-label">表达式</div>
        <!-- 颜色插入：预设色块点一下即插入；右侧自选色带「确认」按钮 -->
        <div class="expr-color-row">
          <button
            v-for="c in PRESET_COLORS"
            :key="c.hex"
            type="button"
            class="expr-color-chip"
            :style="{ background: c.hex }"
            :title="`${c.name}（点击插入 ${c.hex}）`"
            @click="insertSnippet(`'${c.hex}'`)"
          />
          <NColorPicker
            :show-alpha="false"
            :modes="['hex']"
            :actions="['confirm']"
            size="small"
            :show-preview="true"
            class="expr-color-picker"
            @confirm="onColorPicked"
          >
            <template #trigger>
              <NButton size="tiny" quaternary title="自选颜色（确认后插入）">
                <span class="i-carbon-color-palette" />
              </NButton>
            </template>
          </NColorPicker>
        </div>
        <textarea
          ref="taRef"
          v-model="innerExpr"
          class="expr-input"
          spellcheck="false"
          placeholder="例如 {{order.total | currency:'CNY'}} 或 {{sum('items[].amount')}}"
        />

        <div class="expr-right-label">实时预览</div>
        <div class="expr-preview">
          <span v-if="preview.errors.length" class="expr-err">
            <NTag type="error" size="small" :bordered="false">错误</NTag>
            {{ preview.errors.join('；') }}
          </span>
          <span v-else class="expr-preview-text">{{ preview.text || '（空）' }}</span>
        </div>
        <div class="expr-tip">
          提示：用双花括号包裹变量，如 <code>{{ sampleExpr }}</code>；函数可点击左侧插入；聚合路径需加引号，如
          <code>'items[].amount'</code>。
        </div>
      </div>
    </div>

    <template #footer>
      <div class="expr-footer">
        <NButton size="small" @click="onCancel">取消</NButton>
        <NButton size="small" type="primary" @click="onConfirm">确定</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.expr-modal {
  display: flex;
  gap: 0;
  height: 460px;
}
.expr-left {
  flex: 1 1 50%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-right: 12px;
}
.expr-search {
  margin: 8px 0 4px;
}
.expr-list {
  flex: 1 1 auto;
  min-height: 0;
}
.expr-list--tabs {
  margin-top: 4px;
}
.expr-cat {
  margin-bottom: 10px;
}
.expr-cat-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--n-text-color-3, #888);
  margin: 6px 2px;
}
.expr-fn {
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
.expr-fn:hover {
  border-color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}
.expr-fn-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.expr-fn-name {
  font-weight: 600;
  font-size: 13px;
}
.expr-fn-snip {
  font-size: 11px;
  color: var(--n-color-target, #1677ff);
  background: rgba(127, 127, 127, 0.1);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.expr-fn-desc {
  font-size: 12px;
  color: var(--n-text-color-2, #aaa);
  margin-top: 3px;
  line-height: 1.4;
}
.expr-fn-note {
  font-size: 11px;
  color: #d48806;
  margin-top: 2px;
}
.expr-empty {
  padding-top: 24px;
}
.expr-right {
  flex: 1 1 50%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-left: 12px;
  border-left: 1px solid var(--brand-border);
}
.expr-right-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--n-text-color-3, #888);
  margin: 2px 0 6px;
}
/* 颜色插入行：预设色块 + 自选色按钮 */
.expr-color-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.expr-color-chip {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  cursor: pointer;
  padding: 0;
  transition: transform 0.12s, box-shadow 0.12s;
}
.expr-color-chip:hover {
  transform: scale(1.15);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
}
.expr-color-picker {
  width: auto;
}
.expr-input {
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  resize: none;
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  color: inherit;
  background: rgba(127, 127, 127, 0.05);
}
.expr-input:focus {
  outline: none;
  border-color: var(--n-color-target, #1677ff);
}
.expr-preview {
  flex: 0 0 auto;
  min-height: 52px;
  max-height: 90px;
  overflow: auto;
  border: 1px dashed rgba(127, 127, 127, 0.3);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  background: rgba(127, 127, 127, 0.04);
  word-break: break-all;
}
.expr-preview-text {
  font-weight: 600;
}
.expr-err {
  color: #f5222d;
  font-size: 12px;
}
.expr-tip {
  font-size: 11px;
  color: var(--n-text-color-3, #888);
  margin-top: 6px;
  line-height: 1.5;
}
.expr-tip code {
  background: rgba(127, 127, 127, 0.12);
  padding: 0 4px;
  border-radius: 3px;
}
.expr-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
