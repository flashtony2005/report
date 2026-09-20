/**
 * `buildRenderRequest` 的用例。
 *
 * 这个文件存在的理由是一个**真实发生过的 bug**：分页开关在实时渲染上从未生效。
 * `page` 算出来了、UI 也画了，却**没往模板上套**；而服务端只读
 * `template.sheets[*].page`（请求体里根本没有 `options`），于是 `pages` 永远为空。
 * 现象上「界面没反应」和「请求没带参数」长得一模一样，靠人看是分不出来的。
 *
 * 所以下面的核心用例是**正面断言模板上真的有 `page`**，而不是「没报错」。
 * 这也是把这段逻辑从 `GridReportModal`（当时零测试）搬出来的唯一目的。
 */
import { describe, expect, it } from 'vitest'
import {
  buildRenderRequest,
  type RenderRequestInput,
  type TemplateMode,
} from './grid-report-request'
import type { CellTpl, ReportTemplate } from '@/report/grid-report'

const PAGE = { rows_per_page: 3, repeat_header_rows: 1, repeat_footer_rows: 0 }

/** 一份能通过校验的入参；各用例只覆盖自己关心的那几项 */
function base(over: Partial<RenderRequestInput> = {}): RenderRequestInput {
  return {
    mode: 'group',
    groupFields: ['city'],
    valueField: 'amount',
    groupAgg: 'sum',
    rowFields: [],
    colFields: [],
    crossValueFields: [],
    crossAgg: 'sum',
    aliases: {},
    valueFormats: {},
    where: '',
    paramText: '',
    exportFormula: false,
    expandMin: 0,
    expandMax: 0,
    keepExpandEmpty: false,
    dump: false,
    loopField: '',
    dbSelection: { database: 'demo.db', table: 'orders', engine: 'sqlite' },
    grid: [],
    ...over,
  }
}

/** 取请求结果；不是 request 就**抛错**，别让用例静默退化成空转 */
function req(over: Partial<RenderRequestInput> = {}) {
  const out = buildRenderRequest(base(over))
  if (out.kind !== 'request') {
    throw new Error(`期望 request，实际是 ${out.kind}`)
  }
  return out
}

function allCells(tpl: ReportTemplate): CellTpl[] {
  return tpl.sheets.flatMap((s) => s.rows.flatMap((r) => r.cells))
}

/** 三种「构造器」模式：它们都要靠 `withPage` 后处理，构造器自己不管分页 */
const BUILDER_MODES: Array<[TemplateMode, Partial<RenderRequestInput>]> = [
  ['group', {}],
  ['cross', { rowFields: ['city'], colFields: ['month'], crossValueFields: ['amount'] }],
  ['canvas', { canvasTable: { type: 'table', columns: [{ field: 'city' }] } }],
]

describe('分页：必须套到模板上（这个 bug 真实发生过）', () => {
  for (const [mode, over] of BUILDER_MODES) {
    it(`${mode} 模式：开了分页，每张 sheet 上都有 page`, () => {
      const out = req({ mode, page: PAGE, ...over })
      const sheets = out.req.template.sheets
      expect(sheets.length).toBeGreaterThan(0)
      for (const s of sheets) expect(s.page).toEqual(PAGE)
    })

    it(`${mode} 模式：不开分页就不写 page`, () => {
      const out = req({ mode, page: undefined, ...over })
      expect(out.req.template.sheets[0]!.page ?? null).toBeNull()
    })
  }

  it('options 里的分页与模板上的 page 同源，不会两处各算一遍', () => {
    const out = req({ page: PAGE })
    expect(out.options.rowsPerPage).toBe(3)
    expect(out.options.repeatHeaderRows).toBe(1)
    expect(out.options.repeatFooterRows).toBe(0)
    expect(out.req.template.sheets[0]!.page).toEqual(PAGE)
  })

  it('自由模板不套分页 —— 它的 options 本来就不存分页（UI 上也据此不显示开关）', () => {
    const out = req({ mode: 'free', grid: [[{ value: 'x' }]], page: PAGE })
    expect(out.req.template.sheets[0]!.page ?? null).toBeNull()
    expect(out.options.rowsPerPage).toBeUndefined()
  })
})

describe('rawTemplate：存盘只存开关，服务端再套一次', () => {
  it('rawTemplate 是**后处理之前**的那份（不带 page / 不带展开控制）', () => {
    const out = req({ page: PAGE, expandMin: 5 })
    // 提交给服务端渲染的那份：套过了
    expect(out.req.template.sheets[0]!.page).toEqual(PAGE)
    expect(allCells(out.req.template).some((c) => c.model?.expand_min_count === 5)).toBe(true)
    // 存盘的那份：没套
    expect(out.rawTemplate.sheets[0]!.page ?? null).toBeNull()
    expect(allCells(out.rawTemplate).every((c) => c.model?.expand_min_count == null)).toBe(true)
  })

  it('循环变量是**模板的一部分**，所以要进 rawTemplate 才存得住', () => {
    const out = req({ loopField: 'region' })
    expect(out.rawTemplate.sheets[0]!.loop_field).toBe('region')
    expect(out.req.template.sheets[0]!.loop_field).toBe('region')
  })
})

describe('后处理搬家后一步都没少', () => {
  it('导出公式：带 value_expr 的格被打上 export_formula', () => {
    const out = req({ exportFormula: true })
    const withExpr = allCells(out.req.template).filter((c) => c.model?.value_expr)
    expect(withExpr.length).toBeGreaterThan(0)
    for (const c of withExpr) expect(c.model!.export_formula).toBe(true)
  })

  it('不开导出公式时一个都不打', () => {
    const out = req({ exportFormula: false })
    expect(allCells(out.req.template).every((c) => c.model?.export_formula == null)).toBe(true)
  })

  it('展开控制：最少行数打**最内层**、最多条数打**最外层**', () => {
    // 两级分组：region 外层、city 内层。打反了语义就变了
    // （「每组至少 5 行」会变成「至少 5 个分组」）。
    const out = req({ groupFields: ['region', 'city'], expandMin: 5, expandMax: 10 })
    const byField = (f: string) =>
      allCells(out.req.template).find((c) => c.model?.field === f)!.model!
    expect(byField('city').expand_min_count).toBe(5)
    expect(byField('region').expand_max_count).toBe(10)
  })
})

describe('校验与早退分支', () => {
  it('内置样例不组请求', () => {
    expect(buildRenderRequest(base({ mode: 'sample' }))).toEqual({ kind: 'sample' })
  })

  it('分组模式缺字段 → 带一句给用户看的话', () => {
    const out = buildRenderRequest(base({ groupFields: [], valueField: '' }))
    expect(out).toEqual({ kind: 'error', message: '请选择至少一个分组字段和一个数值字段' })
  })

  it('交叉表缺字段 → error', () => {
    const out = buildRenderRequest(base({ mode: 'cross' }))
    expect(out.kind).toBe('error')
  })

  it('画布模式没选中带字段列的表格 → error', () => {
    const out = buildRenderRequest(base({ mode: 'canvas' }))
    expect(out.kind).toBe('error')
  })

  it('自由模板是空的 → error', () => {
    const out = buildRenderRequest(base({ mode: 'free', grid: [] }))
    expect(out.kind).toBe('error')
  })

  it('没选库/表 → error（放在最后，前面的模板构造照做）', () => {
    const out = buildRenderRequest(base({ dbSelection: {} }))
    expect(out).toEqual({ kind: 'error', message: '请先在数据源里选择库和表' })
  })

  it('参数框不是 JSON 数组 → error', () => {
    const out = buildRenderRequest(base({ paramText: '{oops' }))
    expect(out.kind).toBe('error')
  })

  it('参数框为空串 → 不带 params（而不是空数组）', () => {
    const out = req({ paramText: '' })
    expect(out.req.sources![0]!.params).toBeUndefined()
  })

  it('WHERE 为空 → 不带 where；有内容则 trim 后带上', () => {
    expect(req({ where: '   ' }).req.sources![0]!.where).toBeUndefined()
    expect(req({ where: ' amount > 0 ' }).req.sources![0]!.where).toBe('amount > 0')
  })

  it('dump 只在开启时进请求体', () => {
    expect(req({ dump: false }).req.dump).toBeUndefined()
    expect(req({ dump: true }).req.dump).toBe(true)
  })
})
