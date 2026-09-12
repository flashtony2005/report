<script setup lang="ts">
/**
 * TextProps —— 文本控件属性（§5.2/§5.3）：内容（静态/绑定/表达式）+ 排版样式
 */
import { computed } from 'vue'
import {
  NInput,
  NInputNumber,
  NSelect,
  NColorPicker,
  NRadioGroup,
  NRadioButton,
  NButton,
} from 'naive-ui'
import type { SelectOption, SelectGroupOption } from 'naive-ui'
import type { CellFormat, CellFormatKind, TextControl, TextStyle } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'
import { useDataSourceStore } from '@/design/stores/dataSource'
import { FONT_CATALOG } from '@/core/fonts/catalog'
import { useSystemFonts } from '@/design/composables/useSystemFonts'
import ContentValueEditor from './ContentValueEditor.vue'
import type { ContentMode } from './ContentValueEditor.vue'
import {
  formatKindOptions,
  datePatternOptions,
  currencyCodeOptions,
  makeFormat,
  needsPattern,
  needsDigits,
  needsCode,
  supportsThousands,
  suggestKindByFieldType,
} from '@/design/format-options'
import {
  contentModePatch,
  formatHint as formatHintOf,
  formatKindFirstPatch,
  formatPatch,
  isPresetDatePattern as sharedIsPresetDatePattern,
  resolveContentMode,
} from './shared/panel-logic'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as TextControl | null)
const ds = useDataSourceStore()

/** 字体下拉选项（内置预设 + 连接客户端后的电脑系统字体分组） */
const sysFonts = useSystemFonts()

const fontOptions = computed<(SelectOption | SelectGroupOption)[]>(() => {
  const builtin: SelectOption[] = [
    { label: '系统默认', value: '' },
    ...FONT_CATALOG.map((f) => ({ label: f.label, value: f.family })),
  ]
  // 客户端未连接 → 不展示电脑系统字体分组（避免下拉里出现一堆客户端不可达的字体）
  if (!sysFonts.ready.value) return builtin
  const sysOpts: SelectOption[] = sysFonts.grouped.value.map((g) => ({ label: g.family, value: g.family }))
  return [
    { type: 'group', label: '预设字体', key: 'builtin', children: builtin.filter((o) => o.value !== '') },
    { type: 'group', label: `电脑系统字体（${sysFonts.count.value}）`, key: 'system', children: sysOpts },
    { label: '系统默认', value: '' },
  ]
})

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

function patchStyle(p: Partial<TextStyle>): void {
  if (!control.value) return
  patch({ style: { ...control.value.style, ...p } }) // 语义见 shared/panel-logic.mergeStyle
}

/** B / I / U 三键：加粗 / 斜体 / 下划线（切换式） */
const isBold = computed(() => (control.value?.style?.fontWeight ?? 'normal') === 'bold')
const isItalic = computed(() => (control.value?.style?.fontStyle ?? 'normal') === 'italic')
const isUnderline = computed(() => (control.value?.style?.textDecoration ?? 'none') === 'underline')
function toggleBold(): void {
  patchStyle({ fontWeight: isBold.value ? 'normal' : 'bold' })
}
function toggleItalic(): void {
  patchStyle({ fontStyle: isItalic.value ? 'normal' : 'italic' })
}
function toggleUnderline(): void {
  patchStyle({ textDecoration: isUnderline.value ? 'none' : 'underline' })
}

/** 内容类型：固定值 / 变量（字段绑定） / 表达式（显式 contentType 判别，兼容老模板回退） */
const contentMode = computed<ContentMode>(() => resolveContentMode(control.value))

/** 模式切换：写 contentType + 清空其它两个字段（默认值由 ContentValueEditor 注入） */
function onModeChange(m: ContentMode): void {
  patch(contentModePatch(m))
}

/* -------------------------------- 数据格式 -------------------------------- */
/* 仅绑定模式生效：expression 模式请用 {{field | date:'...'}} 过滤器，不在此重复设置。 */

const textFormat = computed<CellFormat>(() => control.value?.format ?? { kind: 'none' })

/** 绑定字段在数据源里的类型（用于提示选哪种格式） */
const boundFieldType = computed(() => {
  const path = control.value?.binding
  if (!path) return undefined
  const f = ds.flatFields.find((x) => x.path === path)
  return f?.type
})
const formatHint = computed(() => formatHintOf(boundFieldType.value))

function patchFormat(fmt: CellFormat): void {
  patch({ format: formatPatch(fmt) })
}
function setFormatKind(kind: CellFormatKind): void {
  patch({ format: formatKindFirstPatch(control.value?.format, kind) })
}
const isPresetDatePattern = sharedIsPresetDatePattern
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">内容设置</div>

    <ContentValueEditor
      :mode="contentMode"
      :value="control.value ?? ''"
      :binding="control.binding ?? ''"
      :expression="control.expression ?? ''"
      placeholder="文本内容"
      fixed-default="文本"
      binding-default="order.orderNo"
      :expression-default="'{{order.total}}'"
      @update:mode="onModeChange"
      @update:value="patch({ value: $event })"
      @update:binding="patch({ binding: $event })"
      @update:expression="patch({ expression: $event || undefined })"
    />

    <div v-if="contentMode === 'variable'" class="props-section">
      <div class="props-title">数据格式</div>

      <div v-if="formatHint" class="props-tip">{{ formatHint }}</div>

      <div class="props-row">
        <span class="props-label">类型</span>
        <NSelect
          size="small"
          :value="textFormat.kind"
          :options="formatKindOptions"
          @update:value="setFormatKind"
        />
      </div>

      <div v-if="needsPattern(textFormat.kind)" class="props-row">
        <span class="props-label">日期模板</span>
        <NSelect
          size="small"
          :value="isPresetDatePattern(textFormat.pattern) ? textFormat.pattern : '__custom__'"
          :options="datePatternOptions"
          @update:value="
            (v: string) => {
              if (v !== '__custom__') patchFormat({ ...textFormat, kind: 'date', pattern: v })
            }
          "
        />
      </div>
      <div v-if="needsPattern(textFormat.kind) && !isPresetDatePattern(textFormat.pattern)" class="props-row">
        <span class="props-label">自定义</span>
        <NInput
          size="small"
          :value="textFormat.pattern ?? 'YYYY-MM-DD'"
          placeholder="YYYY-MM-DD HH:mm"
          @update:value="(v: string) => patchFormat({ ...textFormat, kind: 'date', pattern: v || 'YYYY-MM-DD' })"
        />
      </div>

      <div v-if="needsDigits(textFormat.kind)" class="props-row">
        <span class="props-label">小数位</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="textFormat.digits ?? 2"
          :min="0"
          :max="6"
          :precision="0"
          @update:value="(v: number | null) => patchFormat({ ...textFormat, digits: v ?? 0 })"
        />
      </div>

      <div v-if="needsCode(textFormat.kind)" class="props-row">
        <span class="props-label">币种</span>
        <NSelect
          size="small"
          :value="textFormat.code ?? 'CNY'"
          :options="currencyCodeOptions"
          @update:value="(v: string) => patchFormat({ ...textFormat, kind: 'currency', code: v })"
        />
      </div>

      <div v-if="supportsThousands(textFormat.kind)" class="props-row">
        <span class="props-label">千分位</span>
        <NRadioGroup
          size="small"
          :value="textFormat.thousands === false ? 'off' : 'on'"
          @update:value="(v: string) => patchFormat({ ...textFormat, thousands: v === 'on' })"
        >
          <NRadioButton value="on">开</NRadioButton>
          <NRadioButton value="off">关</NRadioButton>
        </NRadioGroup>
      </div>

      <NButton size="tiny" quaternary @click="patch({ format: undefined })">清除格式</NButton>
    </div>
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">排版设置</div>

    <div class="grid grid-cols-2 gap-2">
      <div class="props-row">
        <span class="props-label">字号</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.style?.fontSize ?? 12"
          :min="6"
          :max="72"
          :precision="1"
          @update:value="patchStyle({ fontSize: $event ?? 12 })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">行高</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.style?.lineHeight ?? 1.16"
          :min="0.8"
          :max="4"
          :step="0.05"
          :precision="2"
          @update:value="patchStyle({ lineHeight: $event ?? 1.16 })"
        />
      </div>
    </div>

    <div class="props-row">
      <span class="props-label">样式</span>
      <div class="flex items-center gap-1">
        <NButton size="small" :type="isBold ? 'primary' : 'default'" title="加粗" @click="toggleBold"><b>B</b></NButton>
        <NButton size="small" :type="isItalic ? 'primary' : 'default'" title="斜体" @click="toggleItalic"><i>I</i></NButton>
        <NButton size="small" :type="isUnderline ? 'primary' : 'default'" title="下划线" @click="toggleUnderline"><u>U</u></NButton>
      </div>
    </div>

    <div class="props-row">
      <span class="props-label">对齐</span>
      <NRadioGroup
        size="small"
        :value="control.style?.textAlign ?? 'left'"
        @update:value="patchStyle({ textAlign: $event })"
      >
        <NRadioButton value="left">左</NRadioButton>
        <NRadioButton value="center">中</NRadioButton>
        <NRadioButton value="right">右</NRadioButton>
      </NRadioGroup>
    </div>

    <div class="props-row">
      <span class="props-label">字体</span>
      <NSelect
        size="small"
        :value="control.style?.fontFamily ?? ''"
        :options="fontOptions"
        placeholder="系统默认"
        filterable
        @update:value="patchStyle({ fontFamily: $event || undefined })"
      />
    </div>

    <div class="props-row">
      <span class="props-label">颜色</span>
      <NColorPicker
        size="small"
        :modes="['hex']"
        :value="control.style?.fill ?? '#000000'"
        :swatches="['#000000', '#333333', '#666666', '#999999', '#1677FF', '#F5222D']"
        @update:value="patchStyle({ fill: $event })"
      />
    </div>

    <div class="props-row">
      <span class="props-label">字距</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="control.style?.letterSpacing ?? 0"
        :step="0.5"
        :precision="1"
        @update:value="patchStyle({ letterSpacing: $event ?? 0 })"
      />
    </div>
  </div>
</template>
