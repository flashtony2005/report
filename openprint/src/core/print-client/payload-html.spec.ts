import { describe, it, expect } from 'vitest'

import { buildPrintPayload } from './payload'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'
import type { RenderRequest } from '@/core/sdk'

function makeRequest(rows: number): RenderRequest {
  const items = Array.from({ length: rows }, (_, i) => ({
    productCode: `P${i + 1}`,
    productName: `商品${i + 1}`,
    qty: (i % 5) + 1,
    price: 10,
    amount: ((i % 5) + 1) * 10,
  }))
  return {
    template: createDemoTemplate(),
    data: { order: { orderNo: 'SO-HTML-001' }, items },
    layout: { measurer: createCjkMeasurer() },
  }
}

describe('buildPrintPayload —— html 模式（QWebEngine 矢量打印路径）', () => {
  it('产出自包含完整 HTML 文档（utf8），带页面元信息', async () => {
    const payload = await buildPrintPayload(makeRequest(3), { mode: 'html' })

    expect(payload.format).toBe('html')
    expect(payload.encoding).toBe('utf8')
    expect(payload.content.startsWith('<!DOCTYPE html>')).toBe(true)
    // 数据已渲染进 HTML
    expect(payload.content).toContain('SO-HTML-001')
    expect(payload.content).toContain('商品1')
    // 页面元信息供客户端设置纸张
    expect(payload.pages).toBeGreaterThanOrEqual(1)
    expect(payload.width).toBeGreaterThan(0)
    expect(payload.height).toBeGreaterThan(0)
    // bytes 为 utf-8 字节数（与 content 一致口径）
    expect(payload.bytes).toBe(new TextEncoder().encode(payload.content).length)
  })

  it('打印态 CSS：缩放强制 1、无预览阴影（screen=false）', async () => {
    const payload = await buildPrintPayload(makeRequest(2), { mode: 'html' })
    expect(payload.content).toContain('--op-scale: 1')
    // 屏幕预览的卡片阴影不应出现（打印态只有 box-shadow:none 重置）
    expect(payload.content).not.toContain('0 1px 6px')
  })

  it('字体内联失败（node 环境无 /fonts/）不阻塞，HTML 照常产出', async () => {
    const payload = await buildPrintPayload(makeRequest(2), {
      mode: 'html',
      fonts: [{ family: '不存在的字体', src: '/fonts/no-such-font.woff2' }],
    })
    expect(payload.format).toBe('html')
    expect(payload.content.startsWith('<!DOCTYPE html>')).toBe(true)
  })
})
