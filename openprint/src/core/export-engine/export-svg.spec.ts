import { describe, expect, it } from 'vitest'

import { layout } from '@/core/layout-engine/pagination-engine'
import { documentToSvgString } from '@/core/export-engine/export-svg'
import { mmToPx } from '@/core/units'
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

describe('documentToSvgString —— 多页矢量 SVG', () => {
  it('产出多页堆叠合法 SVG（foreignObject + 中文 + 精确像素）', async () => {
    const template = createDemoTemplate()
    const result = await layout(template, makeData(30), { measurer: createCjkMeasurer() })
    const svg = await documentToSvgString(result)

    expect(svg).toContain('<foreignObject')
    // 多页 → 多个嵌套 <svg x=...>
    expect((svg.match(/<svg x=/g) || []).length).toBe(result.pages.length)

    // 像素尺寸 794×1123（210×297mm × 3.7795 ≈ 793.8/1122.7 → 794/1123）
    const w = Math.round(mmToPx(210))
    expect(w).toBe(794)
    expect(svg).toContain(`width="${w}"`)

    expect(svg).toContain('销售出库单')
  })
})
