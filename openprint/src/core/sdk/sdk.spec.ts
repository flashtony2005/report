import { describe, expect, it } from 'vitest'

import { dispose, render, renderDocument } from '@/core/sdk'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'

function makeData(rows: number): Record<string, unknown> {
  const items = Array.from({ length: rows }, (_, i) => {
    const qty = (i % 5) + 1
    const price = 10 + (i % 9)
    return {
      productCode: `P${String(i + 1).padStart(4, '0')}`,
      productName: `商品${i + 1}`,
      spec: '规格A',
      unit: '件',
      qty,
      price,
      amount: qty * price,
    }
  })
  return { order: { orderNo: 'SO-001' }, customer: { name: '客户' }, items }
}

describe('sdk.render —— 对外渲染契约 §6.4', () => {
  const measurer = createCjkMeasurer()

  it('render 返回 html / pages / result / warnings，且多页', async () => {
    const res = await render({ template: createDemoTemplate(), data: makeData(40), layout: { measurer } })
    expect(typeof res.html).toBe('string')
    expect(res.html.length).toBeGreaterThan(0)
    expect(res.pages).toBeGreaterThanOrEqual(2)
    expect(res.result.pages.length).toBe(res.pages)
    expect(Array.isArray(res.warnings)).toBe(true)
  })

  it('renderDocument 只排版，产出页面模型', async () => {
    const result = await renderDocument({
      template: createDemoTemplate(),
      data: makeData(10),
      layout: { measurer },
    })
    expect(result.pages.length).toBeGreaterThanOrEqual(1)
  })

  it('dispose 释放共享测量器，不抛', () => {
    expect(() => dispose()).not.toThrow()
  })
})
