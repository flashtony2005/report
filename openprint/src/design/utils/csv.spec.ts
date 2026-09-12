import { describe, it, expect } from 'vitest'
import { parseCsv, csvToRecords } from './csv'

describe('parseCsv', () => {
  it('基础两行两列', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('引号内逗号保留', () => {
    expect(parseCsv('name,note\n"Li, Lei","hello, world"')).toEqual([
      ['name', 'note'],
      ['Li, Lei', 'hello, world'],
    ])
  })

  it('引号转义（"" → "）', () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']])
  })

  it('引号内换行保留为单字段', () => {
    const r = parseCsv('a\n"line1\nline2"')
    expect(r).toEqual([['a'], ['line1\nline2']])
  })

  it('CRLF / LF / 老式 CR 均按行分隔', () => {
    expect(parseCsv('a,b\r\n1,2\n3,4\r5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ])
  })

  it('剥离 UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('忽略尾部空行', () => {
    expect(parseCsv('a\n1\n\n')).toEqual([['a'], ['1']])
  })
})

describe('csvToRecords', () => {
  it('首行作表头，生成对象数组', () => {
    expect(csvToRecords('name,price\nLi,12.5\nWang,9')).toEqual([
      { name: 'Li', price: '12.5' },
      { name: 'Wang', price: '9' },
    ])
  })

  it('单元格一律为字符串（不擅自转数字，保留前导零等）', () => {
    const rec = csvToRecords('code\n00123')[0]!
    expect(rec.code).toBe('00123')
  })

  it('空列名补齐为 col{序号}', () => {
    const rec = csvToRecords('a,,\nc,,\n')[0]!
    expect(Object.keys(rec)).toEqual(['a', 'col2', 'col3'])
  })

  it('空 CSV 返回空数组', () => {
    expect(csvToRecords('')).toEqual([])
  })
})
