<script setup lang="ts">
/**
 * ContentValueEditor —— 通用「内容三态」编辑器（固定值 / 变量 / 表达式）
 *
 * 文本 / 表格单元格 / 条码 / 二维码等所有「有值组件」复用，保证交互完全一致：
 * - 固定值  → 直接输入文本
 * - 变量    → 「选择字段」按钮弹 VariableModal（全部单据字段：类型 + 示例值），点击即回写
 * - 表达式  → 「插入函数」按钮弹 ExpressionModal（分类函数目录 + 实时预览），点击即回写
 *
 * 组件只发事件不写模型：父级把 update:mode / update:value / update:binding / update:expression
 * 映射到各自控件 schema（文本 value/binding/expression、单元格 text/field/expression 等）。
 * 模式切换时的新模式默认值由 props（fixedDefault / bindingDefault / expressionDefault）注入。
 */
import { ref } from 'vue'
import { NButton, NInput, NRadioButton, NRadioGroup } from 'naive-ui'
import VariableModal from './VariableModal.vue'
import ExpressionModal from './ExpressionModal.vue'

export type ContentMode = 'fixed' | 'variable' | 'expression'

/** 表达式输入框占位（避免模板里出现字面 {{ 干扰 Vue 编译器，故用脚本常量） */
const exprPlaceholder = "{{order.total | currency:'CNY'}}"

const props = withDefaults(
  defineProps<{
    mode: ContentMode
    /** 固定值文本 */
    value?: string
    /** 变量字段路径 */
    binding?: string
    /** 表达式源码 */
    expression?: string
    /** 固定值输入占位 */
    placeholder?: string
    /** 固定值单行输入（条码/二维码/单元格）；默认多行 textarea（文本） */
    singleLine?: boolean
    /** compact：radio 与输入并排一行（表格单元格浮动工具栏用） */
    compact?: boolean
    /** 切到「固定值」且值为空时自动填入 */
    fixedDefault?: string
    /** 切到「变量」且路径为空时自动填入 */
    bindingDefault?: string
    /** 切到「表达式」且为空时自动填入 */
    expressionDefault?: string
  }>(),
  {
    value: '',
    binding: '',
    expression: '',
    placeholder: '内容',
    singleLine: false,
    compact: false,
    fixedDefault: '',
    bindingDefault: '',
    expressionDefault: '',
  },
)

const emit = defineEmits<{
  (e: 'update:mode', v: ContentMode): void
  (e: 'update:value', v: string): void
  (e: 'update:binding', v: string): void
  (e: 'update:expression', v: string): void
}>()

const varModalShow = ref(false)
const exprModalShow = ref(false)

/** 用户点「类型」radio：通知父级切模式，并给新模式填充默认值（仅当该字段为空） */
function onModeChange(m: ContentMode): void {
  emit('update:mode', m)
  if (m === 'fixed' && !props.value && props.fixedDefault) emit('update:value', props.fixedDefault)
  else if (m === 'variable' && !props.binding && props.bindingDefault) emit('update:binding', props.bindingDefault)
  else if (m === 'expression' && !props.expression && props.expressionDefault) emit('update:expression', props.expressionDefault)
}

function onVarConfirm(path: string): void {
  emit('update:mode', 'variable')
  emit('update:binding', path)
}

function onExprConfirm(v: string): void {
  emit('update:mode', 'expression')
  emit('update:expression', v)
}
</script>

<template>
  <div class="content-value-editor" :class="{ compact }">
    <!-- 独立类型行（非 compact） -->
    <div v-if="!compact" class="props-row">
      <span class="props-label">类型</span>
      <NRadioGroup size="small" :value="mode" @update:value="onModeChange">
        <NRadioButton value="fixed">固定值</NRadioButton>
        <NRadioButton value="variable">变量</NRadioButton>
        <NRadioButton value="expression">表达式</NRadioButton>
      </NRadioGroup>
    </div>

    <!-- 值行：compact 时 radio 并排，否则仅输入 + 按钮 -->
    <div class="props-row content-value-row" :class="{ 'mt-1': !compact }">
      <NRadioGroup v-if="compact" size="small" :value="mode" @update:value="onModeChange">
        <NRadioButton value="fixed">固定值</NRadioButton>
        <NRadioButton value="variable">变量</NRadioButton>
        <NRadioButton value="expression">表达式</NRadioButton>
      </NRadioGroup>

      <NInput
        v-if="mode === 'fixed'"
        :type="singleLine ? 'text' : 'textarea'"
        size="small"
        :autosize="singleLine ? undefined : { minRows: 3, maxRows: 4 }"
        :value="value"
        :placeholder="placeholder"
        @update:value="emit('update:value', $event)"
      />
      <NInput
        v-else-if="mode === 'variable'"
        size="small"
        :value="binding"
        placeholder="字段路径，如 order.orderNo"
        @update:value="emit('update:binding', $event)"
      />
      <NInput
        v-else
        size="small"
        :value="expression"
        :placeholder="exprPlaceholder"
        @update:value="emit('update:expression', $event)"
      />

      <NButton v-if="mode === 'variable'" size="small" @click="varModalShow = true">
        <template #icon><span class="i-carbon-list-dropdown" /></template>
        选择字段
      </NButton>
      <NButton v-else-if="mode === 'expression'" size="small" @click="exprModalShow = true">
        <template #icon><span class="i-carbon-function" /></template>
        插入函数
      </NButton>
    </div>

    <VariableModal v-model:show="varModalShow" :binding="binding ?? ''" @confirm="onVarConfirm" />
    <ExpressionModal v-model:show="exprModalShow" :expression="expression ?? ''" @confirm="onExprConfirm" />
  </div>
</template>

<style scoped>
.content-value-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.content-value-row :deep(.n-input) {
  flex: 1 1 auto;
  min-width: 0;
}
.compact .content-value-row {
  margin-bottom: 0;
}
</style>
