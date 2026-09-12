<script setup lang="ts">
/**
 * CellToolbar —— 单元格浮动工具栏（方案 A）
 *
 * 双击进入单元格后浮在其上方，提供 ERP 报表最常用的单元格级能力：
 * 字段绑定 / 字体族 / 字号 / 加粗斜体下划线 / 水平垂直对齐 / 文字色 / 填充色 / 横向合并 / 清除样式。
 *
 * 本组件**不直接改 store**：所有动作算出「新的表格控件」后 emit('apply')，
 * 由 TableViewLayer 统一写回并刷新 overlay —— 保持单一写入口，撤销栈干净。
 */
import { computed, ref } from 'vue'
import {
  NButton,
  NButtonGroup,
  NColorPicker,
  NDivider,
  NInput,
  NInputNumber,
  NSwitch,
  NSelect,
  NTooltip,
} from 'naive-ui'
import type { SelectOption, SelectGroupOption } from 'naive-ui'
import type { TableCell, TableCellStyle, TableControl, CellFormat, CellFormatKind } from '@/types/control'
import {
  buildDesignGrid,
  insertTableColumn,
  insertTableRow,
  patchCell,
  patchCellStyle,
  removeTableColumn,
  removeTableRow,
  resolveCellStyle,
  rowRoleLabel,
  setCellRowSpan,
  setCellSpan,
} from '@/core/layout-engine/table-cells'
import { FONT_CATALOG } from '@/core/fonts/catalog'
import { useSystemFonts } from '@/design/composables/useSystemFonts'
import { useDataSourceStore } from '@/design/stores/dataSource'
import ContentValueEditor from '@/design/panels/props/ContentValueEditor.vue'
import type { ContentMode } from '@/design/panels/props/ContentValueEditor.vue'
import ExpressionModal from '@/design/panels/props/ExpressionModal.vue'
import {
  formatKindOptions,
  datePatternOptions,
  currencyCodeOptions,
  makeFormat,
  needsPattern,
  needsDigits,
  needsCode,
  supportsThousands,
} from '@/design/format-options'

const props = defineProps<{
  control: TableControl
  row: number
  col: number
  /** 行语义：header=表头 / data=数据样例行（影响整列）/ static=静态行 */
  rowKind: 'header' | 'data' | 'static'
  x: number
  y: number
}>()

const emit = defineEmits<{
  (e: 'apply', next: TableControl): void
  (e: 'close'): void
}>()

const ds = useDataSourceStore()

const grid = computed(() => buildDesignGrid(props.control))
const cell = computed<TableCell>(() => grid.value.cells[props.row]?.[props.col] ?? {})
const column = computed(() => props.control.columns[props.col])
const style = computed<TableCellStyle>(() => resolveCellStyle(props.control, column.value, cell.value))

const sysFonts = useSystemFonts()

const fontOptions = computed<(SelectOption | SelectGroupOption)[]>(() => {
  const builtin: SelectOption[] = [
    { label: '默认', value: '' },
    ...FONT_CATALOG.map((f) => ({ label: f.label, value: f.family })),
  ]
  if (!sysFonts.ready.value) return builtin
  const sysOpts: SelectOption[] = sysFonts.grouped.value.map((g) => ({ label: g.family, value: g.family }))
  return [
    { type: 'group', label: '预设字体', key: 'builtin', children: builtin.filter((o) => o.value !== '') },
    { type: 'group', label: `电脑系统字体（${sysFonts.count.value}）`, key: 'system', children: sysOpts },
    { label: '默认', value: '' },
  ]
})

/**
 * 可绑定字段（用于变量模式默认值）：
 * - 数据样例行 → 明细表（数组）字段，运行期按行迭代
 * - 表头 / 静态行 → 主表标量字段
 */
const detailFields = computed(() => {
  const isDetail = props.rowKind === 'data'
  const tables = ds.activeSource?.tables ?? []
  const arrayTableIds = new Set(tables.filter((t) => t.isArray).map((t) => t.id))
  return ds.flatFields.filter((f) => {
    const inArray = f.tableId ? arrayTableIds.has(f.tableId) : f.path.includes('[]')
    return isDetail ? inArray : !inArray
  })
})

/** 变量模式默认路径：取该行语义下的第一个字段（数据行=明细字段，其余=标量字段） */
const bindingDefault = computed(
  () => detailFields.value[0]?.path ?? (props.rowKind === 'data' ? 'items[].name' : 'order.orderNo'),
)

/** 表达式模式默认值（数据行按行迭代，其余按主表上下文） */
const expressionDefault = computed(() =>
  props.rowKind === 'data' ? '{{rowIndex + 1}}' : '{{order.total}}',
)

/** 单元格内容三态：固定值 / 变量（字段绑定） / 表达式（显式 contentType，老模板启发式回退） */
const cellMode = computed<ContentMode>(() => {
  const c = cell.value
  if (c?.contentType) return c.contentType
  return c?.expression ? 'expression' : c?.field ? 'variable' : 'fixed'
})

/** 模式切换：写 contentType + 清空其它两个字段（默认值由编辑器按 bindingDefault 注入） */
function onCellMode(m: ContentMode): void {
  const p: Partial<TableCell> = { contentType: m }
  if (m === 'fixed') {
    p.field = undefined
    p.expression = undefined
  } else if (m === 'variable') {
    p.expression = undefined
  } else {
    p.field = undefined
  }
  emit('apply', patchCell(props.control, props.row, props.col, p))
}

function onCellValue(v: string): void {
  emit('apply', patchCell(props.control, props.row, props.col, { text: v }))
}

/** 变量模式：写 contentType + field 并清空 text/expression，保证 field 为唯一取值源 */
function onCellBinding(path: string): void {
  emit(
    'apply',
    patchCell(props.control, props.row, props.col, {
      contentType: 'variable',
      field: path || undefined,
      text: undefined,
      expression: undefined,
    }),
  )
}

function onCellExpression(v: string): void {
  emit(
    'apply',
    patchCell(props.control, props.row, props.col, {
      contentType: 'expression',
      expression: v || undefined,
      text: undefined,
      field: undefined,
    }),
  )
}

/** 仅绑定了字段/表达式（或显式 variable/expression 模式）的单元格才需要格式（纯静态文字格式无意义） */
const canFormat = computed(
  () =>
    cell.value.contentType === 'variable' ||
    cell.value.contentType === 'expression' ||
    Boolean(cell.value.field || cell.value.expression) ||
    (props.rowKind === 'data' && Boolean(column.value?.field || column.value?.expression)),
)

/** 生效中的格式（单元格优先，回落列默认） */
const cellFormat = computed<CellFormat | undefined>(() => cell.value.format ?? column.value?.format)

/* --------------------------------- 动作 -------------------------------- */

function applyStyle(patch: TableCellStyle): void {
  emit('apply', patchCellStyle(props.control, props.row, props.col, patch))
}

/* ----- 动态配色：把 {{}} 表达式写入列级 columns[i].style ----- */
/** 文字色 / 填充色表达式弹窗显示态 */
const colorExprShow = ref(false)
const bgExprShow = ref(false)
/** 当前正在编辑的表达式初始值（从列级 style 回显） */
const colorExprInit = computed(() => column.value?.style?.color ?? '')
const bgExprInit = computed(() => column.value?.style?.backgroundColor ?? '')

/** 文字色 / 填充色是否处于「表达式模式」（值含 {{）—— 此时色块按钮显示 fx 占位 */
const isColorExpr = computed(() => /\{\{/.test(column.value?.style?.color ?? ''))
const isBgExpr = computed(() => /\{\{/.test(column.value?.style?.backgroundColor ?? ''))

/** 写入列级 style（columns[i].style），整列数据行生效 */
function applyColumnStyle(patch: TableCellStyle): void {
  const cur = column.value?.style ?? {}
  const merged: TableCellStyle = { ...cur }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k]
    else (merged as Record<string, unknown>)[k] = v
  }
  // 复用上层 patchColumn：构造新 columns 数组并 emit('apply')
  const columns = props.control.columns.map((c, i) =>
    i === props.col ? { ...c, style: merged } : c,
  )
  emit('apply', { ...props.control, columns })
}

function onColorExprConfirm(v: string): void {
  applyColumnStyle({ color: v || undefined })
}
function onBgExprConfirm(v: string): void {
  applyColumnStyle({ backgroundColor: v || undefined })
}

function toggle(key: 'bold' | 'italic' | 'underline'): void {
  applyStyle({ [key]: !style.value[key] } as TableCellStyle)
}

const spanMax = computed(() => grid.value.colCount - props.col)
const currentSpan = computed(() => Math.min(cell.value.colSpan ?? 1, spanMax.value))

function setSpan(n: number | null): void {
  emit('apply', setCellSpan(props.control, props.row, props.col, n ?? 1))
}

/**
 * 纵向合并（rowSpan）。
 * 仅表头 / 静态 / 布局网格行生效：数据行由运行期逐条生成，跨行会跨越不同记录，语义不成立，
 * 故数据样例行（rowKind==='data'）禁用该项，与表格引擎的"模板行强制 rowSpan=1"一致。
 */
const canRowSpan = computed(() => props.rowKind !== 'data')
const rowSpanMax = computed(() => grid.value.rowCount - props.row)
const currentRowSpan = computed(() => Math.min(cell.value.rowSpan ?? 1, rowSpanMax.value))

function setRowSpan(n: number | null): void {
  if (!canRowSpan.value) return
  emit('apply', setCellRowSpan(props.control, props.row, props.col, n ?? 1))
}

function clearStyle(): void {
  emit('apply', patchCell(props.control, props.row, props.col, { style: undefined }))
}

/** 单元格斜线（课表角标等）：无 / 左上→右下 / 左下→右上 */
const diagOptions = [
  { label: '无', value: 'none' },
  { label: '↘ 右下', value: 'down' },
  { label: '↗ 右上', value: 'up' },
]
const currentDiagonal = computed<'none' | 'down' | 'up'>(() => cell.value.style?.diagonal ?? 'none')
function setDiagonal(v: 'none' | 'down' | 'up'): void {
  applyStyle({ diagonal: v === 'none' ? undefined : v })
}

function applyFormat(fmt: CellFormat | undefined): void {
  // kind='none' 视为清除，避免脏字段
  emit('apply', patchCell(props.control, props.row, props.col, { format: fmt && fmt.kind !== 'none' ? fmt : undefined }))
}

function isPresetDatePattern(p?: string): boolean {
  return Boolean(p && datePatternOptions.some((o) => o.value !== '__custom__' && o.value === p))
}

/** 行角色名（标题行 / 数据行 / 本页合计行 / 总计行 / 大写金额行），用于工具栏标签 */
const roleLabel = computed(() => {
  if (props.rowKind === 'data') return '数据行（影响整列）'
  return rowRoleLabel(buildDesignGrid(props.control), props.row)
})

/* --------------------------------- 行列插入 -------------------------------- */

function insertRowAbove(): void {
  emit('apply', insertTableRow(props.control, props.row))
}

function insertRowBelow(): void {
  emit('apply', insertTableRow(props.control, props.row + 1))
}

function insertColLeft(): void {
  emit('apply', insertTableColumn(props.control, props.col))
}

function insertColRight(): void {
  emit('apply', insertTableColumn(props.control, props.col + 1))
}

/** 删除本行 / 本列（数据表的数据样例行不可删，由 canDeleteRow 收敛） */
const canDeleteRow = computed(
  () => props.rowKind !== 'data' && grid.value.rowCount > 1,
)
const canDeleteCol = computed(() => grid.value.colCount > 1)

function deleteRow(): void {
  emit('apply', removeTableRow(props.control, props.row))
}

function deleteCol(): void {
  emit('apply', removeTableColumn(props.control, props.col))
}
</script>

<template>
  <div
    class="op-cell-toolbar"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @mousedown.stop
    @dblclick.stop
  >
    <div class="op-cell-toolbar__inner">
      <!-- 第 0 行：内容三态（固定值 / 变量 / 表达式），与文本组件完全一致 -->
      <div class="op-cell-toolbar__row">
        <span class="op-cell-toolbar__tag">内容</span>
        <ContentValueEditor
          class="op-cell-content"
          compact
          :mode="cellMode"
          :value="cell.text ?? ''"
          :binding="cell.field ?? ''"
          :expression="cell.expression ?? ''"
          placeholder="单元格内容"
          :binding-default="bindingDefault"
          :expression-default="expressionDefault"
          @update:mode="onCellMode"
          @update:value="onCellValue"
          @update:binding="onCellBinding"
          @update:expression="onCellExpression"
        />
      </div>

      <!-- 第一行：行角色 / 字体 / 字形 / 对齐 -->
      <div class="op-cell-toolbar__row">
        <span class="op-cell-toolbar__tag">{{ roleLabel }}</span>

        <NDivider vertical />

        <NSelect
          size="tiny"
          class="w-24"
          :value="style.fontFamily ?? ''"
          :options="fontOptions"
          filterable
          @update:value="(v: string) => applyStyle({ fontFamily: v || undefined })"
        />
        <NInputNumber
          size="tiny"
          class="w-18"
          button-placement="both"
          :value="style.fontSize ?? null"
          :min="5"
          :max="72"
          :step="1"
          placeholder="9"
          @update:value="(v: number | null) => applyStyle({ fontSize: v ?? undefined })"
        />

        <NButtonGroup size="tiny">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton :type="style.bold ? 'primary' : 'default'" @click="toggle('bold')">
                <span class="font-bold">B</span>
              </NButton>
            </template>
            加粗
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton :type="style.italic ? 'primary' : 'default'" @click="toggle('italic')">
                <span class="italic font-serif">I</span>
              </NButton>
            </template>
            斜体
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton :type="style.underline ? 'primary' : 'default'" @click="toggle('underline')">
                <span class="underline">U</span>
              </NButton>
            </template>
            下划线
          </NTooltip>
        </NButtonGroup>

        <NButtonGroup size="tiny">
          <NTooltip
            v-for="a in (['left', 'center', 'right'] as const)"
            :key="a"
            trigger="hover"
          >
            <template #trigger>
              <NButton
                :type="style.align === a ? 'primary' : 'default'"
                @click="applyStyle({ align: a })"
              >
                <span :class="`i-carbon-text-align-${a}`" />
              </NButton>
            </template>
            {{ { left: '左对齐', center: '居中', right: '右对齐' }[a] }}
          </NTooltip>
        </NButtonGroup>

        <NButtonGroup size="tiny">
          <NTooltip
            v-for="v in (['top', 'middle', 'bottom'] as const)"
            :key="v"
            trigger="hover"
          >
            <template #trigger>
              <NButton
                :type="style.valign === v ? 'primary' : 'default'"
                @click="applyStyle({ valign: v })"
              >
                <span :class="`i-carbon-align-vertical-${v === 'middle' ? 'center' : v}`" />
              </NButton>
            </template>
            {{ { top: '顶端对齐', middle: '垂直居中', bottom: '底端对齐' }[v] }}
          </NTooltip>
        </NButtonGroup>
      </div>

      <!-- 第二行：文字色 / 填充色 / 合并 / 清除 -->
      <div class="op-cell-toolbar__row">
        <!-- 文字颜色：自定义触发器 + to=false 让面板留在工具栏内，避免点选时工具栏被收起 -->
        <NColorPicker
          :value="isColorExpr ? '#1f2329' : (style.color ?? '#1f2329')"
          :show-alpha="false"
          :modes="['hex']"
          :to="false"
          size="small"
          @update:value="(v: string) => applyStyle({ color: v || undefined })"
        >
          <template #trigger="{ value, onClick, ref: triggerRef }">
            <NButton :ref="triggerRef" size="tiny" quaternary title="文字颜色" @click="onClick">
              <span class="i-carbon-text-color" />
              <span v-if="isColorExpr" class="op-cell-toolbar__swatch op-cell-toolbar__swatch--fx" title="表达式配色">
                <span class="i-carbon-function" />
              </span>
              <span v-else class="op-cell-toolbar__swatch" :style="{ background: value || '#1f2329' }" />
            </NButton>
          </template>
        </NColorPicker>
        <!-- 文字色：切到表达式模式（fx 按钮） -->
        <NButton size="tiny" quaternary title="文字色表达式（如 {{row.amount < 0 ? '#D93636' : ''}}）" @click="colorExprShow = true">
          <span class="i-carbon-function" :class="{ 'is-active': isColorExpr }" />
        </NButton>

        <!-- 填充颜色（含清除） -->
        <NColorPicker
          :value="isBgExpr ? '#ffffff' : (style.backgroundColor ?? '#ffffff')"
          :show-alpha="false"
          :modes="['hex']"
          :to="false"
          size="small"
          @update:value="(v: string) => applyStyle({ backgroundColor: v || undefined })"
        >
          <template #trigger="{ value, onClick, ref: triggerRef }">
            <NButton :ref="triggerRef" size="tiny" quaternary title="填充颜色" @click="onClick">
              <span class="i-carbon-paint-brush" />
              <span v-if="isBgExpr" class="op-cell-toolbar__swatch op-cell-toolbar__swatch--fx" title="表达式配色">
                <span class="i-carbon-function" />
              </span>
              <span
                v-else
                class="op-cell-toolbar__swatch"
                :style="{ background: value || 'transparent' }"
              />
            </NButton>
          </template>
        </NColorPicker>
        <!-- 填充色：切到表达式模式（fx 按钮） -->
        <NButton size="tiny" quaternary title="填充色表达式（如 {{row.amount < 0 ? '#FFE5E5' : '#fff'}}）" @click="bgExprShow = true">
          <span class="i-carbon-function" :class="{ 'is-active': isBgExpr }" />
        </NButton>
        <NButton size="tiny" quaternary title="清除填充" @click="applyStyle({ backgroundColor: undefined })">
          <span class="i-carbon-clean" />
        </NButton>

        <NTooltip trigger="hover">
          <template #trigger>
            <NSelect
              size="tiny"
              style="width: 92px"
              :value="currentDiagonal"
              :options="diagOptions"
              @update:value="setDiagonal"
            />
          </template>
          单元格斜线（课表角标）：无 / ↘左上→右下 / ↗左下→右上
        </NTooltip>

        <NDivider vertical />

        <NTooltip trigger="hover">
          <template #trigger>
            <NInputNumber
              size="tiny"
              class="w-20"
              button-placement="both"
              :value="currentSpan"
              :min="1"
              :max="spanMax"
              :step="1"
              @update:value="setSpan"
            />
          </template>
          横向合并列数
        </NTooltip>

        <NTooltip trigger="hover">
          <template #trigger>
            <NInputNumber
              size="tiny"
              class="w-20"
              :value="currentRowSpan"
              button-placement="both"
              :min="1"
              :max="rowSpanMax"
              :step="1"
              :disabled="!canRowSpan"
              @update:value="setRowSpan"
            />
          </template>
          纵向合并行数（数据行不跨行）
        </NTooltip>

        <NDivider vertical />

        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary @click="clearStyle">
              <span class="i-carbon-clean" />
            </NButton>
          </template>
          清除本格样式
        </NTooltip>

        <NDivider vertical />

        <span class="op-cell-toolbar__tag">行列</span>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary title="上方插入行" @click="insertRowAbove">
              <span class="i-carbon-arrow-up" />
            </NButton>
          </template>
          上方插入行
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary title="下方插入行" @click="insertRowBelow">
              <span class="i-carbon-arrow-down" />
            </NButton>
          </template>
          下方插入行
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary title="左侧插入列" @click="insertColLeft">
              <span class="i-carbon-arrow-left" />
            </NButton>
          </template>
          左侧插入列
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary title="右侧插入列" @click="insertColRight">
              <span class="i-carbon-arrow-right" />
            </NButton>
          </template>
          右侧插入列
        </NTooltip>

        <NDivider vertical />

        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary :disabled="!canDeleteRow" title="删除本行" @click="deleteRow">
              <span class="i-carbon-trash-can" />
            </NButton>
          </template>
          删除本行
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="tiny" quaternary :disabled="!canDeleteCol" title="删除本列" @click="deleteCol">
              <span class="i-carbon-trash-can" />
            </NButton>
          </template>
          删除本列
        </NTooltip>

        <NButton size="tiny" quaternary @click="emit('close')">
          <span class="i-carbon-close" />
        </NButton>
      </div>

      <!-- 第三行：数据格式（仅绑定字段的单元格） -->
      <div v-if="canFormat" class="op-cell-toolbar__row op-cell-toolbar__format">
        <span class="op-cell-toolbar__tag">格式</span>
        <NSelect
          size="tiny"
          class="w-24"
          :value="cellFormat?.kind ?? 'none'"
          :options="formatKindOptions"
          @update:value="(k: CellFormatKind) => applyFormat(k === 'none' ? undefined : makeFormat(k))"
        />
        <template v-if="cellFormat && cellFormat.kind !== 'none'">
          <NSelect
            v-if="needsPattern(cellFormat.kind)"
            size="tiny"
            class="w-30"
            :value="isPresetDatePattern(cellFormat.pattern) ? cellFormat.pattern : '__custom__'"
            :options="datePatternOptions"
            @update:value="(v: string) => { if (v !== '__custom__') applyFormat({ ...cellFormat!, pattern: v }) }"
          />
          <NInput
            v-if="needsPattern(cellFormat.kind) && !isPresetDatePattern(cellFormat.pattern)"
            size="tiny"
            class="w-30"
            :value="cellFormat.pattern"
            placeholder="如 YYYY年MM月DD日"
            @update:value="(v: string) => applyFormat({ ...cellFormat!, pattern: v || 'YYYY-MM-DD' })"
          />
          <NInputNumber
            v-if="needsDigits(cellFormat.kind)"
            size="tiny"
            class="w-16"
            button-placement="both"
            :value="cellFormat.digits ?? (cellFormat.kind === 'int' ? 0 : 2)"
            :min="0"
            :max="6"
            @update:value="(v: number | null) => applyFormat({ ...cellFormat!, digits: v ?? 0 })"
          />
          <NSelect
            v-if="needsCode(cellFormat.kind)"
            size="tiny"
            class="w-20"
            :value="cellFormat.code ?? 'CNY'"
            :options="currencyCodeOptions"
            @update:value="(v: string) => applyFormat({ ...cellFormat!, code: v })"
          />
          <NSwitch
            v-if="supportsThousands(cellFormat.kind)"
            size="small"
            :value="cellFormat.thousands ?? true"
            @update:value="(v: boolean) => applyFormat({ ...cellFormat!, thousands: v })"
          />
        </template>
      </div>
    </div>

    <!-- 动态配色：文字色 / 填充色表达式编辑 -->
    <ExpressionModal
      v-model:show="colorExprShow"
      :expression="colorExprInit"
      @confirm="onColorExprConfirm"
    />
    <ExpressionModal
      v-model:show="bgExprShow"
      :expression="bgExprInit"
      @confirm="onBgExprConfirm"
    />
  </div>
</template>

<style scoped>
.op-cell-toolbar {
  position: absolute;
  transform: translateY(-100%) translateY(-8px);
  pointer-events: auto;
  z-index: 30;
}

.op-cell-toolbar__inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--brand-surface, #ffffff);
  border: 1px solid var(--brand-border, #e5e6eb);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  max-width: 92vw;
}

.op-cell-toolbar__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.op-cell-toolbar__tag {
  font-size: 11px;
  color: var(--brand-text-secondary, #86909c);
  padding-right: 2px;
}

.op-cell-toolbar__swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  vertical-align: middle;
}
/* 表达式配色时，色块占位显示 fx 图标 + 紫底，提示此处由表达式求值 */
.op-cell-toolbar__swatch--fx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #b084ff 0%, #6b5cff 100%);
  border-color: rgba(107, 92, 255, 0.5);
  color: #fff;
}
.op-cell-toolbar__swatch--fx .i-carbon-function {
  font-size: 10px;
  line-height: 1;
}
/* fx 按钮处于激活态（值已是表达式）时高亮 */
.i-carbon-function.is-active {
  color: #6b5cff;
}
</style>
