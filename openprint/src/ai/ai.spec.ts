import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractJson, generateTemplate } from './generate'
import { normalizeTemplate, VALID_TYPES } from './normalize'
import { validateTemplate } from '@/core/spec/validator'
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'

// 选区改写路径要发真请求 —— 把流式客户端换掉，只验编排逻辑
const streamChatMock = vi.fn()
vi.mock('./client', () => ({
  streamChat: (...a: unknown[]) => streamChatMock(...(a as [])),
  AiRequestError: class AiRequestError extends Error {
    status = 0
  },
}))

describe('AI 核心：JSON 提取', () => {
  it('从 ```json 代码块提取', () => {
    const text = '说明一下：\n```json\n{"version":"1.0.0","document":{"type":"report"}}\n```'
    const r = extractJson(text) as Record<string, unknown>
    expect(r.version).toBe('1.0.0')
  })

  it('从纯 JSON 提取', () => {
    const r = extractJson('{"a":1}') as Record<string, unknown>
    expect(r.a).toBe(1)
  })

  it('从夹带散文的文本中提取首尾花括号', () => {
    const text = '好的，这是模板：{"document":{"type":"report","sections":[{"type":"body","components":[]}]}} 请查收'
    const r = extractJson(text) as Record<string, unknown>
    expect((r.document as Record<string, unknown>).type).toBe('report')
  })

  it('无 JSON 返回 null', () => {
    expect(extractJson('没有模板')).toBeNull()
  })
})

describe('AI 核心：归一化 + 协议校验', () => {
  it('补齐缺省字段并产出可通过校验的模板', () => {
    const raw = {
      document: {
        page: { width: 100, height: 150, orientation: 'portrait' },
        sections: [
          {
            type: 'body',
            components: [
              { type: 'text', left: 0, top: 0, width: 84, height: 12, value: '标题' },
            ],
          },
        ],
      },
    }
    const { value: tpl } = normalizeTemplate(raw)
    expect(tpl.version).toBe('1.0.0')
    expect(tpl.document.type).toBe('report')
    // 缺省 unit 应为 mm，margin 应有默认值
    expect(tpl.document.page.unit).toBe('mm')
    expect(tpl.document.page.margin.top).toBeGreaterThanOrEqual(0)
    // 控件被自动补 id
    const body = tpl.document.sections.find((s) => s.type === 'body')!
    expect(body.components![0]!.id).toBeTruthy()

    const result = validateTemplate(tpl)
    expect(result.valid).toBe(true)
  })

  it('横向页（width>height）推导 orientation', () => {
    const { value: tpl } = normalizeTemplate({
      document: {
        page: { width: 297, height: 210 },
        sections: [{ type: 'body', components: [] }],
      },
    })
    expect(tpl.document.page.orientation).toBe('landscape')
  })

  it('坐标纠偏：page-origin 输出被还原为 content-relative', () => {
    const raw = {
      document: {
        page: { width: 100, height: 150, margin: { top: 8, bottom: 8, left: 8, right: 8 } },
        sections: [
          {
            type: 'body',
            components: [
              { type: 'text', left: 8, top: 8, width: 84, height: 12, value: '标题' },
              { type: 'text', left: 8, top: 30, width: 84, height: 8, value: '正文' },
            ],
          },
        ],
      },
    }
    const { value: tpl } = normalizeTemplate(raw)
    const body = tpl.document.sections.find((s) => s.type === 'body')!
    // 双轴最小坐标命中 margin(8) → 统一减去页边距，消除整页右移
    expect(body.components![0]!.left).toBe(0)
    expect(body.components![0]!.top).toBe(0)
    expect(body.components![1]!.top).toBeCloseTo(22, 6)
    const result = validateTemplate(tpl)
    expect(result.valid).toBe(true)
  })

  it('坐标纠偏：正确 content-relative 模板不应被误伤', () => {
    const raw = {
      document: {
        page: { width: 100, height: 150, margin: { top: 8, bottom: 8, left: 8, right: 8 } },
        sections: [
          {
            type: 'body',
            components: [
              { type: 'text', left: 0, top: 0, width: 84, height: 12, value: '标题' },
              { type: 'text', left: 10, top: 20, width: 74, height: 8, value: '正文' },
            ],
          },
        ],
      },
    }
    const { value: tpl } = normalizeTemplate(raw)
    const body = tpl.document.sections.find((s) => s.type === 'body')!
    expect(body.components![0]!.left).toBe(0)
    expect(body.components![1]!.left).toBe(10) // 保持原值，未被偏移
  })
})

/* ============================ 丢弃必须上报 ============================ */

function compsOf(tpl: TemplateData<AnyControl>): AnyControl[] {
  return (tpl.document.sections.find((s) => s.type === 'body')?.components ?? []) as AnyControl[]
}

function mkTpl(type: string, id?: string): unknown {
  return {
    document: {
      page: { width: 100, height: 150 },
      sections: [
        {
          type: 'body',
          components: [{ ...(id ? { id } : {}), type, left: 0, top: 0, width: 40, height: 20 }],
        },
      ],
    },
  }
}

describe('AI 归一化：丢弃必须上报（不能静默）', () => {
  // 现状：这 4 类 AI 层刻意不处理 —— 不是协议不支持（schema 与 ControlType 里都有），
  // 而是 AI 不理解它们的载荷，宁可别碰。**刻意窄不要紧，静默丢才要紧。**
  // 若哪天有意放宽白名单：改这里 + 改提示词 + 改 droppedNotice 文案。
  it('白名单外的类型：控件确实被丢掉，但必须出现在 dropped 里（带 kind/type/id/原因）', () => {
    for (const t of ['chart', 'math', 'signature', 'labelgrid']) {
      const { value, dropped } = normalizeTemplate(mkTpl(t, `c-${t}`))
      expect(compsOf(value)).toEqual([])
      expect(dropped).toHaveLength(1)
      expect(dropped[0]).toMatchObject({ kind: 'control', type: t, id: `c-${t}` })
      expect(dropped[0]!.reason).toContain(t)
    }
  })

  it('白名单内的类型：既留下、也不上报', () => {
    for (const t of VALID_TYPES) {
      const { value, dropped } = normalizeTemplate(mkTpl(t))
      expect(compsOf(value).map((c) => c.type)).toEqual([t])
      expect(dropped).toEqual([])
    }
  })

  it('整节类型拼错：同样上报（否则那节会凭空消失）', () => {
    const { dropped } = normalizeTemplate({
      document: {
        page: { width: 100, height: 150 },
        sections: [{ type: 'bogus', components: [] }, { type: 'body', components: [] }],
      },
    })
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ kind: 'section', type: 'bogus' })
  })

  it('无丢弃时 dropped 是空数组（不是 undefined，调用方不必判空）', () => {
    expect(normalizeTemplate(mkTpl('text')).dropped).toEqual([])
  })
})

describe('AI 编排：选区改写把丢弃透出来（喂给 diff 防误删）', () => {
  const settings = { baseURL: 'https://x/v1', apiKey: 'k', model: 'm', enabled: true }

  beforeEach(() => {
    streamChatMock.mockReset()
  })

  it('模型返回不支持的类型 → controls 里没有它，但 dropped 里有（带 id）', async () => {
    streamChatMock.mockResolvedValue(
      JSON.stringify([
        { id: 'a1', type: 'text', left: 0, top: 0, width: 30, height: 8 },
        { id: 'c1', type: 'chart', left: 0, top: 20, width: 40, height: 30 },
      ]),
    )
    const res = await generateTemplate({
      prompt: '对齐',
      selectedControls: [{ id: 'a1' }, { id: 'c1' }] as unknown as AnyControl[],
      settings,
    })
    expect(res.ok).toBe(true)
    expect(res.controls!.map((c) => c.id)).toEqual(['a1'])
    expect(res.dropped).toEqual([expect.objectContaining({ type: 'chart', id: 'c1' })])
  })

  it('全被丢掉时：文案要说「处理不了」，不能说成「模型没返回」', async () => {
    streamChatMock.mockResolvedValue(
      JSON.stringify([{ id: 'c1', type: 'chart', left: 0, top: 0, width: 40, height: 30 }]),
    )
    const res = await generateTemplate({
      prompt: '对齐',
      selectedControls: [{ id: 'c1' }] as unknown as AnyControl[],
      settings,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('处理不了')
    expect(res.dropped).toHaveLength(1)
  })

  it('模型真没返回控件数组时：才是「未返回」文案，且 dropped 为空', async () => {
    streamChatMock.mockResolvedValue('抱歉，我不明白')
    const res = await generateTemplate({
      prompt: '对齐',
      selectedControls: [{ id: 'a1' }] as unknown as AnyControl[],
      settings,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未返回有效的控件 JSON')
    expect(res.dropped).toEqual([])
  })

  // 整模板模式：丢弃算「这次输出不完整」，要和校验错误一样回喂重试；
  // 重试后仍不完整就明确失败，而不是交付一份悄悄少了东西的模板。
  it('整模板模式：模型用了不支持的类型 → 回喂重试，最终明确失败', async () => {
    streamChatMock.mockResolvedValue(
      JSON.stringify({
        document: {
          page: { width: 100, height: 150 },
          sections: [
            {
              type: 'body',
              components: [{ id: 'c1', type: 'chart', left: 0, top: 0, width: 40, height: 30 }],
            },
          ],
        },
      }),
    )
    const res = await generateTemplate({ prompt: '做一个图表面单', settings })
    expect(res.ok).toBe(false)
    expect(streamChatMock).toHaveBeenCalledTimes(2) // MAX_ATTEMPTS = 2，说明确实重试了
    // 失败文案要点出「哪个类型、为什么」，不能只说「校验失败」
    expect(res.error).toContain('chart')
    expect(res.error).toContain('不在 AI 可处理的类型里')
    // 回喂给模型的那条消息里必须带上原因（否则模型没机会改）
    const msgs = streamChatMock.mock.calls[1]![0]!.messages as Array<{
      role: string
      content: string
    }>
    expect(msgs.at(-1)!.content).toContain('不在 AI 可处理的类型里')
  })
})
