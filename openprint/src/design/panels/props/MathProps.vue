<script setup lang="ts">
/**
 * MathProps —— 公式控件属性面板
 *
 * 编辑：LaTeX 源码（多行文本）、显示模式（块级/行内）、字号、颜色。
 * 常用公式模板可一键插入。
 * 所有改动经 store.updateControl 写入，触发 store.canvasTick → MathViewLayer 实时重绘。
 */
import { computed } from 'vue'
import { NInput, NInputNumber, NColorPicker, NSwitch, NSelect, NButton } from 'naive-ui'
import type { MathControl } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as MathControl | null)

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

const latex = computed({
  get: () => control.value?.latex ?? '',
  set: (v: string) => patch({ latex: v }),
})

const displayMode = computed({
  get: () => control.value?.displayMode ?? true,
  set: (v: boolean) => patch({ displayMode: v }),
})

const fontSize = computed({
  get: () => control.value?.fontSize ?? 16,
  set: (v: number) => patch({ fontSize: v }),
})

const color = computed({
  get: () => control.value?.color ?? '#000000',
  set: (v: string) => patch({ color: v }),
})

/* ----------------------------- 公式模板 ----------------------------- */
interface FormulaTemplate {
  label: string
  latex: string
}

const TEMPLATES: FormulaTemplate[] = [
  { label: '二次公式', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
  { label: '勾股定理', latex: 'a^2 + b^2 = c^2' },
  { label: '求和', latex: '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}' },
  { label: '积分', latex: '\\int_{a}^{b} f(x)\\,dx' },
  { label: '极限', latex: '\\lim_{x \\to \\infty} \\frac{1}{x} = 0' },
  { label: '分数', latex: '\\frac{a}{b}' },
  { label: '矩阵', latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
  { label: '根号', latex: '\\sqrt[n]{x}' },
  { label: '向量', latex: '\\vec{a} + \\vec{b}' },
  { label: '上标下标', latex: 'x_i^2 + y_i^2' },
]

function insertTemplate(t: FormulaTemplate): void {
  patch({ latex: t.latex })
}

const templateOptions = TEMPLATES.map((t) => ({ label: t.label, value: t.latex }))

function onTemplateSelect(v: string): void {
  if (!v) return
  patch({ latex: v })
}
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">公式设置</div>

    <div class="props-row">
      <span class="props-label">显示模式</span>
      <NSelect
        size="small"
        :value="displayMode ? 'display' : 'inline'"
        :options="[
          { label: '块级（居中独立行）', value: 'display' },
          { label: '行内', value: 'inline' },
        ]"
        @update:value="displayMode = $event === 'display'"
      />
    </div>

    <div class="props-row">
      <span class="props-label" style="min-width: 56px">字号(pt)</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="fontSize"
        :min="6"
        :step="1"
        style="width: 100px"
        @update:value="fontSize = $event ?? 16"
      />
    </div>

    <div class="props-row">
      <span class="props-label" style="min-width: 56px">颜色</span>
      <div style="width: 100px">
        <NColorPicker
          size="small"
          :modes="['hex']"
          :value="color"
          @update:value="color = $event"
        />
      </div>
    </div>

    <div class="props-title">
      公式模板
      <NSelect
        size="tiny"
        :options="templateOptions"
        placeholder="选择模板插入"
        style="width: 140px; margin-left: auto"
        @update:value="onTemplateSelect"
      />
    </div>

    <div class="props-title">LaTeX 源码</div>
    <div class="props-row">
      <NInput
        size="small"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 12 }"
        :value="latex"
        placeholder="输入 LaTeX 公式，如 c = \pm\sqrt{a^2 + b^2}"
        @update:value="latex = $event"
      />
    </div>

    <div class="props-row" style="margin-top: 4px">
      <NButton size="tiny" quaternary @click="insertTemplate(TEMPLATES[0]!)">二次公式</NButton>
      <NButton size="tiny" quaternary @click="insertTemplate(TEMPLATES[3]!)">积分</NButton>
      <NButton size="tiny" quaternary @click="insertTemplate(TEMPLATES[6]!)">矩阵</NButton>
    </div>
  </div>
</template>
