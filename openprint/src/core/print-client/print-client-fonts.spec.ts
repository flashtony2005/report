import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listSystemFonts,
  systemFontDataUrl,
  fontFormatToCss,
  fontContentType,
} from './client'
import { PrintClientError } from './types'

/** 模拟 fetch 返回 */
function mockFetch(response: unknown, ok = true, contentType = 'application/json'): typeof fetch {
  const fn = vi.fn(async () => {
    const body = typeof response === 'string' ? response : JSON.stringify(response)
    return {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Server Error',
      json: async () => (typeof response === 'string' ? JSON.parse(response) : response),
      text: async () => body,
      headers: new Headers({ 'content-type': contentType }),
    } as Response
  })
  return fn as unknown as typeof fetch
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('listSystemFonts', () => {
  it('成功返回归一化后的字体数组', async () => {
    const sample = {
      ok: true,
      count: 2,
      fonts: [
        { family: 'Arial', format: 'ttf', path: 'C:/Windows/Fonts/arial.ttf', size: 100 },
        { family: 'Segoe UI', format: 'woff2', path: 'C:/Windows/Fonts/segoe.woff2', size: 50 },
      ],
    }
    vi.stubGlobal('fetch', mockFetch(sample))
    const list = await listSystemFonts('http://127.0.0.1:18888')
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      family: 'Arial',
      format: 'ttf',
      path: 'C:/Windows/Fonts/arial.ttf',
      size: 100,
    })
    expect(list[1]!.format).toBe('woff2')
  })

  it('缺少 fonts 数组 → 抛 parse 错误', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true, count: 0 }))
    await expect(listSystemFonts('http://127.0.0.1:18888')).rejects.toThrow(/fonts 数组/)
  })

  it('ok:false → 抛 service 错误', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, count: 0, fonts: [] }))
    await expect(listSystemFonts('http://127.0.0.1:18888')).rejects.toBeInstanceOf(PrintClientError)
  })

  it('字段缺失时归一化为安全默认', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ok: true, count: 1, fonts: [{ family: 'X' }] }),
    )
    const list = await listSystemFonts('http://127.0.0.1:18888')
    expect(list[0]).toEqual({ family: 'X', format: 'ttf', path: '', size: 0 })
  })
})

describe('systemFontDataUrl', () => {
  it('拼装编码路径作为 query', () => {
    const url = systemFontDataUrl({ path: 'C:/Windows/Fonts/ARIAL.TTF' }, 'http://127.0.0.1:18888')
    expect(url).toBe(
      'http://127.0.0.1:18888/api/fonts/data?path=' + encodeURIComponent('C:/Windows/Fonts/ARIAL.TTF'),
    )
  })

  it('支持局域网地址', () => {
    const url = systemFontDataUrl({ path: '/opt/fonts/x.ttf' }, 'http://192.168.1.20:19000')
    expect(url.startsWith('http://192.168.1.20:19000/api/fonts/data?path=')).toBe(true)
  })
})

describe('fontFormatToCss', () => {
  it('格式映射正确', () => {
    expect(fontFormatToCss('ttf')).toBe('truetype')
    expect(fontFormatToCss('otf')).toBe('opentype')
    expect(fontFormatToCss('woff')).toBe('woff')
    expect(fontFormatToCss('woff2')).toBe('woff2')
  })
})

describe('fontContentType', () => {
  it('返回对应 MIME', () => {
    expect(fontContentType('ttf')).toBe('font/ttf')
    expect(fontContentType('otf')).toBe('font/otf')
    expect(fontContentType('woff')).toBe('font/woff')
    expect(fontContentType('woff2')).toBe('font/woff2')
  })
})
