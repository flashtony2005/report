/**
 * expression-logic 共享逻辑测试（P4.1，两端同源防线）。
 * 变异验证基准：改任何一行共享逻辑都必须在此抓到。
 */
import { describe, expect, it } from 'vitest'
import { interpolate } from '@/core/layout-engine/expression'
import {
  PRESET_COLORS,
  buildSampleCtx,
  evalExpressionPreview,
  filterCatalog,
  insertSnippetAtCursor,
  normalizePickedHex,
} from './expression-logic'

describe('normalizePickedHex', () => {
  it('6 位 hex 原样大写', () => {
    expect(normalizePickedHex('#d93636')).toBe('#D93636')
  })
  it('8 位 hex（带 alpha）截掉后两位', () => {
    expect(normalizePickedHex('#D93636FF')).toBe('#D93636')
  })
  it('空串原样返回', () => {
    expect(normalizePickedHex('')).toBe('')
  })
})

describe('filterCatalog', () => {
  it('空关键字返回全目录', () => {
    expect(filterCatalog('')).toHaveLength(7)
    expect(filterCatalog('  ')).toHaveLength(7)
  })
  it('按中文 label 过滤命中「求和」（aggregate + table-agg 两分类命中）', () => {
    const r = filterCatalog('求和')
    expect(r.map((c) => c.key)).toEqual(['aggregate', 'table-agg'])
    expect(r[0]!.items.map((i) => i.id)).toEqual(['sum'])
  })
  it('按 snippet 过滤命中 pageSum', () => {
    const r = filterCatalog('pageSum')
    expect(r.map((c) => c.key)).toEqual(['table-agg'])
    expect(r[0]!.items.every((i) => i.snippet.toLowerCase().includes('pagesum'))).toBe(true)
  })
  it('按 description 过滤命中「人民币大写」', () => {
    const r = filterCatalog('人民币大写')
    expect(r[0]!.items.map((i) => i.id)).toEqual(['page-cap', 'total-cap'])
  })
  it('无命中返回空数组', () => {
    expect(filterCatalog('zzzz不存在')).toEqual([])
  })
  it('首尾空白被 trim', () => {
    expect(filterCatalog(' 求和 ').map((c) => c.key)).toEqual(['aggregate', 'table-agg'])
  })
})

describe('buildSampleCtx', () => {
  it('items 数组取首行为 row', () => {
    const ctx = buildSampleCtx({ items: [{ amount: 5 }, { amount: 7 }] })
    expect(ctx.row).toEqual({ amount: 5 })
    expect(ctx.page).toBe(1)
    expect(ctx.pages).toBe(3)
  })
  it('无 items 时 row 为 undefined；null 数据不抛异常', () => {
    expect(buildSampleCtx({}).row).toBeUndefined()
    expect(buildSampleCtx(null).data).toEqual({})
  })
  it('构造的上下文可被引擎求值', () => {
    const ctx = buildSampleCtx({ items: [{ amount: 5 }], order: { total: 128 } })
    expect(interpolate('{{sum(\'items[].amount\')}}', ctx).text).toBe('5')
    expect(interpolate('{{order.total}}', ctx).text).toBe('128')
  })
})

describe('evalExpressionPreview', () => {
  const ctx = buildSampleCtx({ items: [{ amount: 5 }, { amount: 6 }], order: { total: 128 } })
  it('空串 / 空白返回空结果无错误', () => {
    expect(evalExpressionPreview('', ctx)).toEqual({ text: '', errors: [] })
    expect(evalExpressionPreview('   ', ctx)).toEqual({ text: '', errors: [] })
  })
  it('正常求值', () => {
    expect(evalExpressionPreview('{{sum(\'items[].amount\')}}', ctx)).toEqual({ text: '11', errors: [] })
  })
  it('引擎报告的错误进入 errors', () => {
    const r = evalExpressionPreview('{{notAFunction(1)}}', ctx)
    expect(r.errors.length).toBeGreaterThan(0)
  })
  it('求值抛异常归一为 errors（不向外抛）', () => {
    // ctx 为 null 时引擎内部访问属性必然抛 TypeError —— 验证 catch 分支兜底
    const r = evalExpressionPreview('{{x}}', undefined as unknown as ReturnType<typeof buildSampleCtx>)
    expect(r.text).toBe('')
    expect(r.errors.length).toBeGreaterThan(0)
    expect(typeof r.errors[0]).toBe('string')
  })
})

describe('insertSnippetAtCursor', () => {
  it('光标处插入（start === end）', () => {
    expect(insertSnippetAtCursor('ab', 'X', 1, 1)).toEqual({ next: 'aXb', caret: 2 })
  })
  it('选区替换（start < end）', () => {
    expect(insertSnippetAtCursor('abcd', 'X', 1, 3)).toEqual({ next: 'aXd', caret: 2 })
  })
  it('缺省位置追加到末尾', () => {
    expect(insertSnippetAtCursor('abc', 'X')).toEqual({ next: 'abcX', caret: 4 })
  })
  it('空串插入', () => {
    expect(insertSnippetAtCursor('', '{{page}}')).toEqual({ next: '{{page}}', caret: 8 })
  })
})
