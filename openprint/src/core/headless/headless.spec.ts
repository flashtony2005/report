import { describe, expect, it } from 'vitest'

import { createHeadless } from '@/core/headless'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'

function makeData(rows: number): Record<string, unknown> {
  const items = Array.from({ length: rows }, (_, i) => ({
    productCode: `P${i + 1}`,
    productName: `商品${i + 1}`,
    qty: (i % 5) + 1,
    price: 10,
    amount: ((i % 5) + 1) * 10,
  }))
  return { order: { orderNo: 'SO-001' }, items }
}

describe('createHeadless —— 无头静默模式', () => {
  const measurer = createCjkMeasurer()

  it('render 复用 sdk 产出多页 HTML（零 UI 残留）', async () => {
    const hl = createHeadless({ fonts: [] })
    const res = await hl.render({ template: createDemoTemplate(), data: makeData(40), layout: { measurer } })
    expect(res.pages).toBeGreaterThanOrEqual(2)
    hl.dispose()
  })

  it('buildRequest 未配置 repository 时抛错（契约边界）', async () => {
    const hl = createHeadless({ fonts: [] })
    await expect(hl.buildRequest('missing')).rejects.toThrow()
    hl.dispose()
  })
})
