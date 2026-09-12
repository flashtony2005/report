import { describe, it, expect } from 'vitest'
import { extractJson } from './generate'
import { normalizeTemplate } from './normalize'
import { validateTemplate } from '@/core/spec/validator'

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
    const tpl = normalizeTemplate(raw)
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
    const tpl = normalizeTemplate({
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
    const tpl = normalizeTemplate(raw)
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
    const tpl = normalizeTemplate(raw)
    const body = tpl.document.sections.find((s) => s.type === 'body')!
    expect(body.components![0]!.left).toBe(0)
    expect(body.components![1]!.left).toBe(10) // 保持原值，未被偏移
  })
})
