import { afterEach, describe, expect, it, vi } from 'vitest'

import { inlinePageImages, toXmlSafe, capScaleByArea, MAX_CANVAS_AREA } from '@/core/export-engine/rasterize'

describe('toXmlSafe —— HTML→XML 安全（foreignObject 光栅化前置）', () => {
  it('void 标签补自闭合', () => {
    expect(toXmlSafe('<img src="x.png">')).toBe('<img src="x.png" />')
    expect(toXmlSafe('<br>')).toBe('<br />')
    expect(toXmlSafe('<col style="width:10mm">')).toBe('<col style="width:10mm" />')
    expect(toXmlSafe('<hr>')).toBe('<hr />')
    expect(toXmlSafe('<input type="text">')).toBe('<input type="text" />')
  })

  it('已自闭合的 void 标签保持单一斜杠', () => {
    // 带属性的自闭合：补成标准 " />" 形式
    expect(toXmlSafe('<img src="a"/>')).toBe('<img src="a" />')
    // 无属性的自闭合（如 <br/>）正则不触碰，原样保留也是正确的 XML
    expect(toXmlSafe('<br/>')).toBe('<br/>')
  })

  it('内嵌 <svg> 缺命名空间时补上', () => {
    expect(toXmlSafe('<svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(toXmlSafe('<svg viewBox="0 0 1 1">')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">',
    )
  })

  it('已带命名空间的 <svg> 不再重复补', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    expect(toXmlSafe(src)).toBe(src)
  })

  it('普通标签与文本不受影响', () => {
    expect(toXmlSafe('<div class="op-page">你好<span>世界</span></div>')).toBe(
      '<div class="op-page">你好<span>世界</span></div>',
    )
  })
})

describe('inlinePageImages —— 外部图片内联（防 canvas taint）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
  const stubFetch = (mime = 'image/png') =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => mime },
        arrayBuffer: async () => png.buffer,
      })),
    )

  it('无图片时原样返回', async () => {
    const html = '<div class="op-text">hello</div>'
    expect(await inlinePageImages(html)).toBe(html)
  })

  it('外部图片 src 被替换为 data URI（btoa 可用环境）', async () => {
    stubFetch()
    const out = await inlinePageImages('<img src="http://example.com/a.png" />')
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('http://example.com')
  })

  it('单引号 src 的 <img> 同样被内联（此前漏网导致 canvas taint）', async () => {
    stubFetch()
    const out = await inlinePageImages("<img src='http://example.com/b.png' />")
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('http://example.com')
  })

  it('CSS url(...) 背景图被内联', async () => {
    stubFetch()
    const out = await inlinePageImages('<div style="background:url(http://example.com/bg.png)"></div>')
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('http://example.com')
  })

  it('SVG <image href> 被内联', async () => {
    stubFetch()
    const out = await inlinePageImages('<svg><image href="http://example.com/logo.png" /></svg>')
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('http://example.com')
  })

  it('加载失败的图片降级为透明占位，不阻塞导出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const out = await inlinePageImages('<img src="/missing.png" />')
    expect(out).toContain('data:image/png;base64,')
    expect(out).not.toContain('/missing.png')
  })

  it('data URI 图片保持原样（不重复内联）', async () => {
    const html = '<img src="data:image/png;base64,AAA" />'
    expect(await inlinePageImages(html)).toBe(html)
  })

  it('data URI 的 CSS url 保持原样', async () => {
    const html = '<div style="background:url(data:image/png;base64,AAA)"></div>'
    expect(await inlinePageImages(html)).toBe(html)
  })
})

describe('capScaleByArea —— canvas 面积/边长护栏（防 Chromium 超限静默空白）', () => {
  it('A4 基准（794×1123）：600dpi=6.25x 不受影响', () => {
    expect(capScaleByArea(794, 1123, 6.25)).toBe(6.25)
  })

  it('A4 基准：1200dpi=12.5x 在面积上限内（139M px < 250M）不受影响', () => {
    expect(capScaleByArea(794, 1123, 12.5)).toBe(12.5)
  })

  it('A4 基准：2400dpi=25x 超面积上限 → 自动下调（页面 mm 不变仅降分辨率）', () => {
    const capped = capScaleByArea(794, 1123, 25)
    expect(capped).toBeLessThan(25)
    // 面积恰好不超上限：capped² × 794 × 1123 ≤ 250M
    expect(capped * capped * 794 * 1123).toBeLessThanOrEqual(MAX_CANVAS_AREA)
  })

  it('长条页面（219×3780）：边长护栏优先于面积护栏', () => {
    // 面积允许 17.4x，但高 3780×17.4 > 32767 → 被边长压到 32767/3780 ≈ 8.67
    const capped = capScaleByArea(219, 3780, 20)
    expect(capped).toBeCloseTo(32767 / 3780, 4)
  })

  it('scale ≤ 1 原样返回（护栏只降不升）', () => {
    expect(capScaleByArea(794, 1123, 1)).toBe(1)
    expect(capScaleByArea(794, 1123, 0.5)).toBe(1)
  })
})
