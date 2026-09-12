import { describe, expect, it } from 'vitest'

import { generateCss, mmv } from '@/core/renderer-html/css-generator'
import { renderDocument } from '@/core/sdk'
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

describe('generateCss —— 动态样式生成', () => {
  const measurer = createCjkMeasurer()

  async function css(opts: Parameters<typeof generateCss>[1]) {
    const result = await renderDocument({ template: createDemoTemplate(), data: makeData(10), layout: { measurer } })
    return generateCss(result.metrics, opts)
  }

  it('默认输出含 @page 与页面尺寸', async () => {
    const out = await css({})
    expect(out).toContain('@page')
    expect(out).toContain('mm')
  })

  it('screen 模式注入 --op-scale 缩放变量', async () => {
    const out = await css({ screen: true, scale: 2 })
    expect(out).toContain('--op-scale: 2')
  })

  it('screen:false 时 --op-scale 强制为 1（导出/打印不缩放）', async () => {
    const out = await css({ screen: false })
    expect(out).toContain('--op-scale: 1')
    expect(out).not.toContain('--op-scale: 2')
  })

  it('extraCss 追加到样式表', async () => {
    const out = await css({ extraCss: '.x{color:red}' })
    expect(out).toContain('.x{color:red}')
  })

  it('mmv 格式化毫米值', () => {
    expect(mmv(10)).toBe('10mm')
    expect(mmv(0)).toBe('0mm')
  })

  it('条码「宽高独立」：无特例规则，条码/二维码统一 100%×100% 填满控件框', async () => {
    const out = await css({})
    // 条码不再有 width:auto 特例（宽度独立可调，由 data-binder 的 SVG width 参数 + preserveAspectRatio="none" 实现）
    expect(out).not.toContain('.op-barcode-svg')
    // 通用规则仍在：条码/二维码 SVG 均填满控件框
    expect(out).toContain('.op-code > svg { display: block; width: 100%; height: 100%; }')
  })
})
