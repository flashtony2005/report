import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateJobId, submitPrintJob } from './client'
import type { PrintJobRequest } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generateJobId', () => {
  it('格式为 MMDD + 6 位随机，共 10 位数字', () => {
    const id = generateJobId(new Date('2026-08-13T10:00:00'))
    expect(id).toHaveLength(10)
    expect(id).toMatch(/^\d{10}$/)
    // 今日 08-13 → 前缀 0813
    expect(id.startsWith('0813')).toBe(true)
  })

  it('随机尾段为 6 位（不足前补 0）', () => {
    const id = generateJobId(new Date('2026-01-05T00:00:00'))
    expect(id.startsWith('0105')).toBe(true)
    expect(id.slice(4)).toMatch(/^\d{6}$/)
  })

  it('多次调用尾段大概率不同', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(generateJobId().slice(4))
    // 50 次抽样几乎必然出现碰撞以外的情况；极端碰撞属概率事件，放宽到 >=49 唯一
    expect(seen.size).toBeGreaterThanOrEqual(49)
  })
})

describe('submitPrintJob 自动任务号', () => {
  function stubPrint(capture?: { body?: unknown }) {
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (capture) capture.body = init?.body ? JSON.parse(String(init.body)) : undefined
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true, jobId: 'SRV-123' }),
      } as Response
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  const baseJob: PrintJobRequest = {
    taskName: 't',
    printer: '',
    format: 'pdf',
    encoding: 'base64',
    content: 'x',
    pages: 1,
    width: 210,
    height: 297,
    copies: 1,
    orientation: 'portrait',
    duplex: false,
    color: true,
  }

  it('未传 jobId 时自动生成 10 位 MMDD+随机', async () => {
    const cap: { body?: unknown } = {}
    stubPrint(cap)
    const res = await submitPrintJob(baseJob, 'http://x:18888')
    const body = cap.body as { jobId?: string }
    expect(body.jobId).toMatch(/^\d{10}$/)
    // 服务端回传优先
    expect(res.jobId).toBe('SRV-123')
  })

  it('已传 jobId 时原样透传', async () => {
    const cap: { body?: unknown } = {}
    stubPrint(cap)
    const res = await submitPrintJob({ ...baseJob, jobId: 'CUSTOM-1' }, 'http://x:18888')
    const body = cap.body as { jobId?: string }
    expect(body.jobId).toBe('CUSTOM-1')
    expect(res.jobId).toBe('SRV-123')
  })
})
