<script setup lang="ts">
/**
 * TableProps —— 表格控件属性（§5.4）
 * 核心 3 开关置顶（repeatHeader / repeatFooter / pageRows），进阶折叠。
 *
 * #100 网格管理：表头/正文/静态尾行数 stepper、列增删与左右移动、表格默认单元格样式、列单元格样式。
 * 所有网格变更走 table-cells.ts 的纯函数（setGridRows / addTableColumn / removeTableColumn / moveTableColumn），
 * 保证 cells 矩阵与 headerRows/designRows/staticRows 元数据始终一致。
 */
import { computed, ref } from 'vue'
import {
  NAutoComplete,
  NButton,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NColorPicker,
  NCollapse,
  NCollapseItem,
} from 'naive-ui'
import type { TableColumn, TableControl, TableOptions, TableCellStyle, CellFormat, CellFormatKind, TableStylePreset } from '@/types/control'
import { useDesignerStore } from '@/design/stores/designer'
import { useDataSourceStore } from '@/design/stores/dataSource'
import {
  addTableColumn,
  moveTableColumn,
  removeTableColumn,
  setGridRows,
} from '@/core/layout-engine/table-cells'
import {
  formatKindOptions,
  datePatternOptions,
  currencyCodeOptions,
  needsPattern,
  needsDigits,
  needsCode,
  supportsThousands,
} from '@/design/format-options'
import {
  cleanOptions,
  columnFieldOptions as columnFieldOptionsOf,
  defaultSummary,
  fieldTypeMapOf,
  formatFromKind,
  groupFieldOptions as groupFieldOptionsOf,
  isPresetDatePattern,
  mergeClean,
  normalizeColumnFormat,
  stylePickPatch,
  summaryFieldOptions as summaryFieldOptionsOf,
  tableSourceOptions,
  withSummaryExpr,
  withSummaryFallback,
  type SummaryRowCfg,
} from './shared/table-props-logic'
import { tableStyleLabel, TABLE_STYLE_PRESETS } from '@/design/canvas/table-style-presets'
import TableStylePickerModal from '@/design/modals/TableStylePickerModal.vue'
import BindingEditor from './BindingEditor.vue'
import VariableModal from './VariableModal.vue'

const store = useDesignerStore()
const control = computed(() => store.selectedControl as TableControl | null)
const isData = computed(() => Boolean(control.value?.dataSource?.trim()))

function patch(p: Record<string, unknown>): void {
  if (control.value) store.updateControl(control.value.id, p)
}

function patchOptions(p: Partial<TableOptions>): void {
  if (!control.value) return
  patch({ options: cleanOptions(control.value.options, p) })
}

function patchColumn(index: number, p: Partial<TableColumn>): void {
  if (!control.value) return
  const columns = control.value.columns.map((c, i) => (i === index ? { ...c, ...p } : c))
  patch({ columns })
}

/**
 * 列字段下拉选项：与左侧数据源联动。
 * 数据表的列字段应是「数组（明细）字段」——路径含 `items[].`，运行期按行迭代取值。
 * 自由文本仍允许（用户可手填任意路径），故用 NAutoComplete 而非 NSelect。
 */
const columnFieldOptions = computed(() => columnFieldOptionsOf(ds.flatFields))

/** 列是否参与尾行合计（本页合计 / 总计） */
function setColumnAggregate(index: number, on: boolean): void {
  patchColumn(index, { aggregate: on ? true : false })
}

/** 应用一个返回"新控件"的网格纯函数（保持类型/ID 不变） */
function applyGrid(fn: (c: TableControl) => TableControl): void {
  const c = control.value
  if (!c) return
  store.updateControl(c.id, fn(c))
}

/* ----------------------------- 网格结构（行） ----------------------------- */

function setHeaderRows(v: number | null): void {
  applyGrid((c) => setGridRows(c, { headerRows: v ?? 0 }))
}
function setDesignRows(v: number | null): void {
  applyGrid((c) => setGridRows(c, { designRows: v ?? 0 }))
}
function setStaticRows(v: number | null): void {
  applyGrid((c) => setGridRows(c, { staticRows: v ?? 0 }))
}

/* ------------------------------- 列管理 ------------------------------- */

function addColumn(): void {
  applyGrid((c) => addTableColumn(c))
}
function removeColumn(index: number): void {
  applyGrid((c) => removeTableColumn(c, index))
}
function moveColumn(index: number, dir: -1 | 1): void {
  applyGrid((c) => moveTableColumn(c, index, index + dir))
}

/** 列「字段」的变量选择弹窗（数据列字段应为明细数组字段，弹窗展示全部字段 + 类型 + 示例值） */
const colVarShow = ref(false)
const colVarIndex = ref(-1)
function openColVar(i: number): void {
  colVarIndex.value = i
  colVarShow.value = true
}
function onColVarConfirm(path: string): void {
  if (colVarIndex.value >= 0) patchColumn(colVarIndex.value, { field: path })
}

/* ------------------------------ 样式编辑 ------------------------------ */

const alignOptions = [
  { label: '左', value: 'left' },
  { label: '中', value: 'center' },
  { label: '右', value: 'right' },
]

/** 当前表格样式预设（用于「样式库」弹窗选中高亮与按钮文案） */
const currentStyle = computed<TableStylePreset>(
  () => (control.value?.options?.tableStyle ?? 'none') as TableStylePreset,
)
const pickerShow = ref(false)
function pickStyle(key: TableStylePreset): void {
  patchOptions(stylePickPatch(key))
}
const valignOptions = [
  { label: '顶部', value: 'top' },
  { label: '居中', value: 'middle' },
  { label: '底部', value: 'bottom' },
]

function patchDefaultStyle(p: Record<string, unknown>): void {
  if (!control.value) return
  const cur = (control.value.options?.defaultCellStyle ?? {}) as Record<string, unknown>
  patchOptions({ defaultCellStyle: mergeClean(cur, p) as unknown as TableCellStyle })
}

function patchColumnStyle(index: number, p: Record<string, unknown>): void {
  if (!control.value) return
  const cur = (control.value.columns[index]?.style ?? {}) as Record<string, unknown>
  patchColumn(index, { style: mergeClean(cur, p) as unknown as TableCellStyle })
}

/* ------------------------------ 列数据格式 ------------------------------ */

/** 写回列格式：kind='none' 视为清除（删字段，保持模型干净） */
function patchColumnFormat(index: number, fmt: CellFormat | undefined): void {
  patchColumn(index, { format: normalizeColumnFormat(fmt) })
}

/** 数据源字段类型查表（按完整 path），用于给出"字段类型"提示 */
const fieldTypeMap = computed(() => fieldTypeMapOf(ds.flatFields))
function fieldTypeOf(path?: string): string | undefined {
  return path ? fieldTypeMap.value.get(path) : undefined
}

/* --------------------------- 数据源 store（合计/分组字段枚举） --------------------------- */
const ds = useDataSourceStore()

/* ------------------------------ 合计行（总计） ------------------------------ */

const summary = computed(() => control.value?.options?.summaryRow ?? null)
const hasSummary = computed(() => summary.value !== null)

/**
 * 归一化合计行配置为纯函数要求的完整形态。
 * `options.summaryRow` 的 inline 声明里 fields/label 是可选的（只有 type 必填），
 * 而 shared 层纯函数入参 `SummaryRowCfg` 要求它们存在 —— 在边界处补齐，
 * 避免把「可选」这一 UI 侧的自由度泄漏进纯逻辑层。
 */
function currentSummary(): SummaryRowCfg {
  const s = summary.value
  if (!s) return defaultSummary()
  return {
    type: s.type,
    fields: s.fields ?? [],
    label: s.label ?? '合计',
    expression: s.expression,
    expressions: s.expressions,
    subtotalLabel: s.subtotalLabel,
    subtotalStyle: s.subtotalStyle,
  }
}

/** 开关合计行：开启时给一个兜底配置，关闭时清空 summaryRow 与遗留的 summary[]（单真相源） */
function toggleSummary(on: boolean): void {
  if (!control.value) return
  if (on) {
    patchOptions({ summaryRow: defaultSummary() })
    patch({ summary: undefined })
  } else {
    patchOptions({ summaryRow: undefined })
    patch({ summary: undefined })
  }
}

function patchSummary(p: Partial<NonNullable<TableControl['options']>['summaryRow']>): void {
  if (!control.value) return
  const cur = currentSummary()
  patchOptions({ summaryRow: { ...cur, ...p } })
  patch({ summary: undefined })
}

/** 自定义合计：编辑某字段的专属表达式（expressions[field]） */
function patchSummaryExpr(field: string, expr: string | null): void {
  if (!control.value) return
  const cur = currentSummary()
  patchOptions({ summaryRow: withSummaryExpr(cur, field, expr) })
  patch({ summary: undefined })
}

/** 自定义合计：兜底单表达式（无聚合列时生效） */
function patchSummaryFallbackExpr(expr: string | null): void {
  if (!control.value) return
  const cur = currentSummary()
  patchOptions({ summaryRow: withSummaryFallback(cur, expr) })
  patch({ summary: undefined })
}

/** 分组小计标签模板（${key} 占位分组值） */
function patchSubtotalLabel(v: string | null): void {
  patchSummary({ subtotalLabel: v || undefined })
}

/** 聚合列选项：取"已绑定字段的列"，其值须与列 field 一致引擎才能按列落位 */
const summaryFieldOptions = computed(() => summaryFieldOptionsOf(control.value?.columns ?? []))

/* ------------------------------ 分组统计 ------------------------------ */

/** 分组字段选项：取明细（数组）表的字段，value 用裸字段名（与运行期列 field 约定一致） */
const groupFieldOptions = computed(() =>
  groupFieldOptionsOf(ds.flatFields, ds.activeSource?.tables),
)

/** 表格数据源只能选数组表（明细表）；喂字段列表会"全是列、没有表" */
const dataSourceOptions = computed(() => tableSourceOptions(ds.activeSource?.tables))

function patchGroupBy(v: string | null): void {
  patch({ groupBy: v || undefined })
}
</script>

<template>
  <div v-if="control" class="props-section">
    <div class="props-title">数据设置</div>
    <div class="props-row">
      <span class="props-label">数据源</span>
      <BindingEditor
        :value="control.dataSource"
        placeholder="留空 = 空白表格"
        :options="dataSourceOptions"
        empty-hint="当前数据源没有明细表（数组），可手动输入路径"
        @update:value="patch({ dataSource: $event })"
      />
    </div>
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">核心开关</div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">每页打印标题行</span>
      <NSwitch
        size="small"
        :value="control.options?.repeatHeader ?? true"
        @update:value="patchOptions({ repeatHeader: $event })"
      />
    </div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">每页打印合计行</span>
      <NSwitch
        size="small"
        :value="control.options?.repeatFooter ?? true"
        @update:value="patchOptions({ repeatFooter: $event })"
      />
    </div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">每页行数</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="control.options?.pageRows === 'auto' || control.options?.pageRows === undefined ? null : control.options.pageRows"
        :min="1"
        placeholder="auto"
        clearable
        @update:value="patchOptions({ pageRows: $event ?? 'auto' })"
      />
    </div>
  </div>

  <div v-if="control && isData" class="props-section">
    <div class="props-title">合计行（总计）</div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">显示合计行</span>
      <NSwitch size="small" :value="hasSummary" @update:value="toggleSummary" />
    </div>
    <template v-if="hasSummary">
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">统计方式</span>
        <NSelect
          size="small"
          :value="summary?.type ?? 'sum'"
          :options="[
            { label: '求和', value: 'sum' },
            { label: '计数', value: 'count' },
            { label: '自定义表达式', value: 'custom' },
          ]"
          @update:value="patchSummary({ type: $event })"
        />
      </div>
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">聚合列</span>
        <NSelect
          size="small"
          multiple
          :value="summary?.fields ?? []"
          :options="summaryFieldOptions"
          placeholder="选择参与统计的列"
          @update:value="patchSummary({ fields: $event })"
        />
      </div>
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">合计标签</span>
        <NInput
          size="small"
          :value="summary?.label ?? '合计'"
          placeholder="合计"
          @update:value="patchSummary({ label: $event || '合计' })"
        />
      </div>
      <template v-if="summary?.type === 'custom'">
        <div class="props-tip">
          自定义表达式作用域：<code>sum.字段</code> / <code>avg.字段</code>（按列预聚合）、<code>rows</code>（当前分组行）、<code>allRows</code>（整表行）。
          先在上方「聚合列」选要显示结果的列，再为每列填表达式。例如 <code>sum.amount - sum.discount</code>。
        </div>
        <div v-for="f in summary?.fields ?? []" :key="f" class="props-row">
          <span class="props-label" style="min-width: 88px">{{ f }} 表达式</span>
          <NInput
            size="small"
            :value="summary?.expressions?.[f] ?? ''"
            placeholder="如 sum.amount"
            @update:value="patchSummaryExpr(f, $event)"
          />
        </div>
        <div class="props-row">
          <span class="props-label" style="min-width: 88px">兜底表达式</span>
          <NInput
            size="small"
            :value="summary?.expression ?? ''"
            placeholder="无聚合列时生效"
            @update:value="patchSummaryFallbackExpr($event)"
          />
        </div>
      </template>
      <div class="props-tip">合计行固定在表尾；开启「每页打印合计行」后可每页重复。聚合列显示数值，其余列留空。</div>
    </template>
  </div>

  <div v-if="control && isData" class="props-section">
    <div class="props-title">分组统计</div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">分组字段</span>
      <NSelect
        size="small"
        clearable
        filterable
        :value="control.groupBy ?? null"
        :options="groupFieldOptions"
        placeholder="不分组"
        @update:value="patchGroupBy"
      />
    </div>
    <div class="props-tip">
      按该字段分组打印；同时开启「合计行」后，<b>每个分组自动生成小计行</b>，末尾再附总计。
    </div>
    <template v-if="control.groupBy && hasSummary">
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">小计标签</span>
        <NInput
          size="small"
          :value="summary?.subtotalLabel ?? ''"
          placeholder="${key} 小计"
          @update:value="patchSubtotalLabel($event)"
        />
      </div>
      <div class="props-tip"><code>${key}</code> 会被替换为分组值。例如 <code>类别合计</code> 或 <code>${key} 小计</code>。</div>
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">小计加粗</span>
        <NSwitch
          size="small"
          :value="summary?.subtotalStyle?.bold ?? true"
          @update:value="patchSummary({ subtotalStyle: { ...(summary?.subtotalStyle ?? {}), bold: $event } })"
        />
      </div>
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">小计字色</span>
        <NColorPicker
          size="small"
          :modes="['hex']"
          :value="summary?.subtotalStyle?.color"
          :show-alpha="false"
          @update:value="patchSummary({ subtotalStyle: { ...(summary?.subtotalStyle ?? {}), color: $event } })"
        />
      </div>
    </template>
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">表格样式</div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">样式预设</span>
      <span
        class="props-link"
        style="cursor: pointer"
        @click="pickerShow = true"
      >{{ tableStyleLabel(currentStyle) }}</span>
      <NButton size="tiny" quaternary circle title="打开表格样式库" @click="pickerShow = true">
        <span class="i-carbon-table" />
      </NButton>
    </div>
    <div class="props-tip">
      点击打开「表格样式库」，可预览每种样式并直接点选套用（类似 Excel 表格样式快速切换）。默认「无」仅显示边框与表头加粗，无任何背景色（含标题行）。
    </div>
    <TableStylePickerModal v-model:show="pickerShow" :current="currentStyle" @select="pickStyle" />
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">网格结构</div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">表头行数</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="control.headerRows ?? (control.columns.some((c) => c.title) ? 1 : 0)"
        :min="0"
        :max="10"
        @update:value="setHeaderRows($event)"
      />
    </div>
    <template v-if="!isData">
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">正文行数</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.designRows ?? 0"
          :min="0"
          :max="100"
          @update:value="setDesignRows($event)"
        />
      </div>
      <div class="props-tip">布局网格：双击单元格可填写静态内容（表头 / 正文）。</div>
    </template>
    <template v-else>
      <div class="props-row">
        <span class="props-label" style="min-width: 88px">固定尾行</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.staticRows ?? 0"
          :min="0"
          :max="20"
          @update:value="setStaticRows($event)"
        />
      </div>
      <div class="props-tip">数据表：固定尾行用于备注 / 签字栏等；合计行由「高级选项」配置。</div>
    </template>
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">
      行高
      <span class="props-title-tip">画布与打印一致（所见即所得）</span>
    </div>
    <div class="props-row">
      <span class="props-label" style="min-width: 88px">行高模式</span>
      <NSelect
        size="small"
        :value="control.options?.rowHeightMode ?? 'auto'"
        :options="[
          { label: '自动（内容撑开）', value: 'auto' },
          { label: '固定行高', value: 'fixed' },
        ]"
        @update:value="patchOptions({ rowHeightMode: $event })"
      />
    </div>
    <div v-if="control.options?.rowHeightMode === 'fixed'" class="props-row">
      <span class="props-label" style="min-width: 88px">行高 (mm)</span>
      <NInputNumber
        size="small"
        button-placement="both"
        :value="control.options?.rowHeight ?? 8"
        :min="6"
        :precision="1"
        @update:value="patchOptions({ rowHeight: $event ?? 8 })"
      />
    </div>
    <div class="props-tip">
      自动：每行高度按实际内容自适应（单行 ≈ 6.7mm）；固定：所有行统一为指定高度，改后画布包围盒自动跟随。
    </div>
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">列配置（{{ control.columns.length }} 列）</div>
    <div v-for="(col, i) in control.columns" :key="i" class="mb-2 rounded border border-brand-border p-2">
      <div class="mb-1.5 flex items-center justify-between">
        <span class="text-12px text-gray-500">列 {{ i + 1 }}</span>
        <div class="flex items-center gap-1">
          <NButton text size="tiny" :disabled="i === 0" title="左移" @click="moveColumn(i, -1)">←</NButton>
          <NButton text size="tiny" :disabled="i === control.columns.length - 1" title="右移" @click="moveColumn(i, 1)">→</NButton>
          <NButton text size="tiny" type="error" :disabled="control.columns.length <= 1" @click="removeColumn(i)">
            删除
          </NButton>
        </div>
      </div>
      <div class="props-row">
        <span class="props-label">标题</span>
        <NInput size="small" :value="col.title" @update:value="patchColumn(i, { title: $event })" />
      </div>
      <div class="props-row">
        <span class="props-label">字段</span>
        <NAutoComplete
          size="small"
          class="flex-1"
          :value="col.field ?? ''"
          :options="columnFieldOptions"
          placeholder="选择或输入字段，如 items[].qty"
          @update:value="patchColumn(i, { field: $event || undefined })"
        />
        <NButton size="tiny" title="从数据源选择字段" @click="openColVar(i)">
          <template #icon><span class="i-carbon-list-dropdown" /></template>
        </NButton>
      </div>
      <div class="props-row">
        <span class="props-label">参与合计</span>
        <NSwitch
          size="small"
          :value="col.aggregate === true || col.aggregate === 'sum' || col.aggregate === 'avg' || col.aggregate === 'count'"
          @update:value="(v: boolean) => setColumnAggregate(i, v)"
        />
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div class="props-row">
          <span class="props-label">宽</span>
          <NInputNumber
            size="small"
            button-placement="both"
            :value="col.width"
            :min="5"
            @update:value="patchColumn(i, { width: $event ?? 30 })"
          />
        </div>
        <div class="props-row">
          <span class="props-label">对齐</span>
          <NSelect
            size="small"
            :value="col.align ?? 'left'"
            :options="alignOptions"
            @update:value="patchColumn(i, { align: $event })"
          />
        </div>
      </div>

      <div class="mt-1.5 border-t border-brand-border pt-1.5">
        <div class="mb-1 text-12px text-gray-500">数据格式</div>
        <div class="props-row">
          <span class="props-label">类型</span>
          <NSelect
            size="small"
            :value="col.format?.kind ?? 'none'"
            :options="formatKindOptions"
            @update:value="(k: CellFormatKind) => patchColumnFormat(i, formatFromKind(k))"
          />
        </div>
        <template v-if="col.format && col.format.kind !== 'none'">
          <div v-if="needsPattern(col.format.kind)" class="props-row">
            <span class="props-label">日期模板</span>
            <NSelect
              size="small"
              :value="isPresetDatePattern(col.format.pattern) ? col.format.pattern : '__custom__'"
              :options="datePatternOptions"
              @update:value="(v: string) => { if (v !== '__custom__') patchColumnFormat(i, { ...col.format!, pattern: v }) }"
            />
          </div>
          <div v-if="needsPattern(col.format.kind) && !isPresetDatePattern(col.format.pattern)" class="props-row">
            <span class="props-label">自定义</span>
            <NInput
              size="small"
              :value="col.format.pattern"
              placeholder="如 YYYY年MM月DD日"
              @update:value="(v: string) => patchColumnFormat(i, { ...col.format!, pattern: v || 'YYYY-MM-DD' })"
            />
          </div>
          <div v-if="needsDigits(col.format.kind)" class="props-row">
            <span class="props-label">小数位</span>
            <NInputNumber
              size="small"
              button-placement="both"
              :value="col.format.digits ?? (col.format.kind === 'int' ? 0 : 2)"
              :min="0"
              :max="6"
              @update:value="(v: number | null) => patchColumnFormat(i, { ...col.format!, digits: v ?? 0 })"
            />
          </div>
          <div v-if="needsCode(col.format.kind)" class="props-row">
            <span class="props-label">币种</span>
            <NSelect
              size="small"
              :value="col.format.code ?? 'CNY'"
              :options="currencyCodeOptions"
              @update:value="(v: string) => patchColumnFormat(i, { ...col.format!, code: v })"
            />
          </div>
          <div v-if="supportsThousands(col.format.kind)" class="props-row">
            <span class="props-label">千分位</span>
            <NSwitch
              size="small"
              :value="col.format.thousands ?? true"
              @update:value="(v: boolean) => patchColumnFormat(i, { ...col.format!, thousands: v })"
            />
          </div>
          <div v-if="fieldTypeOf(col.field)" class="props-tip">
            绑定的字段类型为 <b>{{ fieldTypeOf(col.field) === 'date' ? '日期' : '数值' }}</b>，建议相应选择日期 / 数值格式。
          </div>
        </template>
      </div>
      <NCollapse class="mt-1">
        <NCollapseItem title="单元格样式" name="col-style">
          <div class="grid grid-cols-2 gap-2">
            <div class="props-row">
              <span class="props-label">加粗</span>
              <NSwitch size="small" :value="col.style?.bold ?? false" @update:value="patchColumnStyle(i, { bold: $event })" />
            </div>
            <div class="props-row">
              <span class="props-label">字色</span>
              <NColorPicker
                size="small"
                :modes="['hex']"
                :value="col.style?.color"
                :show-alpha="false"
                @update:value="patchColumnStyle(i, { color: $event })"
              />
            </div>
            <div class="props-row">
              <span class="props-label">单元格底</span>
              <NColorPicker
                size="small"
                :modes="['hex']"
                :value="col.cellBackgroundColor"
                :show-alpha="true"
                @update:value="patchColumn(i, { cellBackgroundColor: $event || undefined })"
              />
            </div>
            <div class="props-row">
              <span class="props-label">表头底</span>
              <NColorPicker
                size="small"
                :modes="['hex']"
                :value="col.headerBackgroundColor"
                :show-alpha="true"
                @update:value="patchColumn(i, { headerBackgroundColor: $event || undefined })"
              />
            </div>
          </div>
        </NCollapseItem>
      </NCollapse>
    </div>
    <NButton size="small" dashed block @click="addColumn">+ 添加列</NButton>
  </div>

  <div v-if="control" class="props-section">
    <div class="props-title">默认单元格样式</div>
    <div class="props-tip">整表默认样式，可被列样式 / 单元格样式覆盖。</div>
    <div class="grid grid-cols-2 gap-2">
      <div class="props-row">
        <span class="props-label">字号(pt)</span>
        <NInputNumber
          size="small"
          button-placement="both"
          :value="control.options?.defaultCellStyle?.fontSize ?? null"
          :min="6"
          :max="72"
          placeholder="继承"
          clearable
          @update:value="patchDefaultStyle({ fontSize: $event })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">对齐</span>
        <NSelect
          size="small"
          :value="control.options?.defaultCellStyle?.align ?? 'left'"
          :options="alignOptions"
          @update:value="patchDefaultStyle({ align: $event })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">垂直对齐</span>
        <NSelect
          size="small"
          :value="control.options?.defaultCellStyle?.valign ?? 'middle'"
          :options="valignOptions"
          @update:value="patchDefaultStyle({ valign: $event })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">字色</span>
        <NColorPicker
          size="small"
          :modes="['hex']"
          :value="control.options?.defaultCellStyle?.color"
          :show-alpha="false"
          @update:value="patchDefaultStyle({ color: $event })"
        />
      </div>
      <div class="props-row">
        <span class="props-label">背景</span>
        <NColorPicker
          size="small"
          :modes="['hex']"
          :value="control.options?.defaultCellStyle?.backgroundColor"
          :show-alpha="true"
          @update:value="patchDefaultStyle({ backgroundColor: $event })"
        />
      </div>
    </div>
    <div class="mt-1 grid grid-cols-3 gap-2">
      <div class="props-row">
        <span class="props-label">加粗</span>
        <NSwitch size="small" :value="control.options?.defaultCellStyle?.bold ?? false" @update:value="patchDefaultStyle({ bold: $event })" />
      </div>
      <div class="props-row">
        <span class="props-label">斜体</span>
        <NSwitch size="small" :value="control.options?.defaultCellStyle?.italic ?? false" @update:value="patchDefaultStyle({ italic: $event })" />
      </div>
      <div class="props-row">
        <span class="props-label">下划线</span>
        <NSwitch size="small" :value="control.options?.defaultCellStyle?.underline ?? false" @update:value="patchDefaultStyle({ underline: $event })" />
      </div>
    </div>
  </div>

  <div v-if="control" class="props-section">
    <NCollapse>
      <NCollapseItem title="高级选项" name="advanced">
        <div class="props-row">
          <span class="props-label" style="min-width: 88px">整行跨页换页</span>
          <NSwitch
            size="small"
            :value="control.options?.keepTogether ?? false"
            @update:value="patchOptions({ keepTogether: $event })"
          />
        </div>
        <div class="props-row">
          <span class="props-label" style="min-width: 88px">跳过空行</span>
          <NSwitch
            size="small"
            :value="control.options?.skipEmptyRows ?? false"
            @update:value="patchOptions({ skipEmptyRows: $event })"
          />
        </div>
        <div class="props-row">
          <span class="props-label" style="min-width: 88px">斑马纹</span>
          <NSwitch
            size="small"
            :value="control.options?.striped ?? false"
            @update:value="patchOptions({ striped: $event })"
          />
        </div>
        <div class="props-row">
          <span class="props-label" style="min-width: 88px">垂直对齐</span>
          <NSelect
            size="small"
            :value="control.options?.verticalAlign ?? 'middle'"
            :options="valignOptions"
            @update:value="patchOptions({ verticalAlign: $event })"
          />
        </div>
        <div class="props-row">
          <span class="props-label" style="min-width: 88px, 88px">边框</span>
          <NSelect
            size="small"
            :value="control.options?.borders ?? 'all'"
            :options="[
              { label: '全部', value: 'all' },
              { label: '仅横线', value: 'horizontal' },
              { label: '仅外框', value: 'outline' },
              { label: '无', value: 'none' },
            ]"
            @update:value="patchOptions({ borders: $event })"
          />
        </div>
      </NCollapseItem>
    </NCollapse>
  </div>

  <VariableModal
    v-model:show="colVarShow"
    :binding="colVarIndex >= 0 ? (control?.columns[colVarIndex]?.field ?? '') : ''"
    @confirm="onColVarConfirm"
  />
</template>
