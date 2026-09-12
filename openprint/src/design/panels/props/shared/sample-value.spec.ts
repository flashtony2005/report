/**
 * sample-value.spec —— 字段示例值提取的共享逻辑（Vue / React 两端同源）
 * 这些逻辑原先内联在 VariableModal.vue 的 script 里，React 重写必然漂移，先抽出来。
 */
import { describe, expect, it } from 'vitest'
import {
  formatSampleValue,
  resolveSamplePath,
  sampleOfField,
  typeMeta,
  TYPE_META,
} from './sample-value'
import type { FieldDef } from '@/types/datasource'

const mkField = (p: Partial<FieldDef> & { path: string }): FieldDef =>
  ({ label: p.path, type: 'string', ...p }) as FieldDef

describe('resolveSamplePath', () => {
  const data = { order: { orderNo: 'SO-001', items: [{ qty: 3 }, { qty: 5 }] }, flag: false }

  it('普通路径逐级解析', () => {
    expect(resolveSamplePath(data, 'order.orderNo')).toBe('SO-001')
  })

  it('数组标记 items[].qty → 取首行的叶子值（数组语义在 sampleOfField，路径解析不管标记）', () => {
    const d = { items: [{ qty: 3 }, { qty: 5 }] }
    // resolveSamplePath 把 'items[].qty' 当字面键解析 → undefined；[] 语义由 sampleOfField 处理
    expect(resolveSamplePath(d, 'items.qty')).toBeUndefined()
    expect(sampleOfField(mkField({ path: 'items[].qty' }), d)).toBe('3')
    expect(sampleOfField(mkField({ path: 'items[]' }), d)).toBe('数组（2 项）')
  })

  it('路径中断（非对象处继续取）→ undefined', () => {
    expect(resolveSamplePath(data, 'order.orderNo.xxx')).toBeUndefined()
    expect(resolveSamplePath(data, 'missing.deep')).toBeUndefined()
  })
})

describe('formatSampleValue', () => {
  it('空值 →（无示例值）', () => {
    expect(formatSampleValue(null)).toBe('（无示例值）')
    expect(formatSampleValue(undefined)).toBe('（无示例值）')
    expect(formatSampleValue('')).toBe('（无示例值）')
  })
  it('数组 → 项数；对象 → 对象；布尔 → true/false', () => {
    expect(formatSampleValue([1, 2, 3])).toBe('数组（3 项）')
    expect(formatSampleValue({ a: 1 })).toBe('对象')
    expect(formatSampleValue(true)).toBe('true')
    expect(formatSampleValue(false)).toBe('false')
  })
  it('其余 → String', () => {
    expect(formatSampleValue(42)).toBe('42')
  })
})

describe('sampleOfField', () => {
  it('普通字段优先取 previewData 真实值，缺失回退 FieldDef.sample', () => {
    const f = mkField({ path: 'order.orderNo', sample: 'FALLBACK' })
    expect(sampleOfField(f, { order: { orderNo: 'SO-001' } })).toBe('SO-001')
    expect(sampleOfField(f, {})).toBe('FALLBACK')
  })

  it('数组字段：首行叶子 > 整组数组 > FieldDef.sample', () => {
    const f = mkField({ path: 'items[].qty', sample: 'FALLBACK' })
    expect(sampleOfField(f, { items: [{ qty: 3 }] })).toBe('3')
    expect(sampleOfField(f, { items: [] })).toBe('FALLBACK')
    const whole = mkField({ path: 'items[]', sample: 'FALLBACK' })
    expect(sampleOfField(whole, { items: [{ qty: 3 }] })).toBe('数组（1 项）')
  })
})

describe('typeMeta', () => {
  it('已知类型有专属配色，未知类型回退灰色并显示原始类型名', () => {
    expect(TYPE_META.string?.label).toBe('文本')
    expect(typeMeta(mkField({ path: 'a', type: 'string' })).color).toBe('#1677ff')
    const unknown = typeMeta(mkField({ path: 'a', type: 'jsonb' as never }))
    expect(unknown.label).toBe('jsonb')
    expect(unknown.color).toBe('#8c8c8c')
  })
})
