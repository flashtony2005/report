/**
 * field-drag —— 字段树拖拽绑定的纯函数单测
 *
 * 覆盖「落点决定路径口径」这一核心契约：
 * - 表格列 → 保持 `items[].字段名`（逐行取值）
 * - 表格外的单值控件 → 改写为 `items[0].字段名`（取首条记录）
 */
import { describe, expect, it } from 'vitest'
import type { AnyControl, TableControl } from '@/types/control'
import {
  hitFieldDropTarget,
  hitTableColumn,
  isArrayPath,
  singleValueBindingPatch,
  tableColumnBindingPatch,
  toSingleValuePath,
} from './field-drag'

function text(id: string, left: number, top: number, w = 40, h = 8): AnyControl {
  return { id, type: 'text', left, top, width: w, height: h } as AnyControl
}

function table(id: string, left: number, top: number, widths: number[]): TableControl {
  return {
    id,
    type: 'table',
    left,
    top,
    width: widths.reduce((a, b) => a + b, 0),
    height: 30,
    columns: widths.map((w, i) => ({ title: `c${i}`, field: `items[].f${i}`, width: w })),
  } as TableControl
}

describe('field-drag · 路径改写', () => {
  it('明细数组路径 → 单值路径（取首条记录）', () => {
    expect(toSingleValuePath('items[].phone')).toBe('items[0].phone')
    expect(toSingleValuePath('items[].a.items[].b')).toBe('items[0].a.items[0].b')
  })

  it('非明细 / 已带下标的路径原样返回', () => {
    expect(toSingleValuePath('customer.name')).toBe('customer.name')
    expect(toSingleValuePath('items[0].phone')).toBe('items[0].phone')
  })

  it('isArrayPath 只认 []. 形式', () => {
    expect(isArrayPath('items[].phone')).toBe(true)
    expect(isArrayPath('items[0].phone')).toBe(false)
    expect(isArrayPath('customer.name')).toBe(false)
  })
})

describe('field-drag · 落点命中', () => {
  it('命中最上层控件（数组末尾优先，与图层顺序一致）', () => {
    const list = [text('a', 0, 0, 50, 50), text('b', 10, 10, 50, 50)]
    expect(hitFieldDropTarget(list, 20, 20)?.control.id).toBe('b')
    // 只被 a 覆盖的区域（b 从 (10,10) 起）仍命中 a
    expect(hitFieldDropTarget(list, 5, 5)?.control.id).toBe('a')
  })

  it('落在所有控件之外 → null', () => {
    expect(hitFieldDropTarget([text('a', 0, 0, 10, 10)], 50, 50)).toBeNull()
  })

  it('命中表格 → 返回落点所在列索引', () => {
    const t = table('t', 10, 0, [30, 20, 40])
    expect(hitFieldDropTarget([t], 15, 5)?.columnIndex).toBe(0)
    expect(hitFieldDropTarget([t], 45, 5)?.columnIndex).toBe(1)
    expect(hitFieldDropTarget([t], 70, 5)?.columnIndex).toBe(2)
  })

  it('落点越过表格右缘 → 归最后一列；表格无列 → -1', () => {
    const t = table('t', 0, 0, [10, 10])
    expect(hitTableColumn(t, 999)).toBe(1)
    expect(hitTableColumn({ ...t, columns: [] } as TableControl, 5)).toBe(-1)
  })
})

describe('field-drag · 绑定补丁', () => {
  it('文本 / 条码 / 二维码 → contentType=variable + 单值路径', () => {
    for (const type of ['text', 'barcode', 'qrcode'] as const) {
      const patch = singleValueBindingPatch(
        { id: 'x', type, left: 0, top: 0, width: 1, height: 1 } as AnyControl,
        'items[].phone',
      )
      expect(patch).toMatchObject({ contentType: 'variable', binding: 'items[0].phone' })
      // 清掉旧三态值，避免 expression/value 抢占优先级
      expect(patch?.value).toBeUndefined()
      expect(patch?.expression).toBeUndefined()
    }
  })

  it('图片 → value.mode=binding', () => {
    const patch = singleValueBindingPatch(
      { id: 'i', type: 'image', left: 0, top: 0, width: 1, height: 1 } as AnyControl,
      'items[].pic',
    )
    expect(patch).toEqual({ value: { mode: 'binding', content: 'items[0].pic' } })
  })

  it('形状等不可绑定控件 → null（不产生空操作）', () => {
    expect(
      singleValueBindingPatch(
        { id: 'r', type: 'rect', left: 0, top: 0, width: 1, height: 1 } as AnyControl,
        'items[].x',
      ),
    ).toBeNull()
  })

  it('表格列补丁：写入 field 保持 items[] 前缀，并清掉列 expression', () => {
    const t = table('t', 0, 0, [10, 10])
    const patch = tableColumnBindingPatch(t, 1, 'items[].amount')
    expect(patch?.columns[1]).toEqual({
      title: 'c1',
      field: 'items[].amount',
      width: 10,
      expression: undefined,
    })
    // 未命中的列原样保留（同一引用）
    expect(patch?.columns[0]).toBe(t.columns[0])
  })

  it('列索引非法 → null', () => {
    const t = table('t', 0, 0, [10])
    expect(tableColumnBindingPatch(t, -1, 'items[].x')).toBeNull()
    expect(tableColumnBindingPatch(t, 5, 'items[].x')).toBeNull()
  })
})
