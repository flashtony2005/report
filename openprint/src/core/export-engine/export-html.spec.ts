import { describe, expect, it } from 'vitest'

import { exportDocument } from '@/core/export-engine'
import { layout } from '@/core/layout-engine/pagination-engine'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'

function makeData(rows: number): Record<string, unknown> {
  const items = Array.from({ length: rows }, (_, i) => {
    const qty = (i % 5) + 1
    return {
      productCode: `P${String(i + 1).padStart(4, '0')}`,
      productName: `商品${i + 1}`,
      spec: '规格A',
      unit: '件',
      qty,
      price: 10,
      amount: qty * 10,
    }
  })
  return { order: { orderNo: 'SO-001' }, customer: { name: '客户' }, items }
}

describe('exportDocument(format:html) —— 自包含 HTML 导出', () => {
  it('产出单文件 .html，含完整文档结构与打印态页面', async () => {
    const template = createDemoTemplate()
    const result = await layout(template, makeData(30), { measurer: createCjkMeasurer() })
    const res = await exportDocument(
      { template, data: makeData(30) },
      'html',
      { filename: '测试单据' },
    )
    expect(res.filenames).toEqual(['测试单据.html'])
    expect(res.mime).toBe('text/html')
    expect(res.blobs).toHaveLength(1)
    const text = await res.blobs[0]!.text()
    expect(text).toContain('<!DOCTYPE html>')
    expect(text).toContain('op-page')
    expect(text).toContain('--op-scale: 1')
    // 零外部资源引用（xmlns 命名空间属正常标识，非网络请求）
    expect(text).not.toMatch(/<link[^>]+href=/i)
    expect(text).not.toMatch(/<script[^>]+src=/i)
    expect(text).not.toMatch(/src="https?:/i)
  })
})
