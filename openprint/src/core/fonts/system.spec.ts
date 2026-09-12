import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findSystemFontFamily } from './system'
import { useSystemFonts } from '@/design/composables/useSystemFonts'

/** 模拟 fetch 返回系统字体清单 */
function mockFontFetch(fonts: unknown[]): typeof fetch {
  const fn = vi.fn(async () => {
    const payload = JSON.stringify({ ok: true, count: fonts.length, fonts })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true, count: fonts.length, fonts }),
      text: async () => payload,
      headers: new Headers({ 'content-type': 'application/json' }),
    } as Response
  })
  return fn as unknown as typeof fetch
}

beforeEach(() => {
  vi.unstubAllGlobals()
  // 重置模块级单例（clear 把 fonts 清空，state 归 idle）
  useSystemFonts().clear()
})

describe('useSystemFonts', () => {
  it('未加载前 ready=false、count=0', () => {
    const sf = useSystemFonts()
    expect(sf.ready.value).toBe(false)
    expect(sf.count.value).toBe(0)
  })

  it('加载成功后 ready=true、按 family 聚合', async () => {
    const sf = useSystemFonts()
    vi.stubGlobal(
      'fetch',
      mockFontFetch([
        { family: 'Arial', format: 'ttf', path: 'C:/Fonts/arial.ttf', size: 100 },
        { family: 'Arial', format: 'ttf', path: 'C:/Fonts/arialbd.ttf', size: 100 },
        { family: 'Segoe UI', format: 'ttf', path: 'C:/Fonts/segoe.ttf', size: 100 },
      ]),
    )
    const ok = await sf.load()
    expect(ok).toBe(true)
    expect(sf.ready.value).toBe(true)
    // 3 个条目按 family 聚合成 2 组
    expect(sf.count.value).toBe(2)
    const arial = sf.grouped.value.find((g) => g.family === 'Arial')
    expect(arial?.entries.length).toBe(2)
  })

  it('客户端不可达时 ready=false 且清单为空', async () => {
    const sf = useSystemFonts()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))))
    const ok = await sf.load()
    expect(ok).toBe(false)
    expect(sf.ready.value).toBe(false)
    expect(sf.state.value).toBe('offline')
    expect(sf.count.value).toBe(0)
  })

  it('systemFontFaceCss 输出指向客户端的 @font-face', async () => {
    const sf = useSystemFonts()
    vi.stubGlobal(
      'fetch',
      mockFontFetch([{ family: 'Arial', format: 'ttf', path: 'C:/Fonts/arial.ttf', size: 1 }]),
    )
    await sf.load()
    const css = sf.systemFontFaceCss(['Arial'])
    expect(css).toContain('font-family:"Arial"')
    expect(css).toContain('/api/fonts/data?path=')
    expect(css).toContain('format("truetype")')
  })

  it('过滤指定 family 才输出对应 @font-face', async () => {
    const sf = useSystemFonts()
    vi.stubGlobal(
      'fetch',
      mockFontFetch([
        { family: 'Arial', format: 'ttf', path: 'C:/a.ttf', size: 1 },
        { family: 'Tahoma', format: 'ttf', path: 'C:/t.ttf', size: 1 },
      ]),
    )
    await sf.load()
    const css = sf.systemFontFaceCss(['Arial'])
    expect(css).toContain('Arial')
    expect(css).not.toContain('Tahoma')
  })

  it('clear 把状态复位', async () => {
    const sf = useSystemFonts()
    vi.stubGlobal(
      'fetch',
      mockFontFetch([{ family: 'X', format: 'ttf', path: 'x', size: 1 }]),
    )
    await sf.load()
    expect(sf.ready.value).toBe(true)
    sf.clear()
    expect(sf.ready.value).toBe(false)
    expect(sf.state.value).toBe('idle')
    expect(sf.count.value).toBe(0)
  })
})

describe('findSystemFontFamily', () => {
  it('按族名返回 FontFamilyDef（兼容引号/逗号 fallback）', async () => {
    const sf = useSystemFonts()
    vi.stubGlobal(
      'fetch',
      mockFontFetch([{ family: 'Arial', format: 'ttf', path: 'C:/a.ttf', size: 1 }]),
    )
    await sf.load()
    const def = findSystemFontFamily('"Arial", sans-serif')
    expect(def?.family).toBe('Arial')
    expect(def?.faces[0]!.src).toContain('/api/fonts/data?path=')
  })

  it('未找到时返回 undefined', () => {
    expect(findSystemFontFamily('NotExists')).toBeUndefined()
  })
})
