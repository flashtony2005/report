import { describe, expect, it } from 'vitest'

import { buildPrintPayload, isRawPayloadMode, RAW_PAYLOAD_MODES } from './payload'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'

describe('buildPrintPayload —— esc/tsc/zpl 指令直通模式', () => {
  it.each(RAW_PAYLOAD_MODES)('%s：content 为净化后的画布 JSON 平铺（无 template 包裹层、无样式污染）', async (mode) => {
    const template = createDemoTemplate()
    const request = { template, data: { order: { orderNo: 'SO-RAW-001' }, items: [] } }
    const payload = await buildPrintPayload(request, { mode })

    expect(payload.format).toBe(mode)
    expect(payload.encoding).toBe('utf8')
    // 画布 JSON 平铺：无 template 包裹层（画布 JSON 本身无 template 键），无渲染 output
    const parsed = JSON.parse(payload.content) as Record<string, unknown>
    expect(parsed).not.toHaveProperty('template')
    expect(parsed).not.toHaveProperty('output')
    expect(parsed.version).toBe(template.version)
    expect(parsed.data).toEqual(request.data)
    // 已净化：模板控件不带设计器元数据 / 字体样式（打印机内置字库，指令不支持）
    const sections = (parsed.document as { sections: Array<{ type: string; components: Array<Record<string, unknown>> }> }).sections
    const walk = (cs: Array<Record<string, unknown>>) => {
      for (const c of cs) {
        expect(c).not.toHaveProperty('locked')
        expect(c).not.toHaveProperty('name')
        expect(c).not.toHaveProperty('showGuides')
        expect(c).not.toHaveProperty('childOf')
        if (c.style && typeof c.style === 'object') {
          expect(c.style).not.toHaveProperty('fontFamily')
          expect(c.style).not.toHaveProperty('fill')
          expect(c.style).not.toHaveProperty('fontWeight')
        }
        if (Array.isArray(c.children)) walk(c.children as Array<Record<string, unknown>>)
      }
    }
    for (const s of sections) walk(s.components)
    // 不渲染：页数语义由客户端自算，物理页尺寸取模板 pageSetup（mm）
    expect(payload.pages).toBe(1)
    expect(payload.width).toBeGreaterThan(0)
    expect(payload.height).toBeGreaterThan(0)
    // bytes 为 utf-8 字节数
    expect(payload.bytes).toBe(new TextEncoder().encode(payload.content).length)
  })

  it('isRawPayloadMode 判定正确', () => {
    expect(isRawPayloadMode('esc')).toBe(true)
    expect(isRawPayloadMode('tsc')).toBe(true)
    expect(isRawPayloadMode('zpl')).toBe(true)
    expect(isRawPayloadMode('html')).toBe(false)
    expect(isRawPayloadMode('pdf')).toBe(false)
    expect(isRawPayloadMode(undefined)).toBe(false)
  })
})
