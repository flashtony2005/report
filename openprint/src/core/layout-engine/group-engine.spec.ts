import { describe, expect, it } from 'vitest'

import { computeAggregates, subtotalLabel } from './group-engine'
import type { TableControl } from '@/types/control'

const COLS_WITH_AMOUNT = [{ field: 'amount', title: '金额', width: 30 }]

describe('computeAggregates —— 自定义合计（type=custom）', () => {
  it('字段专属表达式：引用预计算的 sum', () => {
    const control = {
      columns: COLS_WITH_AMOUNT,
      options: {
        summaryRow: {
          type: 'custom' as const,
          fields: ['amount'],
          expressions: { amount: 'sum.amount * 2' },
        },
      },
    } as unknown as TableControl
    const out = computeAggregates([{ amount: 10 }, { amount: 20 }], control)
    expect(out.amount).toBe(60) // (10+20)*2
  })

  it('无专属表达式时回退到 summaryRow.expression', () => {
    const control = {
      columns: COLS_WITH_AMOUNT,
      options: {
        summaryRow: { type: 'custom' as const, fields: ['amount'], expression: 'sum.amount + 5' },
      },
    } as unknown as TableControl
    const out = computeAggregates([{ amount: 10 }, { amount: 20 }], control)
    expect(out.amount).toBe(35) // 30+5
  })

  it('avg 作用域可用', () => {
    const control = {
      columns: COLS_WITH_AMOUNT,
      options: {
        summaryRow: { type: 'custom' as const, fields: ['amount'], expressions: { amount: 'avg.amount' } },
      },
    } as unknown as TableControl
    const out = computeAggregates([{ amount: 10 }, { amount: 20 }, { amount: 30 }], control)
    expect(out.amount).toBe(20)
  })

  it('作用域含 rows / allRows（分组内行 / 整表行）', () => {
    const control = {
      columns: COLS_WITH_AMOUNT,
      options: {
        summaryRow: {
          type: 'custom' as const,
          fields: ['amount'],
          expressions: { amount: 'rows.length * 10 + allRows.length' },
        },
      },
    } as unknown as TableControl
    // 当前分组 2 行，整表 3 行 → 2*10 + 3 = 23
    const out = computeAggregates(
      [{ amount: 1 }, { amount: 2 }],
      control,
      [{ amount: 1 }, { amount: 2 }, { amount: 3 }],
    )
    expect(out.amount).toBe(23)
  })

  it('无聚合列时把单表达式结果落入占位键 __total__', () => {
    const control = {
      columns: COLS_WITH_AMOUNT,
      options: {
        summaryRow: { type: 'custom' as const, fields: [], expression: 'sum.amount + 1' },
      },
    } as unknown as TableControl
    const out = computeAggregates([{ amount: 9 }], control)
    expect(out.__total__).toBe(10)
  })
})

describe('subtotalLabel —— 模板替换', () => {
  it('默认「${key} 小计」', () => {
    const control = { columns: [], options: {} } as unknown as TableControl
    expect(subtotalLabel(control, 'A组')).toBe('A组 小计')
  })

  it('自定义模板替换 ${key}', () => {
    const control = {
      columns: [],
      options: { summaryRow: { subtotalLabel: '${key} 分组小计' } },
    } as unknown as TableControl
    expect(subtotalLabel(control, '甲')).toBe('甲 分组小计')
  })
})
