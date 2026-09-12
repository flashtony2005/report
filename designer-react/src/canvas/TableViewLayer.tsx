/**
 * TableViewLayer —— 表格 HTML overlay（React 版，方案 A 的载体）
 *
 * 与 Vue 版 `canvas/TableViewLayer.vue` 职责一致：设计期表格不由 Fabric 画位图，
 * 而是用**真 DOM 表格**绝对定位覆盖在画布上，transform 与 Fabric 节点
 * （left/top/scale/angle）+ 视口（zoom/offset）实时同步。渲染 HTML 与运行期
 * html-renderer 同构、CSS 来自同一个 `tableCss()`，所以「设计所见 = 打印所得」，
 * 且浏览器原生白送文本编辑 / 选区 / 键盘 / Excel 粘贴。
 *
 * 交互契约（关键，与 Vue 版逐条对齐）：
 * - 平时整层 `pointer-events:none`，所有点击照旧落到 Fabric（选中 / 拖拽 / 缩放不受影响）
 * - 双击表格 → Fabric 命中单元格 → store.editingCell 置位 → **仅该表**开启 pointer-events
 *   与 contenteditable，进入单元格编辑；Esc / 点击别处退出
 * - 编辑期间冻结该表 HTML（不因 store 变化重渲染），避免光标被吞
 *
 * 几何/内容组装走共享 `overlay-logic`（与 Vue 端同一份）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { PrintTable } from '@/design/canvas/controls/PrintTable'
import { renderTableGridHtml } from '@/design/canvas/table-design-render'
import { tableCss } from '@/core/renderer-html/css-generator'
import {
  buildDesignGrid,
  designRowInfo,
  patchCellText,
  rowRoleLabel,
} from '@/core/layout-engine/table-cells'
import { collectOverlayItems, overlayItemStyle, type OverlayItem } from '@/design/canvas/overlay-logic'
import type { AnyControl, TableControl, ZoneControl } from '@/types/control'
import { getCanvasHost, useDesignerStore } from '../stores/designer'
import CellToolbar from './CellToolbar'
import './overlay-layers.css'

/* ------------------------------ 纯辅助 ------------------------------ */

/** 从模型里找表格控件（overlay 写回的目标） */
function findTable(
  controls: AnyControl[],
  zones: ZoneControl[],
  id: string,
): TableControl | undefined {
  const flat: AnyControl[] = [...controls, ...zones.flatMap((z) => z.children)]
  const hit = flat.find((c) => c.id === id)
  return hit?.type === 'table' ? (hit as TableControl) : undefined
}

/** 当前编辑控件（命令式回调里用，取 store 快照） */
function currentTable(): TableControl | undefined {
  const { editingCell, controls, zones } = useDesignerStore.getState()
  return editingCell ? findTable(controls, zones, editingCell.controlId) : undefined
}

function wrapperOf(layer: HTMLElement | null, id: string): HTMLElement | null {
  return layer?.querySelector<HTMLElement>(`[data-table-id="${CSS.escape(id)}"]`) ?? null
}

function tdOf(layer: HTMLElement | null, id: string, row: number, col: number): HTMLElement | null {
  return (
    wrapperOf(layer, id)?.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`) ??
    null
  )
}

/** 全选某元素内容（进入编辑时默认选中整格，便于直接覆盖输入） */
function selectAll(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/**
 * 编辑态 HTML：把 contenteditable 直接写进标记。
 *
 * 为什么不像 Vue 版那样命令式 `setAttribute`：React 用 dangerouslySetInnerHTML
 * 接管这段子树，任何一次「冻结 HTML 变化」的提交都会重建子节点，把手动加的属性冲掉。
 * 写进字符串则是声明式的 —— 只要不换冻结 HTML，contenteditable 就一直在，
 * 用户输入也不会被 diff 抹掉（编辑期间 frozenHtml 刻意保持不变）。
 */
function editableHtml(control: TableControl): string {
  return renderTableGridHtml(control).replace(
    /<td /g,
    '<td contenteditable="true" spellcheck="false" ',
  )
}

/** 聚焦并全选目标单元格 */
function focusCell(layer: HTMLElement | null): void {
  const e = useDesignerStore.getState().editingCell
  if (!e) return
  const td = tdOf(layer, e.controlId, e.row, e.col)
  if (!td) return
  td.focus({ preventScroll: true })
  selectAll(td)
}

/** 量出工具栏与行名标签的层内坐标 */
function measureAnchors(
  layer: HTMLElement | null,
  setToolbar: (p: { x: number; y: number } | null) => void,
  setLabel: (p: { x: number; y: number } | null) => void,
): void {
  const e = useDesignerStore.getState().editingCell
  if (!e || !layer) {
    setToolbar(null)
    return
  }
  const td = tdOf(layer, e.controlId, e.row, e.col)
  if (!td) {
    setToolbar(null)
    return
  }
  const b = layer.getBoundingClientRect()
  const a = td.getBoundingClientRect()
  setToolbar({ x: a.left - b.left, y: a.top - b.top })
  const firstTd = tdOf(layer, e.controlId, e.row, 0)
  setLabel(
    firstTd
      ? { x: firstTd.getBoundingClientRect().left - b.left, y: firstTd.getBoundingClientRect().top - b.top }
      : null,
  )
}

/** Tab / Enter 的下一个目标单元格（跨行回绕，越界返回 null） */
function nextCell(
  control: TableControl,
  row: number,
  col: number,
  dir: 1 | -1,
): { row: number; col: number } | null {
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

/**
 * antd 的浮层（下拉 / 取色器 / 弹层）会被 teleport 到 body，不在 overlay 内。
 * 点击它们时若走「点外面就关闭」逻辑，会在选项真正生效前销毁工具条，
 * 导致下拉交互（如单元格斜线、颜色）"点了没反应"。故对这类浮层豁免。
 * （对应 Vue 版的 NAIVE_TELEPORT_SELECTOR）
 */
const ANTD_TELEPORT_SELECTOR = [
  '.ant-select-dropdown',
  '.ant-color-picker',
  '.ant-popover',
  '.ant-dropdown',
  '.ant-picker-dropdown',
  '.ant-slider',
  '.ant-tooltip',
  '.ant-modal',
  '.ant-drawer',
  '.ant-message',
  '.ant-notification',
].join(', ')

function isTeleportTarget(target: Node | null): boolean {
  if (!target) return false
  if (!(target instanceof Element)) {
    const parent = target.parentElement
    return parent ? isTeleportTarget(parent) : false
  }
  return Boolean(target.closest(ANTD_TELEPORT_SELECTOR))
}

const TABLE_CSS_ID = 'op-table-overlay-css'

/* ------------------------------ 组件 ------------------------------ */

export default function TableViewLayer() {
  const canvasTick = useDesignerStore((s) => s.canvasTick)
  const controls = useDesignerStore((s) => s.controls)
  const zones = useDesignerStore((s) => s.zones)
  const editingCell = useDesignerStore((s) => s.editingCell)

  const layerRef = useRef<HTMLDivElement | null>(null)
  /** 编辑中表格的冻结 HTML：编辑期间不随 store 重渲染，保护光标 */
  const [frozenHtml, setFrozenHtml] = useState('')
  /** 会话序号：让「DOM 提交后开启编辑」的 effect 每次进入编辑都重跑 */
  const [session, setSession] = useState(0)
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null)
  const [rowLabelPos, setRowLabelPos] = useState<{ x: number; y: number } | null>(null)

  const editingId = editingCell?.controlId ?? null
  const editingControl = useMemo(
    () => (editingId ? findTable(controls, zones, editingId) : undefined),
    [controls, zones, editingId],
  )
  /** 编辑行的角色名（标题行 / 数据行 / 本页合计行 / 总计行 / 大写金额行） */
  const editingRowLabel = useMemo(() => {
    if (!editingControl || !editingCell) return ''
    return rowRoleLabel(buildDesignGrid(editingControl), editingCell.row)
  }, [editingControl, editingCell])
  /** 当前编辑格的行语义（表头 / 数据样例 / 静态），工具栏据此调整可用项 */
  const editingRowKind = useMemo(() => {
    if (!editingControl || !editingCell) return null
    return designRowInfo(buildDesignGrid(editingControl), editingCell.row)
  }, [editingControl, editingCell])

  /* ---------- 样式注入：与打印产物共用同一份 tableCss（仅作用域不同） ---------- */
  useEffect(() => {
    if (document.getElementById(TABLE_CSS_ID)) return
    const el = document.createElement('style')
    el.id = TABLE_CSS_ID
    el.textContent = tableCss('.op-table-overlay')
    document.head.appendChild(el)
  }, [])

  /* ---------- 覆盖项 ---------- */
  const items = useMemo<OverlayItem[]>(() => {
    void canvasTick
    return collectOverlayItems<PrintTable>({
      canvas: getCanvasHost()?.canvas ?? null,
      store: { controls, zones },
      isTarget: (o): o is PrintTable => o instanceof PrintTable,
      type: 'table',
      render: (c) => renderTableGridHtml(c as TableControl),
      htmlOverride: (id) =>
        id === editingId && frozenHtml ? frozenHtml : undefined,
    })
  }, [canvasTick, controls, zones, editingId, frozenHtml])

  /* ---------- 编辑会话：进入时冻结 HTML ---------- */
  useEffect(() => {
    if (!editingId) {
      setFrozenHtml('')
      setToolbarPos(null)
      setRowLabelPos(null)
      return
    }
    const control = currentTable()
    setFrozenHtml(control ? editableHtml(control) : '')
    // 标记一次新会话 → 下面那个 effect 等在渲染提交后再定位/聚焦
    setSession((n) => n + 1)
  }, [editingId])

  /* ---------- 冻结 HTML 已提交到 DOM → 开启编辑并聚焦 ---------- */
  useEffect(() => {
    if (!editingId) return
    const layer = layerRef.current
    focusCell(layer)
    measureAnchors(layer, setToolbarPos, setRowLabelPos)
    // 依赖 session 而非 editingId：确保跑在「冻结 HTML 渲染提交之后」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  /* ---------- 编辑目标格子变化（Tab / 点击别格）→ 移动工具栏 ---------- */
  const row = editingCell?.row
  const col = editingCell?.col
  useEffect(() => {
    measureAnchors(layerRef.current, setToolbarPos, setRowLabelPos)
  }, [row, col, canvasTick])

  /* ---------- 点击 overlay 之外 → 退出编辑（浮层豁免） ---------- */
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!useDesignerStore.getState().editingCell) return
      const target = e.target as Node | null
      if (target && layerRef.current?.contains(target)) return
      if (isTeleportTarget(target)) return
      exitEditing()
    }
    document.addEventListener('mousedown', onDocMouseDown, true)
    return () => document.removeEventListener('mousedown', onDocMouseDown, true)
  }, [])

  /* ------------------------------ 内容写回 ------------------------------ */

  /** 把某个 td 的文本提交到模型（未变化则不入撤销栈） */
  function commitTd(td: HTMLElement): void {
    const id = td.closest<HTMLElement>('[data-table-id]')?.dataset.tableId
    if (!id) return
    const control = currentTable()
    if (!control) return
    const r = Number(td.dataset.row)
    const c = Number(td.dataset.col)
    if (!Number.isFinite(r) || !Number.isFinite(c)) return
    const next = patchCellText(control, r, c, td.innerText)
    if (next === control) return
    useDesignerStore.getState().updateControl(id, next as Partial<AnyControl>)
    // 同步冻结 HTML：内容已变，编辑态下继续用冻结副本会导致失焦后回显旧值
    refreshFrozen(id)
  }

  /** 用当前模型重放冻结 HTML（可选重新聚焦，工具条触发时不夺焦） */
  function refreshFrozen(id: string, refocus = false): void {
    const control = findTable(
      useDesignerStore.getState().controls,
      useDesignerStore.getState().zones,
      id,
    )
    if (!control) return
    setFrozenHtml(editableHtml(control))
    if (refocus) {
      window.requestAnimationFrame(() => focusCell(layerRef.current))
    }
  }

  function exitEditing(): void {
    const e = useDesignerStore.getState().editingCell
    if (e) {
      const td = tdOf(layerRef.current, e.controlId, e.row, e.col)
      if (td) commitTd(td)
    }
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    useDesignerStore.getState().closeCellEditor()
  }

  /**
   * CellToolbar 动作写回：更新模型 + 用新模型重放冻结 HTML。
   *
   * 刻意**不重新聚焦**（`refreshFrozen` 默认 `refocus=false`）—— 否则工具条上的
   * 输入框（字号 / 合并列数 / 表达式）会因单元格抢焦而丢失光标。
   * 与 Vue 版 `onToolbarApply` 语义一致（工具条不夺焦）。
   */
  function onToolbarApply(next: TableControl): void {
    const id = useDesignerStore.getState().editingCell?.controlId
    if (!id) return
    useDesignerStore.getState().updateControl(id, next as Partial<AnyControl>)
    refreshFrozen(id)
  }

  function moveTo(id: string, r: number, c: number): void {
    useDesignerStore.getState().openCellEditor(id, r, c)
    window.requestAnimationFrame(() => {
      const td = tdOf(layerRef.current, id, r, c)
      if (td) {
        td.focus({ preventScroll: true })
        selectAll(td)
      }
      measureAnchors(layerRef.current, setToolbarPos, setRowLabelPos)
    })
  }

  /* ------------------------------ 事件 ------------------------------ */

  function onFocusIn(e: ReactFocusEvent<HTMLDivElement>): void {
    const td = (e.target as HTMLElement | null)?.closest<HTMLElement>('td[data-row]')
    const id = td?.closest<HTMLElement>('[data-table-id]')?.dataset.tableId
    if (!td || !id) return
    const s = useDesignerStore.getState()
    s.openCellEditor(id, Number(td.dataset.row), Number(td.dataset.col))
    window.requestAnimationFrame(() =>
      measureAnchors(layerRef.current, setToolbarPos, setRowLabelPos),
    )
  }

  function onFocusOut(e: ReactFocusEvent<HTMLDivElement>): void {
    const td = (e.target as HTMLElement | null)?.closest<HTMLElement>('td[data-row]')
    if (td) commitTd(td)
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
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
      const control = findTable(
        useDesignerStore.getState().controls,
        useDesignerStore.getState().zones,
        id,
      )
      if (!control) return
      const to = nextCell(control, Number(td.dataset.row), Number(td.dataset.col), e.shiftKey ? -1 : 1)
      if (to) moveTo(id, to.row, to.col)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Excel 习惯：回车提交并下移一行；末行则结束编辑
      e.preventDefault()
      commitTd(td)
      const control = findTable(
        useDesignerStore.getState().controls,
        useDesignerStore.getState().zones,
        id,
      )
      if (!control) return
      const grid = buildDesignGrid(control)
      const r = Number(td.dataset.row) + 1
      if (r < grid.rowCount) moveTo(id, r, Number(td.dataset.col))
      else exitEditing()
    }
  }

  /** 粘贴：一律纯文本；含制表符/换行时按 Excel 语义铺到多个单元格 */
  function onPaste(e: ReactClipboardEvent<HTMLDivElement>): void {
    const td = (e.target as HTMLElement | null)?.closest<HTMLElement>('td[data-row]')
    const id = td?.closest<HTMLElement>('[data-table-id]')?.dataset.tableId
    if (!td || !id) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    e.preventDefault()
    if (!text) return

    const matrix = text
      .replace(/\r\n?/g, '\n')
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.split('\t'))
    if (matrix.length === 1 && matrix[0]!.length === 1) {
      document.execCommand('insertText', false, matrix[0]![0]!)
      return
    }

    const s = useDesignerStore.getState()
    const control = findTable(s.controls, s.zones, id)
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
      s.updateControl(id, next as Partial<AnyControl>)
      refreshFrozen(id)
    }
  }

  return (
    <div
      ref={layerRef}
      className="op-table-overlay"
      data-testid="table-overlay"
      onFocus={onFocusIn}
      onBlur={onFocusOut}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    >
      {items.map((it) => (
        <div
          key={it.id}
          className={`op-table-overlay__item${it.id === editingId ? ' is-editing' : ''}`}
          data-table-id={it.id}
          style={overlayItemStyle(it)}
          // 表格 HTML 由 renderTableGridHtml 生成（可信内容，与 Vue 端 v-html 同源）
          dangerouslySetInnerHTML={{ __html: it.html }}
        />
      ))}

      {editingControl && editingCell && rowLabelPos && (
        <div className="op-row-label" style={{ left: rowLabelPos.x, top: rowLabelPos.y }}>
          {editingRowLabel}
        </div>
      )}

      {editingControl && editingCell && toolbarPos && (
        <CellToolbar
          control={editingControl}
          row={editingCell.row}
          col={editingCell.col}
          rowKind={editingRowKind?.kind ?? 'static'}
          x={toolbarPos.x}
          y={toolbarPos.y}
          onApply={onToolbarApply}
          onClose={exitEditing}
        />
      )}
    </div>
  )
}
