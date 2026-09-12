/**
 * TableViewLayer —— React 端表格覆盖层的渲染与编辑会话契约
 *
 * 几何/内容选择规则由共享 overlay-logic.spec.ts 覆盖；本测试钉住 React 组件层：
 * 1. 能把 Fabric 上的 PrintTable 渲染成**真实 DOM 表格**（而不是降级位图）
 * 2. 未编辑时整层不吃指针（pointer-events 交给 CSS，结构上不能有 is-editing）
 * 3. 进入编辑：仅该表标记 is-editing + 出现行角色标签
 * 4. tableCss 只注入一次（幂等），且是限定在 .op-table-overlay 作用域内
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { createRoot, type Root } from 'react-dom/client'
import TableViewLayer from './TableViewLayer'
import { PrintTable } from '@/design/canvas/controls/PrintTable'
import { attachCanvasHost, detachCanvasHost, resetDesignerStores, useDesignerStore, type CanvasHost } from '../stores/designer'
import { stubCanvas2d } from './test-utils'
import type { TableControl } from '@/types/control'

function fakeHost(objects: unknown[]): CanvasHost {
  return {
    canvas: { viewportTransform: [1, 0, 0, 1, 0, 0], getObjects: () => objects },
  } as unknown as CanvasHost
}

function tableControl(id: string, over: Partial<TableControl> = {}): TableControl {
  return {
    id,
    type: 'table',
    left: 10,
    top: 20,
    width: 80,
    height: 30,
    columns: [
      { key: 'c1', title: '品名' },
      { key: 'c2', title: '数量' },
    ],
    ...over,
  } as unknown as TableControl
}

async function mount(el: ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(el)
  })
  return { host, root }
}

describe('TableViewLayer', () => {
  let roots: Array<[Root, HTMLElement]> = []

  beforeEach(() => {
    stubCanvas2d()
    resetDesignerStores()
    roots = []
  })

  afterEach(async () => {
    for (const [root, host] of roots) {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
    detachCanvasHost()
    resetDesignerStores()
  })

  it('未挂载画布 → 渲染空层，不抛错', async () => {
    const m = await mount(createElement(TableViewLayer))
    roots.push([m.root, m.host])
    expect(m.host.querySelector('[data-testid="table-overlay"]')).toBeTruthy()
    expect(m.host.querySelectorAll('[data-table-id]').length).toBe(0)
  })

  it('把 PrintTable 渲染成真实 DOM 表格（而非 Fabric 降级位图）', async () => {
    const obj = new PrintTable(tableControl('t1'))
    attachCanvasHost(fakeHost([obj]))

    const m = await mount(createElement(TableViewLayer))
    roots.push([m.root, m.host])

    const item = m.host.querySelector<HTMLElement>('[data-table-id="t1"]')
    expect(item).toBeTruthy()
    expect(item!.querySelector('table')).toBeTruthy()
    // 列标题应真的渲染进 DOM
    expect(item!.textContent).toContain('品名')
    expect(item!.textContent).toContain('数量')
    // 未进入编辑 → 不带 is-editing
    expect(item!.className).not.toContain('is-editing')
  })

  it('editingCell 置位 → 该项标记 is-editing（仅此表吃指针）并显示行角色标签', async () => {
    const obj = new PrintTable(tableControl('t1'))
    attachCanvasHost(fakeHost([obj]))
    // store 里也必须存在该表格控件：行角色标签等从 store 模型取真相（而非 Fabric 对象）
    useDesignerStore.setState({
      controls: [tableControl('t1')],
      editingCell: { controlId: 't1', row: 0, col: 0 },
    })

    const m = await mount(createElement(TableViewLayer))
    roots.push([m.root, m.host])

    const item = m.host.querySelector<HTMLElement>('[data-table-id="t1"]')!
    expect(item.className).toContain('is-editing')
    expect(m.host.querySelector('.op-row-label')).toBeTruthy()
    // 编辑态下格子必须可编辑（React 侧把 contenteditable 写进冻结 HTML，而非命令式 setAttribute）
    expect(item.querySelector('td')?.getAttribute('contenteditable')).toBe('true')
  })

  it('editingCell 指向不存在的表 → 不崩、无 is-editing', async () => {
    const obj = new PrintTable(tableControl('t1'))
    attachCanvasHost(fakeHost([obj]))
    useDesignerStore.setState({ editingCell: { controlId: 'ghost', row: 0, col: 0 } })

    const m = await mount(createElement(TableViewLayer))
    roots.push([m.root, m.host])

    const item = m.host.querySelector<HTMLElement>('[data-table-id="t1"]')!
    expect(item.className).not.toContain('is-editing')
  })

  it('tableCss 幂等注入，且限定在 .op-table-overlay 作用域内', async () => {
    const obj = new PrintTable(tableControl('t1'))
    attachCanvasHost(fakeHost([obj]))
    const m1 = await mount(createElement(TableViewLayer))
    const m2 = await mount(createElement(TableViewLayer))
    roots.push([m1.root, m1.host], [m2.root, m2.host])

    const styles = document.querySelectorAll('#op-table-overlay-css')
    expect(styles.length).toBe(1)
    expect(styles[0]!.textContent).toContain('.op-table-overlay')
  })
})
