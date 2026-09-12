import { describe, expect, it } from 'vitest'

import {
  createDemoTemplate,
  DEMO_CONTENT_WIDTH,
} from '@/repository/mock/data/demo-template'

describe('createDemoTemplate —— 示例模板结构校验', () => {
  const t = createDemoTemplate()

  it('A4 纵向页面（210×297mm）', () => {
    expect(t.document.page.width).toBe(210)
    expect(t.document.page.height).toBe(297)
    expect(t.document.page.unit).toBe('mm')
  })

  it('正文含明细表，绑定数据源 items', () => {
    const body = t.document.sections.find((s) => s.type === 'body')
    expect(body).toBeDefined()
    const table = (body!.components as unknown as Array<Record<string, unknown>>).find((c) => c.type === 'table')
    expect(table).toBeDefined()
    expect(table!.dataSource).toBe('items')
  })

  it('明细表含合计行', () => {
    const body = t.document.sections.find((s) => s.type === 'body')
    const table = (body!.components as unknown as Array<Record<string, unknown>>).find((c) => c.type === 'table')
    expect((table!.options as { summaryRow?: unknown })?.summaryRow).toBeTruthy()
  })

  it('明细表列宽之和 = 内容区宽度', () => {
    const body = t.document.sections.find((s) => s.type === 'body')
    const table = (body!.components as unknown as Array<Record<string, unknown>>).find((c) => c.type === 'table')
    const cols = table!.columns as Array<{ width?: number }>
    const sum = cols.reduce((s, c) => s + (c.width ?? 0), 0)
    expect(sum).toBe(DEMO_CONTENT_WIDTH)
  })

  it('页眉页脚分区存在', () => {
    const types = t.document.sections.map((s) => s.type)
    expect(types).toContain('header')
    expect(types).toContain('footer')
  })
})
