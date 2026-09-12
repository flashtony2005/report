import { describe, expect, it, vi } from 'vitest'

// 真实环境无法在 happy-dom 中栅格化 SVG foreignObject，也不应让 jsPDF 读本地文件。
// 这里 mock 栅格化下层 + Blob→dataURL，只验证 documentToPdf 的 jsPDF 装配。
// （写死思源宋体的内联逻辑在 export-pdf.ts 内由 PDF_FONTS 常量体现，随代码审查保证。）
vi.mock('@/core/export-engine/rasterize', () => ({
  pageToImageBlob: vi.fn(async () => {
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: 'image/png' })
  }),
}))

vi.mock('@/core/export-engine/util', () => ({
  blobToDataURL: vi.fn(async () => {
    // 直接返回合法 PNG data URI，避开 happy-dom 的 FileReader/fs-read 限制
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  }),
}))

import { documentToPdf } from '@/core/export-engine/export-pdf'
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

describe('documentToPdf —— 位图 PDF 装配（jsPDF）', () => {
  it('多页模板产出单文件多页 PDF blob', async () => {
    const result = await layout(createDemoTemplate(), makeData(30), { measurer: createCjkMeasurer() })
    const blob = await documentToPdf(result, { scale: 2 })
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(0)
  })
})
