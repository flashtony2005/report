import { describe, it, expect } from 'vitest'
import { MARKET_TEMPLATES, MARKET_CATEGORY_LABEL } from './market-templates'
import { render } from '@/core/sdk'
import type { AnyControl, TableControl, ChartControl } from '@/types/control'

function findTemplate(id: string) {
  const t = MARKET_TEMPLATES.find((t) => t.id === id)
  if (!t) throw new Error(`template ${id} not found`)
  return t
}

function bodyControls(id: string): AnyControl[] {
  const tpl = findTemplate(id).build()
  const body = tpl.document.sections.find((s) => s.type === 'body')
  if (!body) throw new Error('no body section')
  return body.components
}

describe('market-financial-report 模板', () => {
  it('在模板市场中存在且为 A4', () => {
    const t = findTemplate('market-financial-report')
    expect(t.category).toBe('report')
    expect(t.pageW).toBe(210)
    expect(t.pageH).toBe(297)
  })

  it('包含 4 张 KPI 指标卡 + 3 张图表 + 1 张明细表', () => {
    const c = bodyControls('market-financial-report')
    const rects = c.filter((x) => x.type === 'rect')
    const charts = c.filter((x) => x.type === 'chart') as ChartControl[]
    const tables = c.filter((x) => x.type === 'table') as TableControl[]
    // 4 张 KPI 卡各 2 个色块（底 + 顶条）= 8，外加说明框 = 9
    expect(rects.length).toBeGreaterThanOrEqual(9)
    // bar / pie / line
    expect(charts.map((ch) => ch.kind).sort()).toEqual(['bar', 'line', 'pie'])
    expect(tables.length).toBe(1)
  })

  it('明细表内嵌数据 + 自定义合计（含衍生利润率）', () => {
    const c = bodyControls('market-financial-report')
    const table = c.find((x) => x.type === 'table') as TableControl
    expect(table.data).toBeDefined()
    expect(table.data!.length).toBe(5)
    expect(table.options?.summaryRow?.type).toBe('custom')
    // 营收合计应为 5 个分部之和
    const rows = table.data ?? []
    const sumRevenue = rows.reduce((s, r) => s + (r.revenue as number), 0)
    expect(sumRevenue).toBe(12860)
    // 净利润 KPI 与图表数据自洽：bar 营收序列合计 = 12860
    const bar = c.find((x) => x.type === 'chart' && x.kind === 'bar') as ChartControl
    expect(bar.series[0]!.data.reduce((a, b) => a + b, 0)).toBe(12860)
  })

  it('端到端渲染为单页，且含合计行与图表 SVG', async () => {
    const tpl = findTemplate('market-financial-report').build()
    const { html, pages, warnings } = await render({ template: tpl })
    // 单页报表 → 打印管线走 SVG 单页推送
    expect(pages).toBe(1)
    expect(html).toContain('合计')
    // 三张图表均输出 SVG
    expect((html.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(3)
    // 不应有"数据源非数组"类告警（明细表用内嵌 data，不依赖 dataSource）
    const fatal = warnings.filter((w) => w.code === 'DATASOURCE_NOT_ARRAY')
    expect(fatal).toEqual([])
  })
})

describe('市场模板坐标迁移（整页相对，2026-08-21）', () => {
  it('资产标签：body 首控件 left/top = 页面边距（内容回到边距线内）', () => {
    const tpl = findTemplate('market-asset-label').build()
    const page = tpl.document.page
    const body = tpl.document.sections.find((s) => s.type === 'body')!
    const first = body.components[0]!
    // 原内容区相对坐标 (0,0) 迁移后 = 边距 (left, top)
    expect(first.left).toBe(page.margin.left) // 2
    expect(first.top).toBe(page.margin.top) // 3
    // 内容最右不超页宽（留在边距内）
    const maxRight = Math.max(...body.components.map((c) => (c.left ?? 0) + (c.width ?? 0)))
    expect(maxRight).toBeLessThanOrEqual(page.width + 0.001)
  })

  it('A4 报表：body 控件整体右移/下移一个边距，不超出左上边距线', () => {
    const tpl = findTemplate('market-financial-report').build()
    const page = tpl.document.page
    const body = tpl.document.sections.find((s) => s.type === 'body')!
    for (const c of body.components) {
      if (c.type === 'zone' || c.type === 'labelgrid') continue
      expect(c.left ?? 0).toBeGreaterThanOrEqual((page.margin.left ?? 0) - 0.001)
      expect(c.top ?? 0).toBeGreaterThanOrEqual((page.margin.top ?? 0) - 0.001)
    }
  })
})

describe('模板市场新增：简历 / 合同 / 文档', () => {
  it('新增类目标签已注册', () => {
    expect(MARKET_CATEGORY_LABEL.resume).toBe('简历')
    expect(MARKET_CATEGORY_LABEL.contract).toBe('合同')
    expect(MARKET_CATEGORY_LABEL.doc).toBe('文档')
  })

  const ids = [
    'market-resume-it',
    'market-resume-finance',
    'market-resume-teacher',
    'market-resume-design',
    'market-resume-medical',
    'market-resume-general',
    'market-contract-labor',
    'market-contract-service',
    'market-contract-lease',
    'market-contract-nda',
    'market-doc-leave',
    'market-doc-notice',
  ]

  it.each(ids)('%s 在市场中可构建且为 A4 含正文内容', (id) => {
    const t = findTemplate(id)
    expect(t).toBeTruthy()
    expect(t.pageW).toBe(210)
    expect(t.pageH).toBe(297)
    const body = t.build().document.sections.find((s) => s.type === 'body')
    expect(body).toBeTruthy()
    expect((body as { components: unknown[] }).components.length).toBeGreaterThan(0)
  })

  it('劳动合同可端到端渲染且含签章文本', async () => {
    const tpl = findTemplate('market-contract-labor').build()
    const { html, pages, warnings } = await render({ template: tpl })
    expect(pages).toBeGreaterThanOrEqual(1)
    expect(html).toContain('劳动合同')
    expect(html).toContain('盖章')
    expect(warnings.filter((w) => w.code === 'DATASOURCE_NOT_ARRAY')).toEqual([])
  })

  it('简历可端到端渲染且含姓名', async () => {
    const tpl = findTemplate('market-resume-it').build()
    const { html, pages } = await render({ template: tpl })
    expect(pages).toBeGreaterThanOrEqual(1)
    expect(html).toContain('张伟')
  })
})
