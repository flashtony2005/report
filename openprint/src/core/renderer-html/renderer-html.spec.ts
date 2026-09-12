import { describe, expect, it } from 'vitest'

import { layout } from '@/core/layout-engine/pagination-engine'
import { renderHtml, renderPage, renderStyle } from '@/core/renderer-html'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'
import type { RectControl } from '@/types/control'
import type { LayoutPage, PlacedControl } from '@/core/layout-engine/types'

function rectControl(overrides: Partial<RectControl>): RectControl {
  return {
    id: 'r1',
    type: 'rect',
    left: 0,
    top: 0,
    width: 40,
    height: 25,
    ...overrides,
  }
}

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

describe('renderer-html —— HTML 输出', () => {
  const template = createDemoTemplate()
  const measurer = createCjkMeasurer()

  it('renderHtml 输出多页文档结构', async () => {
    const result = await layout(template, makeData(30), { measurer })
    const html = renderHtml(result, { screen: false })
    expect(html).toContain('op-doc')
    expect(html).toContain('op-page')
    expect(html).toContain('op-page-wrap')
    expect(html).toContain('销售出库单')
  })

  it('renderStyle 注入打印分页样式', async () => {
    const result = await layout(template, makeData(10), { measurer })
    const style = renderStyle(result, { screen: false })
    expect(style).toContain('@page')
    expect(style).toContain('break-after')
  })

  describe('renderShape —— 形状样式', () => {
    /** 用一个只含单个形状控件的页面直接喂给 renderPage 验证 CSS 输出 */
    function renderShapeHtml(c: RectControl): string {
      const node: PlacedControl = {
        kind: 'control',
        id: c.id,
        left: c.left,
        top: c.top,
        width: c.width,
        height: c.height,
        content: { kind: 'shape' },
        control: c,
      }
      const page: LayoutPage = {
        index: 0,
        pageNo: 1,
        header: [],
        body: [node],
        footer: [],
      }
      return renderPage(page)
    }

    it('四角独立圆角输出四值 border-radius', () => {
      const html = renderShapeHtml(
        rectControl({ cornerRadiusTL: 5, cornerRadiusTR: 10, cornerRadiusBR: 15, cornerRadiusBL: 20 }),
      )
      expect(html).toContain('border-radius:5px 10px 15px 20px')
    })

    it('仅设置部分角时，未设置角回落到统一 cornerRadius', () => {
      const html = renderShapeHtml(rectControl({ cornerRadius: 8, cornerRadiusTR: 30 }))
      // TR=30 覆盖统一值，其余三角=8
      expect(html).toContain('border-radius:8px 30px 8px 8px')
    })

    it('统一 cornerRadius 输出单值 border-radius', () => {
      const html = renderShapeHtml(rectControl({ cornerRadius: 8 }))
      expect(html).toContain('border-radius:8px')
      expect(html).not.toContain('8px 8px 8px 8px')
    })

    it('虚线模式输出 border-style:dashed', () => {
      const html = renderShapeHtml(rectControl({ strokeDashArray: [6, 4] }))
      expect(html).toContain('border-style:dashed')
    })

    it('圆形（正方形外接框）输出 border-radius:50%', () => {
      const html = renderShapeHtml(rectControl({ shape: 'circle', width: 40, height: 40 }))
      expect(html).toContain('border-radius:50%')
      expect(html).toContain('op-circle')
    })

    it('圆形宽高不等时为椭圆（仍用 border-radius:50%，CSS 自动椭圆化）', () => {
      const html = renderShapeHtml(rectControl({ shape: 'circle', width: 60, height: 30 }))
      expect(html).toContain('border-radius:50%')
    })
  })
})
