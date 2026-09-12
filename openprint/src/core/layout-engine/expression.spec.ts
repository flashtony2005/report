import { describe, expect, it } from 'vitest'

import {
  evaluate,
  evaluateVisible,
  interpolate,
  resolveBinding,
} from '@/core/layout-engine/expression'

// EvalContext 必须有 data 字段；测试里无变量时用 { data: {} }


describe('expression 安全表达式引擎', () => {
  it('基础算术与优先级', () => {
    expect(evaluate('1 + 2 * 3', { data: {} })).toBe(7)
    expect(evaluate('(1 + 2) * 3', { data: {} })).toBe(9)
    expect(evaluate('10 / 4', { data: {} })).toBe(2.5)
  })

  it('字符串拼接', () => {
    expect(evaluate('"a" + "b"', { data: {} })).toBe('ab')
    expect(evaluate('"x" + 1', { data: {} })).toBe('x1')
  })

  it('比较与逻辑', () => {
    expect(evaluate('3 > 2', { data: {} })).toBe(true)
    expect(evaluate('true && false', { data: {} })).toBe(false)
    expect(evaluate('true || false', { data: {} })).toBe(true)
    expect(evaluate('!false', { data: {} })).toBe(true)
  })

  it('变量从 ctx.data 取值', () => {
    expect(evaluate('x * 2', { data: { x: 5 } })).toBe(10)
    expect(evaluate('a + b', { data: { a: 2, b: 3 } })).toBe(5)
  })

  it('过滤器（经 interpolate 解析 {{ }} 管道）', () => {
    expect(interpolate('{{name | upper}}', { data: { name: 'abc' } }).text).toBe('ABC')
    expect(interpolate('{{name | lower}}', { data: { name: 'ABC' } }).text).toBe('abc')
    expect(interpolate('{{v | number:0}}', { data: { v: 1234.5 } }).text).toBe('1,235')
    expect(interpolate('{{amount | currency}}', { data: { amount: 12800.5 } }).text).toContain('12,800.50')
    expect(interpolate('{{v | default:"无"}}', { data: { v: '' } }).text).toBe('无')
    expect(interpolate('{{n | padStart:3}}', { data: { n: 7 } }).text).toBe('007')
  })

  it('resolveBinding 按路径取值', () => {
    expect(resolveBinding('a.b', { data: { a: { b: 1 } } })).toBe(1)
  })

  it('interpolate 替换 {{ }}', () => {
    expect(interpolate('{{x}}岁', { data: { x: 18 } }).text).toBe('18岁')
    expect(interpolate('单价{{price|currency}}', { data: { price: 9.9 } }).text).toContain('9.90')
    expect(interpolate('无占位', { data: {} }).text).toBe('无占位')
  })

  it('evaluateVisible 条件渲染', () => {
    expect(evaluateVisible('', { data: {} })).toBe(true)
    expect(evaluateVisible('  ', { data: {} })).toBe(true)
    expect(evaluateVisible('false', { data: {} })).toBe(false)
    expect(evaluateVisible('x > 3', { data: { x: 5 } })).toBe(true)
    expect(evaluateVisible('x > 3', { data: { x: 1 } })).toBe(false)
  })

  // —— 安全边界：绝不能执行任意 JS ——
  it('拒绝 eval / new Function / import 等代码注入', () => {
    expect(() => evaluate('eval("x")', { data: {} })).toThrow()
    expect(() => evaluate('new Function("return 1")', { data: {} })).toThrow()
    expect(() => evaluate('import("x")', { data: {} })).toThrow()
    expect(() => evaluate('window.location', { data: {} })).not.toThrow() // 读取未定义变量返回 undefined，而非执行
    expect(evaluate('window.location', { data: {} })).toBeUndefined()
  })

  it('语法错误抛出', () => {
    expect(() => evaluate('1 +', { data: {} })).toThrow()
    expect(() => evaluate('@#$', { data: {} })).toThrow()
  })
})

describe('expression 内置函数（函数调用语法）', () => {
  const ctx = {
    data: {
      items: [
        { qty: 2, price: 10, amount: 20 },
        { qty: 3, price: 10, amount: 30 },
        { qty: 5, price: 10, amount: 50 },
      ],
      total: 100,
    },
  }

  it('now() 返回 Date 且可经 | date 过滤器', () => {
    const r = interpolate('{{now() | date:"YYYY-MM-DD"}}', { data: {} })
    expect(r.errors).toHaveLength(0)
    expect(r.text).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('sum 对带 [] 的路径聚合数据数组', () => {
    expect(evaluate("sum('items[].amount')", ctx)).toBe(100)
    expect(evaluate("sum('items[].qty')", ctx)).toBe(10)
  })

  it('avg / count / min / max', () => {
    expect(evaluate("avg('items[].amount')", ctx)).toBeCloseTo(100 / 3)
    expect(evaluate("count('items[].qty')", ctx)).toBe(3)
    expect(evaluate("min('items[].amount')", ctx)).toBe(20)
    expect(evaluate("max('items[].amount')", ctx)).toBe(50)
  })

  it('len 取数组 / 字符串长度', () => {
    expect(evaluate('len(items)', ctx)).toBe(3)
    expect(evaluate('len("abc")', { data: {} })).toBe(3)
  })

  it('函数可嵌入 {{}} 与普通文本混排', () => {
    const r = interpolate('合计 ¥{{ sum(\'items[].amount\') | currency:"CNY" }}', ctx)
    expect(r.errors).toHaveLength(0)
    expect(r.text).toContain('¥')
    expect(r.text).toContain('100.00')
  })

  it('未知函数抛错（转 warning，不打断渲染）', () => {
    expect(() => evaluate('foo()', ctx)).toThrow(/未知函数/)
  })
})

describe('expression 逻辑函数（if / 非空 / 布尔）', () => {
  const ctx = {
    data: {
      amount: 200,
      status: 'paid',
      vip: true,
      order: { no: 'A1001', remark: '' },
      items: [{ name: '特价苹果' }, { name: '香蕉' }],
      productName: '特价礼盒',
      codes: ['promo', 'new'],
      emptyList: [] as unknown[],
    },
  }

  it('if 按条件二选一', () => {
    expect(evaluate("if(amount > 100, '大单', '小单')", ctx)).toBe('大单')
    expect(evaluate("if(amount > 999, '大单', '小单')", ctx)).toBe('小单')
  })

  it('notEmpty / isEmpty 空值判定', () => {
    expect(evaluate('notEmpty(order.no)', ctx)).toBe(true)
    expect(evaluate('notEmpty(order.remark)', ctx)).toBe(false)
    expect(evaluate('isEmpty(order.remark)', ctx)).toBe(true)
    expect(evaluate('isEmpty(order.no)', ctx)).toBe(false)
    expect(evaluate('isEmpty(emptyList)', ctx)).toBe(true)
    expect(evaluate('notEmpty(undefinedField)', ctx)).toBe(false)
  })

  it('eq 宽松相等', () => {
    expect(evaluate("eq(status, 'paid')", ctx)).toBe(true)
    expect(evaluate("eq(status, 'unpaid')", ctx)).toBe(false)
    expect(evaluate('eq(1, "1")', { data: {} })).toBe(true)
  })

  it('and / or / not 布尔组合', () => {
    expect(evaluate('and(amount > 0, notEmpty(order.no))', ctx)).toBe(true)
    expect(evaluate('and(amount > 999, notEmpty(order.no))', ctx)).toBe(false)
    expect(evaluate('or(vip === true, amount > 1000)', ctx)).toBe(true)
    expect(evaluate('or(vip === false, amount > 1000)', ctx)).toBe(false)
    expect(evaluate('not(isEmpty(order.no))', ctx)).toBe(true)
  })

  it('contains 文本子串 / 数组元素', () => {
    expect(evaluate("contains(productName, '特价')", ctx)).toBe(true)
    expect(evaluate("contains(productName, '缺货')", ctx)).toBe(false)
    expect(evaluate("contains(codes, 'promo')", ctx)).toBe(true)
    expect(evaluate("contains(codes, 'sold')", ctx)).toBe(false)
  })

  it('逻辑函数可嵌入 {{}} 并接过滤器', () => {
    const r = interpolate("{{if(notEmpty(order.no), order.no, '—')}}", ctx)
    expect(r.errors).toHaveLength(0)
    expect(r.text).toBe('A1001')
    const r2 = interpolate("{{if(notEmpty(order.remark), order.remark, '—')}}", ctx)
    expect(r2.text).toBe('—')
  })
})
