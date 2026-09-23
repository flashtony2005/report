/**
 * `dataset-fetch.ts` —— URL 取数。**全程 stub 掉 `fetch`**，不发真请求。
 *
 * 这里要钉的是一条**静默失败**：取数失败时**不能**退化成空表。
 * 空表和「接口真的返回了 0 行」在界面上长得一模一样，
 * 而后者是正常的、前者是错误 —— 分不清就等于没有错误处理。
 *
 * 另一条是 CORS：`fetch` 跨域被挡时只抛 `TypeError: Failed to fetch`，
 * **浏览器刻意不告诉 JS 到底是跨域、DNS 还是断网**。所以文案里必须把
 * 「这是浏览器直连、可能是 CORS、可以改用文件导入」说清楚，
 * 否则用户拿着「Failed to fetch」无从下手。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { DatasetParseError } from './dataset-import'
import { datasetFileNameFor, fetchDatasetFromUrl } from './dataset-fetch'

const ORIG_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIG_FETCH
})

/** 造一个够用的 Response */
function res(
  body: string,
  opts: { status?: number; statusText?: string; contentType?: string } = {},
): Response {
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: opts.statusText ?? '',
    headers: new Headers(opts.contentType ? { 'content-type': opts.contentType } : {}),
    blob: async () => new Blob([body]),
    text: async () => body,
  } as unknown as Response
}

function stubFetch(fn: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: string | URL) =>
    Promise.resolve(fn(String(input)))) as typeof fetch
}

describe('datasetFileNameFor —— 后缀判定顺序', () => {
  it('URL 后缀优先，Content-Type 不参与', () => {
    expect(datasetFileNameFor('http://a/sales.csv', 'application/json')).toBe('sales.csv')
  })

  it('URL 没后缀 → 用 Content-Type 补', () => {
    expect(datasetFileNameFor('http://a/api/sales', 'application/json')).toBe('sales.json')
    expect(datasetFileNameFor('http://a/api/sales', 'text/csv; charset=utf-8')).toBe('sales.csv')
  })

  it('URL 取不到名字 → 中性名 + Content-Type 后缀', () => {
    expect(datasetFileNameFor('http://a/', 'application/json')).toBe('data.json')
  })

  it('⚠️ 两边都认不出 → 报错，**不猜格式**', () => {
    expect(() => datasetFileNameFor('http://a/api/sales', 'application/octet-stream')).toThrow(
      DatasetParseError,
    )
    // 错误里要说清「收到了什么」，不然用户不知道去哪儿改
    expect(() => datasetFileNameFor('http://a/api/sales', 'application/octet-stream')).toThrow(
      /octet-stream/,
    )
  })

  it('⚠️ 不认识的 URL 后缀**不**被当成后缀（`.php` 之类）', () => {
    // 认不出就用 Content-Type，而不是硬当成某种格式
    expect(datasetFileNameFor('http://a/report.php', 'text/csv')).toBe('report.php.csv')
  })
})

describe('fetchDatasetFromUrl —— 成功路径', () => {
  it('CSV：拿到行，且带上是哪个文件来的', async () => {
    stubFetch(() => res('城市,金额\n上海,1234.5\n', { contentType: 'text/csv' }))
    const out = await fetchDatasetFromUrl('http://a/sales.csv')
    expect(out.fileName).toBe('sales.csv')
    expect(out.columns).toEqual(['城市', '金额'])
    expect(out.rows).toEqual([{ 城市: '上海', 金额: 1234.5 }])
  })

  it('JSON：不做数值推断（与 CSV 口径相反）', async () => {
    stubFetch(() => res('[{"金额":"1234.5"}]', { contentType: 'application/json' }))
    const out = await fetchDatasetFromUrl('http://a/sales')
    expect(out.rows).toEqual([{ 金额: '1234.5' }])
  })
})

describe('fetchDatasetFromUrl —— 失败一律报错，绝不空表', () => {
  it('⚠️ 跨域 / 断网（fetch 抛 TypeError）→ 可读文案，且提到 CORS 与文件导入', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    let msg = ''
    try {
      await fetchDatasetFromUrl('http://other/api/sales.csv')
    } catch (e) {
      expect(e).toBeInstanceOf(DatasetParseError)
      msg = (e as Error).message
    }
    expect(msg).toContain('Failed to fetch')
    expect(msg).toContain('CORS')
    expect(msg).toContain('文件导入')
  })

  it('⚠️ HTTP 非 2xx → 报错并带上状态码', async () => {
    stubFetch(() => res('nope', { status: 404, statusText: 'Not Found' }))
    await expect(fetchDatasetFromUrl('http://a/sales.csv')).rejects.toThrow(/HTTP 404/)
  })

  it('⚠️ 空地址 → 报错（不发请求）', async () => {
    let called = 0
    stubFetch(() => {
      called += 1
      return res('')
    })
    await expect(fetchDatasetFromUrl('   ')).rejects.toThrow(/请先填地址/)
    expect(called).toBe(0)
  })

  it('⚠️ 格式认不出时**先报错、再去读 body**（省一次下载）', async () => {
    let blobRead = 0
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        blob: async () => {
          blobRead += 1
          return new Blob(['x'])
        },
      } as unknown as Response)) as typeof fetch
    await expect(fetchDatasetFromUrl('http://a/api/sales')).rejects.toThrow(DatasetParseError)
    expect(blobRead).toBe(0)
  })

  it('⚠️ 内容是坏的 JSON → 报错（不是空表）', async () => {
    stubFetch(() => res('[1,2', { contentType: 'application/json' }))
    await expect(fetchDatasetFromUrl('http://a/sales.json')).rejects.toThrow(DatasetParseError)
  })
})
