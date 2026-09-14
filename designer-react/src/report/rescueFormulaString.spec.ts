import { describe, expect, it } from 'vitest'
import {
  FORCE_STRING,
  isFormulaLike,
  looksLikeCellValue,
  rescueFormulaStringCells,
} from './rescueFormulaString'

describe('rescueFormulaString：把吞进 f 字段的 `=` 文本捞回 v', () => {
  it('{f:"=ds1.city", v:null} → {v:"=ds1.city", f:null, t:4}', () => {
    const cellValue = { 0: { 0: { f: '=ds1.city', v: null } } }
    expect(rescueFormulaStringCells(cellValue)).toBe(1)
    expect(cellValue[0][0]).toEqual({ v: '=ds1.city', f: null, t: FORCE_STRING })
  })

  it('层次坐标表达式同样捞回（不因为它长得不像字段就放过）', () => {
    const cellValue = { 3: { 3: { f: '=D3[B3:+0].sum()', v: null } } }
    expect(rescueFormulaStringCells(cellValue)).toBe(1)
    expect(cellValue[3][3]).toEqual({ v: '=D3[B3:+0].sum()', f: null, t: FORCE_STRING })
  })

  it('一次性处理多行多列，返回捞回的格数', () => {
    const cellValue = {
      0: { 0: { f: '=ds1.city', v: null }, 1: { v: '城市' } },
      1: { 0: { f: '=ds1.amount.sum()', v: null } },
    }
    expect(rescueFormulaStringCells(cellValue)).toBe(2)
    // 不只要「捞了几格」对，内容也得对：只断言数量的话，
    // 把 `c.v = c.f` 改成 `c.v = c.f.slice(1)` 这种错都抓不到
    expect(cellValue[0][0]).toEqual({ v: '=ds1.city', f: null, t: FORCE_STRING })
    expect(cellValue[1][0]).toEqual({ v: '=ds1.amount.sum()', f: null, t: FORCE_STRING })
    expect(cellValue[0][1]).toEqual({ v: '城市' }) // 没动
  })

  it('v 已经有值的不动（那不是被吞掉的格子）', () => {
    const cellValue = { 0: { 0: { f: '=ds1.city', v: '旧值' } } }
    expect(rescueFormulaStringCells(cellValue)).toBe(0)
    expect(cellValue[0][0]).toEqual({ f: '=ds1.city', v: '旧值' })
  })

  it('`=` 单独一个字符不捞（与 isFormulaString 的 length>1 对齐）', () => {
    const cellValue = { 0: { 0: { f: '=', v: null } } }
    expect(rescueFormulaStringCells(cellValue)).toBe(0)
    expect(cellValue[0][0]).toEqual({ f: '=', v: null })
  })

  it('普通文本（没有 f）不捞', () => {
    const cellValue = { 0: { 0: { v: 'hello' }, 1: { v: '' } } }
    expect(rescueFormulaStringCells(cellValue)).toBe(0)
    expect(cellValue[0][0]).toEqual({ v: 'hello' })
  })

  it('清空单元格（v 为 null 且没有 f）不捞', () => {
    const cellValue = { 0: { 0: { v: null } } }
    expect(rescueFormulaStringCells(cellValue)).toBe(0)
  })

  it('形状不对 / 空对象安全返回 0，不抛', () => {
    expect(rescueFormulaStringCells(undefined)).toBe(0)
    expect(rescueFormulaStringCells(null)).toBe(0)
    expect(rescueFormulaStringCells({})).toBe(0)
    expect(rescueFormulaStringCells({ 0: null })).toBe(0)
    expect(rescueFormulaStringCells({ 0: { 0: null } })).toBe(0)
  })
})

describe('rescueFormulaString：形状自检（防拦截器静默失效）', () => {
  it('looksLikeCellValue 认得出正常的行→列→格', () => {
    expect(looksLikeCellValue({ 0: { 0: { v: 'a' } } })).toBe(true)
    expect(looksLikeCellValue({ 2: { 5: { f: '=x', v: null } } })).toBe(true)
  })

  it('looksLikeCellValue 认得出「变了形」的参数', () => {
    // Univer 真换了结构的话，这里是最后一道能报出来的信号
    expect(looksLikeCellValue(undefined)).toBe(false)
    expect(looksLikeCellValue({})).toBe(false)
    expect(looksLikeCellValue({ 0: 'not-an-object' })).toBe(false)
    expect(looksLikeCellValue({ 0: {} })).toBe(false)
  })
})

describe('isFormulaLike', () => {
  it('只认 `=` 开头且长度 > 1', () => {
    expect(isFormulaLike('=ds1.city')).toBe(true)
    expect(isFormulaLike('=D3[B3:+0].sum()')).toBe(true)
    expect(isFormulaLike('=')).toBe(false)
    expect(isFormulaLike('')).toBe(false)
    expect(isFormulaLike('ds1.city')).toBe(false)
    expect(isFormulaLike(undefined)).toBe(false)
    expect(isFormulaLike(123)).toBe(false)
  })
})
