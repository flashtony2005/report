/**
 * 字体 data-URI 缓存单测
 * 回归：导出 PDF / 多页图片时每页都 embedFonts（思源宋体 10MB+），
 * 旧实现无缓存 → N 页 = N 次 fetch + N 次 base64 + N 份副本塞进 SVG。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { clearFontDataUriCache, embedFontsInSvg, type FontFaceDef } from './fonts'

const SVG = '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>'
const DEF: FontFaceDef = { family: 'Test', src: '/fonts/test.ttf' }

function stubFetch(bytes: Uint8Array = new Uint8Array([1, 2, 3])): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })))
}

describe('字体 data-URI 缓存', () => {
  beforeEach(() => {
    clearFontDataUriCache()
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearFontDataUriCache()
  })

  it('多页导出：同一字体只 fetch 一次（N 页 → 1 次网络读取）', async () => {
    await embedFontsInSvg(SVG, [DEF])
    await embedFontsInSvg(SVG, [DEF])
    await embedFontsInSvg(SVG, [DEF])
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('不同 src 各自缓存，互不影响', async () => {
    await embedFontsInSvg(SVG, [DEF])
    await embedFontsInSvg(SVG, [{ family: 'Other', src: '/fonts/other.woff2' }])
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('每次调用产物都含 @font-face（缓存不影响结果正确性）', async () => {
    const a = await embedFontsInSvg(SVG, [DEF])
    const b = await embedFontsInSvg(SVG, [DEF])
    expect(a).toContain('@font-face')
    expect(a).toBe(b)
  })

  it('加载失败：跳过该字体、不写坏缓存（后续可重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const out = await embedFontsInSvg(SVG, [DEF])
    expect(out).toBe(SVG)
    // 换成成功实现后应能拿到字体（坏缓存未残留）
    stubFetch()
    const out2 = await embedFontsInSvg(SVG, [DEF])
    expect(out2).toContain('@font-face')
  })

  it('空字体列表直接返回原串，不发起请求', async () => {
    expect(await embedFontsInSvg(SVG, [])).toBe(SVG)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
