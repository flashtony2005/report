/**
 * CellToolbar —— React 端单元格浮动工具栏契约
 *
 * 钉住从 Vue 版迁移过来的行为（P7 收尾）：
 * 1. 渲染：行角色标签 + 字体/字号/字形/对齐/合并等控件齐全
 * 2. 动作：点击后 onApply 拿到「新的表格控件」（本组件不直接改 store）
 * 3. 可用性收敛：数据行禁用「纵向合并」与「删除本行」；单列禁用「删除本列」
 * 4. 条件行：数据格式行仅在绑定字段/表达式时出现
 *
 * 与 Vue 版逐条对齐的语义（防两端漂移）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import type { ReactElement } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { createRoot, type Root } from 'react-dom/client'
import CellToolbar, { type CellToolbarProps } from './CellToolbar'
import { buildDesignGrid } from '@/core/layout-engine/table-cells'
import type { TableControl } from '@/types/control'

/* ------------------------------ 辅助 ------------------------------ */

/** 布局网格（非数据表）：headerRows + designRows 行，全部 header/static */
function layoutControl(over: Partial<TableControl> = {}): TableControl {
  return {
    id: 't1',
    type: 'table',
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    columns: [
      { key: 'c1', title: '品名' },
      { key: 'c2', title: '数量' },
    ],
    headerRows: 1,
    designRows: 2,
    ...over,
  } as unknown as TableControl
}

/** 数据表：第 0 行表头，第 1 行数据样例行 */
function dataControl(over: Partial<TableControl> = {}): TableControl {
  return {
    id: 't2',
    type: 'table',
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    columns: [
      { key: 'c1', title: '品名', field: 'items[].name' },
      { key: 'c2', title: '数量', field: 'items[].qty' },
    ],
    dataSource: 'items',
    headerRows: 1,
    staticRows: 0,
    ...over,
  } as unknown as TableControl
}

function click(el: Element | null): void {
  if (!el) throw new Error('click: 目标元素不存在')
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** 按（去掉空白的）可见文本找按钮 —— antd 会对两字中文插空格，故先 strip */
function buttonByText(host: HTMLElement, text: string): HTMLElement | null {
  return (
    Array.from(host.querySelectorAll<HTMLElement>('button')).find(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
    ) ?? null
  )
}

/** happy-dom 下给受控 input 赋值必须走原生 setter，否则 React 的 value tracker 会吞掉 change */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
}

function spin(el: HTMLElement | null): HTMLInputElement {
  // antd InputNumber 把 rest props 直接透到内部 <input> 上，故 data-testid 命中的可能就是 input 本体
  if (el instanceof HTMLInputElement) return el
  const input = el?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error(`找不到 InputNumber 内部 input（宿主 ${el ? el.outerHTML.slice(0, 120) : 'null'}）`)
  return input
}

/* ------------------------------ 用例 ------------------------------ */

describe('CellToolbar', () => {
  let roots: Array<[Root, HTMLElement]> = []
  let applied: TableControl[] = []
  const onApply = (n: TableControl): void => {
    applied.push(n)
  }
  const onClose = vi.fn()

  async function renderToolbar(control: TableControl, props: Partial<CellToolbarProps> = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const el = createElement(CellToolbar, {
      control,
      row: 0,
      col: 0,
      rowKind: 'header',
      x: 0,
      y: 0,
      onApply,
      onClose,
      ...props,
    }) as ReactElement
    await act(async () => {
      root.render(el)
    })
    roots.push([root, host])
    return host
  }

  beforeEach(() => {
    applied = []
    roots = []
  })

  afterEach(async () => {
    for (const [root, host] of roots) {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
    roots = []
  })

  it('渲染：显示行角色标签，并产出字体 / 字号 / 合并等关键控件', async () => {
    const host = await renderToolbar(layoutControl())
    expect(host.querySelector('[data-testid="cell-toolbar"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="cell-role"]')?.textContent).toBe('标题行')
    expect(host.querySelector('[data-testid="cell-font"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="cell-span"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="cell-rowspan"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="cell-diagonal"]')).toBeTruthy()
  })

  it('加粗按钮：点击后 onApply 收到 style.bold=true 的新控件（本组件不改 store）', async () => {
    // 静态行初始无样式（表头行默认就是加粗的，见下一条用例）
    const host = await renderToolbar(layoutControl(), { row: 1, rowKind: 'static' })
    click(buttonByText(host, 'B'))
    expect(applied.length).toBe(1)
    const next = applied[0]!
    expect(buildDesignGrid(next).cells[1]![0]!.style?.bold).toBe(true)
    // 入参控件不可被就地改动
    expect(buildDesignGrid(layoutControl()).cells[1]![0]!.style?.bold).toBeFalsy()
  })

  it('加粗按钮是切换语义：表头格默认加粗，点一下变为取消加粗', async () => {
    const host = await renderToolbar(layoutControl(), { row: 0, rowKind: 'header' })
    expect(buildDesignGrid(layoutControl()).cells[0]![0]!.style?.bold).toBe(true)
    click(buttonByText(host, 'B'))
    expect(applied.length).toBe(1)
    expect(buildDesignGrid(applied[0]!).cells[0]![0]!.style?.bold).toBe(false)
  })

  it('水平对齐：点击「居中」写入 align=center', async () => {
    const host = await renderToolbar(layoutControl())
    click(buttonByText(host, '↔'))
    expect(applied.length).toBe(1)
    expect(buildDesignGrid(applied[0]!).cells[0]![0]!.style?.align).toBe('center')
  })

  it('横向合并：改合并列数 → 调用 setCellSpan', async () => {
    const host = await renderToolbar(layoutControl())
    await act(async () => {
      setInputValue(spin(host.querySelector('[data-testid="cell-span"]')), '2')
    })
    expect(applied.length).toBeGreaterThan(0)
    expect(buildDesignGrid(applied.at(-1)!).cells[0]![0]!.colSpan).toBe(2)
  })

  it('插入行：上方插入行 → 行数 +1', async () => {
    const host = await renderToolbar(layoutControl())
    const before = buildDesignGrid(layoutControl()).rowCount
    click(host.querySelector('[data-testid="cell-insert-row-above"]'))
    expect(applied.length).toBe(1)
    expect(buildDesignGrid(applied[0]!).rowCount).toBe(before + 1)
  })

  it('删除列：单列时按钮禁用', async () => {
    const oneCol = layoutControl({
      columns: [{ key: 'c1', title: '品名' }],
    } as unknown as Partial<TableControl>)
    const host = await renderToolbar(oneCol)
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="cell-del-col"]')!
    expect(btn.disabled).toBe(true)
  })

  it('数据行：角色名显示「数据行（影响整列）」，禁用纵向合并与删除本行', async () => {
    const host = await renderToolbar(dataControl(), { row: 1, rowKind: 'data' })
    expect(host.querySelector('[data-testid="cell-role"]')?.textContent).toBe('数据行（影响整列）')
    // 纵向合并在数据行禁用（跨行会跨越不同记录，语义不成立）
    expect(spin(host.querySelector('[data-testid="cell-rowspan"]')).disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="cell-del-row"]')!.disabled).toBe(
      true,
    )
  })

  it('表头行：纵向合并可用（仅数据行禁用）', async () => {
    const host = await renderToolbar(dataControl(), { row: 0, rowKind: 'header' })
    expect(spin(host.querySelector('[data-testid="cell-rowspan"]')).disabled).toBe(false)
  })

  it('数据格式行：绑定字段的单元格才出现，纯静态文字不出现', async () => {
    // 表头（无 field）→ 不出现
    const headerHost = await renderToolbar(layoutControl())
    expect(headerHost.querySelector('[data-testid="cell-format-kind"]')).toBeNull()

    // 数据行 + 列已绑字段 → 出现
    const dataHost = await renderToolbar(dataControl(), { row: 1, rowKind: 'data' })
    expect(dataHost.querySelector('[data-testid="cell-format-kind"]')).toBeTruthy()
  })

  it('弹层浮窗豁免：浮层内 mousedown / dblclick 不冒泡（否则会被画布「点外面就退出」吞掉）', async () => {
    const host = await renderToolbar(layoutControl())
    const bar = host.querySelector('[data-testid="cell-toolbar"]')!
    // 监听点放在 React 根容器（host）**之外**：React 合成事件挂在 host 上，
    // 组件内的 stopPropagation 会让事件止步于 host，body 侧监听器收不到才算通过。
    let bubbled = 0
    const onBodyDown = (): void => {
      bubbled++
    }
    document.body.addEventListener('mousedown', onBodyDown)
    try {
      bar.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    } finally {
      document.body.removeEventListener('mousedown', onBodyDown)
    }
    expect(bubbled).toBe(0)
  })

  it('关闭按钮 → 触发 onClose', async () => {
    const host = await renderToolbar(layoutControl())
    click(host.querySelector('[data-testid="cell-close"]'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
