import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listPrinters } from './client'
import { FALLBACK_PRINT_DPI, MIN_PRINT_DPI, clampDpi, resolvePrintDpi } from './dpi'

const BASE = 'http://127.0.0.1:18888'

/** 模拟 fetch 返回 JSON（参考 print-client-data.spec.ts 模式） */
function mockFetch(response: unknown) {
  const fn = vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => response,
      text: async () => JSON.stringify(response),
      headers: new Headers({ 'content-type': 'application/json' }),
    } as Response
  })
  return fn as unknown as typeof fetch
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('listPrinters —— defaultDpi 归一化', () => {
  it('客户端上报 defaultDpi/maxDpi 原样透传', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ok: true,
        printers: [
          { name: 'HP Laser', driver: 'HP', defaultDpi: 600, maxDpi: 1200, status: 'idle' },
          { name: 'GP-C58', driver: 'GP', defaultDpi: 203, maxDpi: 203, status: 'idle' },
        ],
      }),
    )
    const printers = await listPrinters(BASE)
    expect(printers[0]).toMatchObject({ name: 'HP Laser', defaultDpi: 600, maxDpi: 1200 })
    expect(printers[1]).toMatchObject({ name: 'GP-C58', defaultDpi: 203, maxDpi: 203 })
  })

  it('defaultDpi 缺失回退 300（≈旧固定 288dpi 档）', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ok: true, printers: [{ name: '旧客户端打印机', maxDpi: 600 }] }),
    )
    const printers = await listPrinters(BASE)
    expect(printers[0]!.defaultDpi).toBe(FALLBACK_PRINT_DPI)
  })

  it('defaultDpi 超过 maxDpi 时钳到 maxDpi（脏数据兜底）', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ok: true, printers: [{ name: '脏数据', defaultDpi: 1200, maxDpi: 203 }] }),
    )
    const printers = await listPrinters(BASE)
    expect(printers[0]!.defaultDpi).toBe(203)
  })

  it('defaultDpi/maxDpi 全缺失：300 / 0（0 = 无上限）', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true, printers: [{ name: '裸打印机' }] }))
    const printers = await listPrinters(BASE)
    expect(printers[0]).toMatchObject({ defaultDpi: 300, maxDpi: 0 })
  })
})

describe('clampDpi —— DPI 钳制', () => {
  it('合法值原样（取整）', () => {
    expect(clampDpi(600, 2400)).toBe(600)
    expect(clampDpi(203.4, 600)).toBe(203)
  })

  it('超过 maxDpi 钳到 maxDpi', () => {
    expect(clampDpi(3000, 2400)).toBe(2400)
  })

  it('maxDpi 缺失/非法（<=0）视为无上限，仅钳下限', () => {
    expect(clampDpi(3000, 0)).toBe(3000)
    expect(clampDpi(3000, undefined)).toBe(3000)
  })

  it('低于下限钳到 MIN_PRINT_DPI；非法值回退 300', () => {
    expect(clampDpi(10, 2400)).toBe(MIN_PRINT_DPI)
    expect(clampDpi(Number.NaN, 2400)).toBe(FALLBACK_PRINT_DPI)
  })
})

describe('resolvePrintDpi —— 打印 DPI 决策', () => {
  const printer = { defaultDpi: 600, maxDpi: 2400 }

  it('手动合法值优先', () => {
    expect(resolvePrintDpi(1200, printer)).toBe(1200)
  })

  it('手动值 0/null/undefined → 打印机 defaultDpi', () => {
    expect(resolvePrintDpi(0, printer)).toBe(600)
    expect(resolvePrintDpi(null, printer)).toBe(600)
    expect(resolvePrintDpi(undefined, printer)).toBe(600)
  })

  it('无打印机信息 → 回退 300', () => {
    expect(resolvePrintDpi(null, null)).toBe(FALLBACK_PRINT_DPI)
    expect(resolvePrintDpi(null, undefined)).toBe(FALLBACK_PRINT_DPI)
  })

  it('手动值超 maxDpi 被钳制', () => {
    expect(resolvePrintDpi(3000, printer)).toBe(2400)
  })

  it('票据机：手动 600 超票据 maxDpi 203 → 203', () => {
    expect(resolvePrintDpi(600, { defaultDpi: 203, maxDpi: 203 })).toBe(203)
  })

  it('打印机 defaultDpi 异常（0）→ 手动合法值；都异常 → 300', () => {
    expect(resolvePrintDpi(300, { defaultDpi: 0, maxDpi: 0 })).toBe(300)
    expect(resolvePrintDpi(null, { defaultDpi: 0, maxDpi: 0 })).toBe(FALLBACK_PRINT_DPI)
  })
})
