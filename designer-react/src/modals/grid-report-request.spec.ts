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

/**
 * 页面设置**不是开关，是模板内容** —— 所以它必须进 `rawTemplate`。
 *
 * 这一组守的是一个**真实踩过的坑**（与上面那条同源，但更隐蔽）：
 * `withPage` 跑在 `rawTemplate` 快照**之后**，而 `ReportOptions` 里根本没有
 * 纸张 / 页码这几个字段，于是页面设置**永远到不了存盘文件**。
 * 症状：存了 A3，重新打开显示「不指定」，再一保存就真把纸张抹掉了 ——
 * 而每一步都不报错。
 */
describe('页面设置：必须进 rawTemplate（options 里没有这几个字段）', () => {
  const SETUP = { paper: 'A3', orientation: 'landscape', page_number: '{page}/{pages}' }
  /** 「只配纸张、不开分页」—— 这是新面板最容易走的那条路 */
  const SETUP_ONLY = { rows_per_page: 0, ...SETUP }

  it('只配纸张（不开分页）：rawTemplate 与请求体上都带页面设置', () => {
    const out = req({ page: SETUP_ONLY })
    expect(out.rawTemplate.sheets[0]!.page).toMatchObject(SETUP)
    expect(out.req.template.sheets[0]!.page).toMatchObject(SETUP)
  })

  it('只配纸张时**不套** withPage —— 否则 rows_per_page 被抬成 1，报表切成每页 1 行', () => {
    // `withPage` 的 0→1 兜底是给「开关打开却没填行数」用的。
    // 用在这里会把一张只想换纸的报表切碎，而且不报错。
    const out = req({ page: SETUP_ONLY })
    expect(out.req.template.sheets[0]!.page?.rows_per_page).toBe(0)
    expect(out.rawTemplate.sheets[0]!.page?.rows_per_page).toBe(0)
  })

  it('页面设置 + 分页同时配：分页只进 options 与请求体，rawTemplate 里是 0', () => {
    // 与服务端 `apply_options`（`rows_per_page.filter(|v| *v > 0)`）对齐：
    // 存盘只存开关，打开时服务端再套一次 —— 两条路才等价。
    const out = req({ page: { rows_per_page: 3, repeat_header_rows: 1, ...SETUP } })
    expect(out.options.rowsPerPage).toBe(3)
    expect(out.rawTemplate.sheets[0]!.page?.rows_per_page).toBe(0) // 存盘那份：分页没套
    expect(out.rawTemplate.sheets[0]!.page).toMatchObject(SETUP) // 但纸张在
    expect(out.req.template.sheets[0]!.page?.rows_per_page).toBe(3) // 请求那份：套了
    expect(out.req.template.sheets[0]!.page).toMatchObject(SETUP)
  })

  it('options 里不含页面设置字段 —— 它是模板属性，别「顺手」加进开关', () => {
    // **契约**用例。`ReportOptions` 一旦加上 paper，就会出现
    // 「options 里存了一份、服务端不读」的两处真相源，迟早漂。
    const keys = Object.keys(req({ page: SETUP_ONLY }).options)
    for (const k of ['paper', 'orientation', 'page_number', 'margin_mm', 'center_horizontally']) {
      expect(keys, `options 里不该有 ${k}`).not.toContain(k)
    }
  })

  it('自由模板忽略页面设置 —— 那条路的面板本来就不显示，别以为接上了', () => {
    // free 分支在 `withPageSetup` **之前**就 return 了。现在 UI 上
    // `mode !== 'free'` 才显示页面设置面板，所以用户配不出来；
    // 哪天有人在 free 模式下也把面板打开，这条会红，提醒他补这条线。
    const out = req({ mode: 'free', grid: [[{ value: 'x' }]], page: SETUP_ONLY })
    expect(out.req.template.sheets[0]!.page ?? null).toBeNull()
    expect(out.rawTemplate.sheets[0]!.page ?? null).toBeNull()
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
