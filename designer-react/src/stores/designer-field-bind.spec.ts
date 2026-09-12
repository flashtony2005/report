/**
 * P5.1c —— 字段树拖拽落绑定（React store）
 *
 * 与 Vue 版同契约：表格列保持 `items[].字段名`，表格外的单值控件自动改写为
 * `items[0].字段名`（取首条记录）；落到空白则新建绑定该字段的文本控件。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { TableControl, TextControl } from '@/types/control'
import { resetDesignerStores, useDesignerStore } from './designer'

function controls(): ReturnType<typeof useDesignerStore.getState>['controls'] {
  return useDesignerStore.getState().controls
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1]!
}

describe('P5.1c · 字段拖拽落绑定（React store）', () => {
  beforeEach(() => {
    resetDesignerStores()
  })

  it('拖到单值控件 → 自动改写为 items[0].（取首条记录）', () => {
    const s = useDesignerStore.getState()
    s.addControlOfType('text', { leftMm: 10, topMm: 10 })
    const id = last(controls()).id
    useDesignerStore.getState().bindField({ path: 'items[].phone', controlId: id })
    const c = controls().find((x) => x.id === id) as TextControl
    expect(c.contentType).toBe('variable')
    expect(c.binding).toBe('items[0].phone')
    expect(useDesignerStore.getState().selectedIds).toEqual([id])
  })

  it('拖到表格列 → 保持 items[]. 明细前缀（逐行取值）', () => {
    useDesignerStore.getState().addControlOfType('table', { leftMm: 10, topMm: 10 })
    const t = last(controls()) as TableControl
    useDesignerStore.getState().bindField({
      path: 'items[].amount',
      controlId: t.id,
      columnIndex: 1,
    })
    const after = controls().find((x) => x.id === t.id) as TableControl
    expect(after.columns[1]!.field).toBe('items[].amount')
  })

  it('落到空白 → 新建绑定该字段的文本控件', () => {
    const before = controls().length
    useDesignerStore.getState().bindField({ path: 'items[].phone', at: { leftMm: 20, topMm: 30 } })
    const list = controls()
    expect(list.length).toBe(before + 1)
    const c = last(list) as TextControl
    expect(c.type).toBe('text')
    expect(c.binding).toBe('items[0].phone')
    expect(c.left).toBe(20)
    expect(c.top).toBe(30)
  })

  it('命中不可绑定控件（形状）→ 无副作用', () => {
    useDesignerStore.getState().addControlOfType('rect', { leftMm: 0, topMm: 0 })
    const r = last(controls())
    const snapshot = JSON.stringify(controls())
    useDesignerStore.getState().bindField({ path: 'items[].x', controlId: r.id })
    expect(JSON.stringify(controls())).toBe(snapshot)
  })
})
