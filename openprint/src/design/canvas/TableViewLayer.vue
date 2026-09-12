<script setup lang="ts">
/**
 * TableViewLayer —— 表格 HTML overlay（方案 A 的载体）
 *
 * 设计期表格不再由 Fabric 画位图，而是用**真 DOM 表格**绝对定位覆盖在画布上，
 * transform 与 Fabric 节点（left/top/scale/angle）+ 视口（zoom/offset）实时同步。
 * 由于渲染 HTML 与运行期 html-renderer 同构、CSS 来自同一个 `tableCss()`，
 * 所以「设计所见」= 「打印所得」，且浏览器原生白送文本编辑 / 选区 / 键盘 / Excel 粘贴。
 *
 * 交互契约（关键）：
 * - 平时整层 `pointer-events:none`，所有点击照旧落到 Fabric（选中 / 拖拽 / 缩放不受影响）
 * - 双击表格 → Fabric 命中单元格 → store.editingCell 置位 → **仅该表**开启 pointer-events
 *   与 contenteditable，进入单元格编辑；Esc / 点击别处退出
 * - 编辑期间冻结该表 HTML（不因 store 变化重渲染），避免光标被吞
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDesignerStore } from '@/design/stores/designer'
import { PrintTable } from './controls/PrintTable'
import { renderTableGridHtml } from './table-design-render'
import { tableCss } from '@/core/renderer-html/css-generator'
import { buildDesignGrid, designRowInfo, patchCellText, rowRoleLabel } from '@/core/layout-engine/table-cells'
import type { AnyControl, TableControl } from '@/types/control'
import { collectOverlayItems, overlayItemStyle, type OverlayItem } from './overlay-logic'
import CellToolbar from './CellToolbar.vue'

const store = useDesignerStore()

const layerRef = ref<HTMLElement | null>(null)
/** 编辑中表格的冻结 HTML：编辑期间不随 store 重渲染，保护光标 */
const frozenHtml = ref<string>('')
const toolbarPos = ref<{ x: number; y: number } | null>(null)

const editingId = computed(() => store.editingCell?.controlId ?? null)

/** 编辑行首列左侧的角色名标签（标题行 / 数据行 / 本页合计行 / 总计行 / 大写金额行）位置与文案 */
const rowLabelPos = ref<{ x: number; y: number } | null>(null)
const editingRowLabel = computed(() => {
  const control = editingControl.value
  const e = store.editingCell
  if (!control || !e) return ''
  return rowRoleLabel(buildDesignGrid(control), e.row)
})

/** 从 store 模型里取表格控件（overlay 写回的目标） */
function controlById(id: string): TableControl | undefined {
  const flat: AnyControl[] = [
    ...store.controls,
    ...store.zones.flatMap((z) => z.children),
  ]
  const hit = flat.find((c) => c.id === id)
  return hit?.type === 'table' ? (hit as TableControl) : undefined
}

/**
 * 每个表格一项：几何取自 Fabric 对象（拖拽/缩放过程中实时），内容取自 store 模型。
 *
 * 几何与内容组装走框架无关的 `overlay-logic`（React 端同名组件共用同一份）；
 * canvasTick 是显式依赖 —— Fabric 对象不是响应式的，靠画布事件驱动重算。
 * 编辑期该项改用「冻结 HTML」：避免 store 变化触发重渲染把光标吞掉。
 */
const items = computed<OverlayItem[]>(() => {
  void store.canvasTick
  void store.controls
  void store.zones
  return collectOverlayItems<PrintTable>({
    canvas: store.designer?.canvas ?? null,
    store,
    isTarget: (o): o is PrintTable => o instanceof PrintTable,
    type: 'table',
    render: (c) => renderTableGridHtml(c as TableControl),
    htmlOverride: (id) =>
      id === editingId.value && frozenHtml.value ? frozenHtml.value : undefined,
  })
})

/* ------------------------------ 样式注入 ------------------------------ */

// 与打印产物共用同一份表格 CSS（tableCss），只是限定在 overlay 作用域内
const STYLE_ID = 'op-table-overlay-css'
onMounted(() => {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = tableCss('.op-table-overlay')
  document.head.appendChild(el)
})

/* ------------------------------ 编辑会话 ------------------------------ */

function wrapperOf(id: string): HTMLElement | null {
  return layerRef.value?.querySelector<HTMLElement>(`[data-table-id="${CSS.escape(id)}"]`) ?? null
}

function tdOf(id: string, row: number, col: number): HTMLElement | null {
  return wrapperOf(id)?.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`) ?? null
}

function selectAll(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** 会话开始：冻结 HTML → 开 contenteditable → 聚焦目标单元格并全选 */
watch(
  () => editingId.value,
  async (id) => {
    if (!id) {
      frozenHtml.value = ''
      toolbarPos.value = null
      rowLabelPos.value = null
      return
    }
    const control = controlById(id)
    frozenHtml.value = control ? renderTableGridHtml(control) : ''
    await nextTick()
    enableEditing(id)
    focusCell()
  },
)

/** 编辑目标单元格变化（Tab / 点击别的格子）→ 移动工具栏 */
watch(() => [store.editingCell?.row, store.editingCell?.col], () => void nextTick(syncToolbarPos))
watch(() => store.canvasTick, () => syncToolbarPos())

function enableEditing(id: string): void {
  const wrap = wrapperOf(id)
  if (!wrap) return
  for (const td of wrap.querySelectorAll('td')) {
    td.setAttribute('contenteditable', 'true')
    td.setAttribute('spellcheck', 'false')
  }
}

async function focusCell(): Promise<void> {
  const e = store.editingCell
  if (!e) return
  await nextTick()
  const td = tdOf(e.controlId, e.row, e.col)
  if (!td) return
  td.focus({ preventScroll: true })
  selectAll(td)
  syncToolbarPos()
}

function syncToolbarPos(): void {
  const e = store.editingCell
  const root = layerRef.value
  if (!e || !root) {
    toolbarPos.value = null
    return
  }
  const td = tdOf(e.controlId, e.row, e.col)
  if (!td) {
    toolbarPos.value = null
    return
  }
  const a = td.getBoundingClientRect()
  const b = root.getBoundingClientRect()
  toolbarPos.value = { x: a.left - b.left, y: a.top - b.top }
  // 行名标签：锚定到当前行首列左侧
  const firstTd = tdOf(e.controlId, e.row, 0)
  if (firstTd) {
    const fa = firstTd.getBoundingClientRect()
    rowLabelPos.value = { x: fa.left - b.left, y: fa.top - b.top }
  } else {
    rowLabelPos.value = null
  }
}

/* ------------------------------ 内容写回 ------------------------------ */

/** 把某个 td 的文本提交到模型（未变化则不入撤销栈） */
function commitTd(td: HTMLElement): void {
  const id = td.closest<HTMLElement>('[data-table-id]')?.dataset.tableId
  if (!id) return
  const control = controlById(id)
  if (!control) return
  const row = Number(td.dataset.row)
  const col = Number(td.dataset.col)
  if (!Number.isFinite(row) || !Number.isFinite(col)) return
  const next = patchCellText(control, row, col, td.innerText)
  if (next === control) return
  store.updateControl(id, next)
}

function onFocusIn(e: FocusEvent): void {
  const td = (e.target as HTMLElement | null)?.closest<HTMLElement>('td[data-row]')
  const id = td?.closest<HTMLElement>('[data-table-id]')?.dataset.tableId
  if (!td || !id) return
  store.openCellEditor(id, Number(td.dataset.row), Number(td.dataset.col))
  void nextTick(syncToolbarPos)
}

function onFocusOut(e: FocusEvent): void {
  const td = (e.target as HTMLElement | null)?.closest<HTMLElement>('td[data-row]')
  if (td) commitTd(td)
}

/** Tab / Enter 的下一个目标单元格（跨行回绕，越界返回 null） */
function nextCell(control: TableControl, row: number, col: number, dir: 1 | -1): { row: number; col: number } | null {
  const grid = buildDesignGrid(control)
  let r = row
  let c = col + dir
  if (c >= grid.colCount) {
    c = 0
    r += 1
  } else if (c < 0) {
    c = grid.colCount - 1
    r -= 1
  }
  if (r < 0 || r >= grid.rowCount) return null
  return { row: r, col: c }
}

async function moveTo(id: string, row: number, col: number): Promise<void> {
  store.openCellEditor(id, row, col)
  await nextTick()
  const td = tdOf(id, row, col)
  if (td) {
    td.focus({ preventScroll: true })
    selectAll(td)
  }
  syncToolbarPos()
}

function onKeyDown(e: KeyboardEvent): void {
  const td = (e.target as HTMLElement | null)?.closest<HTMLElement>('td[data-row]')
  const id = td?.closest<HTMLElement>('[data-table-id]')?.dataset.tableId
  if (!td || !id) return

  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    commitTd(td)
    exitEditing()
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    commitTd(td)
    const control = controlById(id)
    if (!control) return
    const to = nextCell(control, Number(td.dataset.row), Number(td.dataset.col), e.shiftKey ? -1 : 1)
    if (to) void moveTo(id, to.row, to.col)
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    // Excel 习惯：回车提交并下移一行；末行则结束编辑
    e.preventDefault()
    commitTd(td)
    const control = controlById(id)
    if (!control) return
    const grid = buildDesignGrid(control)
    const r = Number(td.dataset.row) + 1
    if (r < grid.rowCount) void moveTo(id, r, Number(td.dataset.col))
    else exitEditing()
  }
}

/** 粘贴：一律纯文本；含制表符/换行时按 Excel 语义铺到多个单元格 */
function onPaste(e: ClipboardEvent): void {
  const td = (e.target as HTMLElement | null)?.closest<HTMLElement>('td[data-row]')
  const id = td?.closest<HTMLElement>('[data-table-id]')?.dataset.tableId
  if (!td || !id) return
  const text = e.clipboardData?.getData('text/plain') ?? ''
  e.preventDefault()
  if (!text) return

  const matrix = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((line) => line.split('\t'))
  if (matrix.length === 1 && matrix[0]!.length === 1) {
    document.execCommand('insertText', false, matrix[0]![0]!)
    return
  }

  const control = controlById(id)
  if (!control) return
  const grid = buildDesignGrid(control)
  const baseRow = Number(td.dataset.row)
  const baseCol = Number(td.dataset.col)
  let next: TableControl = control
  matrix.forEach((line, dr) => {
    line.forEach((value, dc) => {
      const r = baseRow + dr
      const c = baseCol + dc
      if (r >= grid.rowCount || c >= grid.colCount) return
      next = patchCellText(next, r, c, value)
    })
  })
  if (next !== control) {
    store.updateControl(id, next)
    refreshFrozen(id)
  }
}

/* ------------------------------ 会话收尾 ------------------------------ */

function exitEditing(): void {
  const e = store.editingCell
  if (e) {
    const td = tdOf(e.controlId, e.row, e.col)
    if (td) commitTd(td)
  }
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  store.closeCellEditor()
}

/** 工具栏改样式后重放 HTML（保留编辑态与焦点） */
async function refreshFrozen(id: string, refocus = true): Promise<void> {
  const control = controlById(id)
  if (!control) return
  frozenHtml.value = renderTableGridHtml(control)
  await nextTick()
  enableEditing(id)
  // 工具条触发的刷新只更新冻结 HTML，不夺走工具条输入框焦点（避免光标消失）
  if (refocus) void focusCell()
}

/**
 * naive-ui 的浮层（下拉菜单 / 取色器 / 弹层）会被 teleport 到 body，
 * 不在 overlay 内。点击它们时若走 onDocMouseDown 的"点外面就关闭"逻辑，
 * 会在选项真正生效前就销毁工具栏，导致下拉交互（如单元格斜线）"点了没反应"。
 * 因此对这类 teleport 浮层内的 mousedown 一律豁免，不结束编辑。
 */
const NAIVE_TELEPORT_SELECTOR =
  '.n-base-select-menu, .n-color-picker, .n-popover, .n-dropdown-menu, .n-base-select, ' +
  '.n-tooltip, .n-modal, .n-drawer, .n-message, .n-notification, .n-dialog, [class*="n-base-select"]'

function isNaiveTeleportTarget(target: Node | null): boolean {
  if (!target) return false
  if (!(target instanceof Element)) {
    const parent = target.parentElement
    return parent ? isNaiveTeleportTarget(parent) : false
  }
  return Boolean(target.closest(NAIVE_TELEPORT_SELECTOR))
}

function onDocMouseDown(e: MouseEvent): void {
  if (!store.editingCell) return
  const target = e.target as Node | null
  if (target && layerRef.value?.contains(target)) return
  // naive-ui 浮层可能 teleport 到 body，点击它们不结束编辑
  if (isNaiveTeleportTarget(target)) return
  exitEditing()
}

onMounted(() => document.addEventListener('mousedown', onDocMouseDown, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown, true))

/* ------------------------------ 工具栏动作 ------------------------------ */

function onToolbarApply(next: TableControl): void {
  const id = store.editingCell?.controlId
  if (!id) return
  store.updateControl(id, next)
  // 工具条输入触发的刷新不夺焦，避免 NInput 光标丢失
  void refreshFrozen(id, /* refocus */ false)
}

const editingControl = computed<TableControl | null>(() => {
  const id = editingId.value
  return id ? (controlById(id) ?? null) : null
})

/** 当前编辑格的行语义（表头 / 数据样例 / 静态），工具栏据此调整可用项 */
const editingRowKind = computed(() => {
  const control = editingControl.value
  const e = store.editingCell
  if (!control || !e) return null
  return designRowInfo(buildDesignGrid(control), e.row)
})
</script>

<template>
  <div
    ref="layerRef"
    class="op-table-overlay absolute inset-0 overflow-hidden"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @keydown="onKeyDown"
    @paste="onPaste"
  >
    <div
      v-for="it in items"
      :key="it.id"
      class="op-table-overlay__item"
      :class="{ 'is-editing': it.id === editingId }"
      :data-table-id="it.id"
      :style="overlayItemStyle(it)"
      v-html="it.html"
    />

    <div
      v-if="editingControl && store.editingCell && rowLabelPos"
      class="op-row-label"
      :style="{ left: `${rowLabelPos.x}px`, top: `${rowLabelPos.y}px` }"
    >
      {{ editingRowLabel }}
    </div>

    <CellToolbar
      v-if="editingControl && store.editingCell && toolbarPos"
      :control="editingControl"
      :row="store.editingCell.row"
      :col="store.editingCell.col"
      :row-kind="editingRowKind?.kind ?? 'static'"
      :x="toolbarPos.x"
      :y="toolbarPos.y"
      @apply="onToolbarApply"
      @close="exitEditing"
    />
  </div>
</template>

<style scoped>
.op-table-overlay {
  /* 平时完全透明于鼠标：所有交互照旧交给 Fabric */
  pointer-events: none;
  /* 与打印产物同名的边框色变量，供 tableCss 注入的规则取用 */
  --op-table-border: #333333;
}

.op-table-overlay__item {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  /* 不裁剪表格内容：行高可能被内容（如窄列里的"本页合计/大写金额"标签换行）撑得比
     控制框高度高，裁剪会把末尾行藏掉（看不见、拉大控制框才出现）。溢出显示保证
     画布所见 = 渲染所得；非编辑态 pointer-events:none，不挡 Fabric 交互。 */
  overflow: visible;
}

.op-table-overlay__item.is-editing {
  pointer-events: auto;
  outline: 1px solid var(--brand-primary, #1677ff);
  outline-offset: 1px;
  /* 编辑态不裁剪：用户输入多行文本时允许撑出包围盒完整显示 */
  overflow: visible;
}

/* 编辑态放开占位符的单行截断（nowrap/ellipsis 是设计态展示用），允许换行输入 */
.op-table-overlay__item.is-editing :deep(td) {
  white-space: normal !important;
  overflow: visible !important;
  text-overflow: clip !important;
}

/* v-html 内容不受 scoped 影响，需用 :deep 穿透 */
.op-table-overlay__item :deep(table) {
  margin: 0;
}

.op-table-overlay__item.is-editing :deep(td:focus) {
  outline: 2px solid var(--brand-primary, #1677ff);
  outline-offset: -2px;
  background-color: rgba(22, 119, 255, 0.06);
}

/* 双击编辑时，首列左侧行角色名标签（标题行/数据行/本页合计行/总计行/大写金额行） */
.op-row-label {
  position: absolute;
  transform: translateX(calc(-100% - 6px));
  pointer-events: none;
  font-size: 11px;
  line-height: 1.4;
  color: var(--brand-primary, #1677ff);
  background: rgba(22, 119, 255, 0.1);
  border: 1px solid var(--brand-primary, #1677ff);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
  z-index: 29;
}
</style>
