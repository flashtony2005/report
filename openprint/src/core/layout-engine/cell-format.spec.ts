import { describe, expect, it } from 'vitest'
import { formatCellValue } from './expression'
import type { CellFormat } from '@/types/control'

describe('formatCellValue —— 单元格数据格式', () => {
  it('undefined / none / text 回落默认 stringify', () => {
    expect(formatCellValue(123, undefined)).toBe('123')
    expect(formatCellValue(123, { kind: 'none' })).toBe('123')
    expect(formatCellValue(123, { kind: 'text' })).toBe('123')
    expect(formatCellValue(null, undefined)).toBe('')
  })

  it('date：按模板输出（年-月-日 / 年月日 / 美式）', () => {
    const d = new Date(2026, 7, 11) // 2026-08-11（本地，稳定）
    expect(formatCellValue(d, { kind: 'date', pattern: 'YYYY-MM-DD' })).toBe('2026-08-11')
    expect(formatCellValue(d, { kind: 'date', pattern: 'YYYY年MM月DD日' })).toBe('2026年08月11日')
    expect(formatCellValue(d, { kind: 'date', pattern: 'MM/DD/YYYY' })).toBe('08/11/2026')
  })

  it('date：带时间模板', () => {
    const d = new Date(2026, 7, 11, 14, 30)
    expect(formatCellValue(d, { kind: 'date', pattern: 'YYYY-MM-DD HH:mm' })).toBe('2026-08-11 14:30')
  })

  it('date：默认模板为 YYYY-MM-DD', () => {
    const d = new Date(2026, 7, 11)
    expect(formatCellValue(d, { kind: 'date' })).toBe('2026-08-11')
  })

  it('int：默认带千分位；thousands=false 不分组', () => {
    expect(formatCellValue(1234567, { kind: 'int' })).toBe('1,234,567')
    expect(formatCellValue(1234567, { kind: 'int', thousands: false })).toBe('1234567')
    expect(formatCellValue(0, { kind: 'int' })).toBe('0')
  })

  it('decimal：按 digits 截断；千分位可关', () => {
    expect(formatCellValue(1234.567, { kind: 'decimal', digits: 2 })).toBe('1,234.57')
    expect(formatCellValue(1234.5, { kind: 'decimal', digits: 0 })).toBe('1,235')
    expect(formatCellValue(1234.567, { kind: 'decimal', digits: 2, thousands: false })).toBe('1234.57')
  })

  it('currency：符号 + 千分位 + 小数位', () => {
    expect(formatCellValue(12800.5, { kind: 'currency' })).toBe('¥12,800.50')
    expect(formatCellValue(1200.5, { kind: 'currency', code: 'USD' })).toBe('$1,200.50')
    expect(formatCellValue(9.9, { kind: 'currency', code: 'EUR', digits: 1 })).toBe('€9.9')
  })

  it('percent：数值 ×100 加 %', () => {
    expect(formatCellValue(0.125, { kind: 'percent' })).toBe('12.50%')
    expect(formatCellValue(0.125, { kind: 'percent', digits: 1 })).toBe('12.5%')
    expect(formatCellValue(1, { kind: 'percent' })).toBe('100.00%')
  })

  it('digits 越界被收敛到 [0,6]', () => {
    expect(formatCellValue(1.23456789, { kind: 'decimal', digits: 99 })).toBe('1.234568')
    expect(formatCellValue(1.23456789, { kind: 'decimal', digits: -5 })).toBe('1')
  })

  it('非数字输入按 0 处理（与引擎 toNum 一致）', () => {
    expect(formatCellValue('abc', { kind: 'int' })).toBe('0')
    expect(formatCellValue('', { kind: 'decimal' })).toBe('0.00')
  })
})

/** 类型守卫：确保 CellFormat 联合在编译期被消费（防止误删成员） */
const _kinds: CellFormat['kind'][] = ['none', 'text', 'date', 'int', 'decimal', 'currency', 'percent']
void _kinds
