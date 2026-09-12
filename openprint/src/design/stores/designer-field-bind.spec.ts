/**
 * P5.1c —— 字段树拖拽落绑定（Vue store）
 *
 * 落点决定路径口径：表格列保持 `items[].字段名`，表格外的单值控件自动改写为
 * `items[0].字段名`（取首条记录）；落到空白则新建绑定该字段的文本控件。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TableControl, TextControl } from '@/types/control'
import { useDesignerStore } from './designer'

function last<T>(arr: T[]): T {
  return arr[arr.length - 1]!
}

describe('P5.1c · 字段拖拽落绑定（Vue store）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('拖到单值控件 → 自动改写为 items[0].（取首条记录）', () => {
    const store = useDesignerStore()
    store.addControlOfType('text', { leftMm: 10, topMm: 10 })
    const id = last(store.controls).id
    store.bindField({ path: 'items[].phone', controlId: id })
    const c = store.controls.find((x) => x.id === id) as TextControl
    expect(c.contentType).toBe('variable')
    expect(c.binding).toBe('items[0].phone')
    expect(store.selectedIds).toEqual([id])
  })

  it('拖到表格列 → 保持 items[]. 明细前缀（逐行取值）', () => {
    const store = useDesignerStore()
    store.addControlOfType('table', { leftMm: 10, topMm: 10 })
    const t = last(store.controls) as TableControl
    store.bindField({ path: 'items[].amount', controlId: t.id, columnIndex: 1 })
    const after = store.controls.find((x) => x.id === t.id) as TableControl
    expect(after.columns[1]!.field).toBe('items[].amount')
  })

  it('落到空白 → 新建绑定该字段的文本控件', () => {
    const store = useDesignerStore()
    const before = store.controls.length
    store.bindField({ path: 'items[].phone', at: { leftMm: 20, topMm: 30 } })
    expect(store.controls.length).toBe(before + 1)
    const c = last(store.controls) as TextControl
    expect(c.type).toBe('text')
    expect(c.binding).toBe('items[0].phone')
    expect(c.left).toBe(20)
    expect(c.top).toBe(30)
  })

  it('命中不可绑定控件（形状）→ 无副作用', () => {
    const store = useDesignerStore()
    store.addControlOfType('rect', { leftMm: 0, topMm: 0 })
    const r = last(store.controls)
    const snapshot = JSON.stringify(store.controls)
    store.bindField({ path: 'items[].x', controlId: r.id })
    expect(JSON.stringify(store.controls)).toBe(snapshot)
  })
})
