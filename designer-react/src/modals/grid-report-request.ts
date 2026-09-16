/**
 * 渲染请求的组装：模板 + 数据源声明 → `POST /api/report/render` 的请求体。
 *
 * ## 为什么单独成模块，而且做成**纯函数**
 *
 * 这段逻辑原先长在 `GridReportModal` 里（160 行，闭包读 22 处 state）。
 * 它出过一个**只有实测才发现得了**的 bug —— 分页开关在实时渲染上从未生效：
 * `page` 算出来了、开关也画了，却**没往模板上套**（见 `withPage` 的注释）。
 * 而 `GridReportModal` 当时**一个测试都没有** —— bug 和「没测试」落在同一个文件上。
 *
 * 抽成纯函数后，「请求体长什么样」可以直接断言，不必拉起 antd + Univer + fetch。
 * 输入就是原先那个 `useCallback` 的依赖数组 —— 它本来就是这段逻辑的全部输入，
 * 所以这次搬迁是**等价的**，不是重写。
 *
 * ## 两条约定，改动时别踩
 *
 * 1. **`rawTemplate` 必须是后处理之前的那份。** 它和 `options` 一起存盘，
 *    打开报表时由服务端 `store::apply_options` 再套一次；存「已经套过的模板」
 *    会重复施加，而且用户就改不了开关了。
 * 2. **选项要套到模板上才算数。** 请求体是 `{ template, dump, sources }`，
 *    **不带 `options`** —— 服务端只读 `template.sheets[*].page` 这类字段。
 *    往 `options` 里塞一个字段、却没在模板上体现，等于没写。
 */
import {
  buildCrossTemplate,
  buildDetailTemplate,
  buildGroupTemplate,
  gridToSheet,
  headerRowCount,
  parseParams,
  withExpandControl,
  withExportFormula,
  withLoopField,
  withPage,
  type AggType,
  type CellFormatSpec,
  type PageConfig,
  type RenderRequest,
  type ReportOptions,
  type ReportTemplate,
  type TemplateGrid,
} from '@/report/grid-report'
import type { DbEngine } from '@/core/print-client/types'

export type TemplateMode = 'sample' | 'group' | 'cross' | 'canvas' | 'free'

/** 画布里选中的表格控件（`canvas` 模式用）；只用到这两个字段，收窄成结构类型 */
export interface CanvasTableLike {
  type: string
  columns?: Array<{ title?: string; field?: string }>
}

/** 模板构建的三种结果：内置样例 / 可提交请求 / 校验错误 */
export type BuildResult =
  | { kind: 'sample' }
  | {
      kind: 'request'
      req: RenderRequest
      headerRows: number
      /**
       * 未经后处理的原始模板 + 选项。
       * 保存报表文件时用这一对：存开关本身，而不是存「开关已经套上去」的模板——
       * 否则打开时再套一次就重复了，而且用户改不了开关。
       */
      rawTemplate: ReportTemplate
      options: ReportOptions
    }
  | { kind: 'error'; message: string }

/** `buildRequest` 的全部输入 = 原先那个 `useCallback` 的依赖数组 */
export interface RenderRequestInput {
  mode: TemplateMode
  canvasTable?: CanvasTableLike
  groupFields: string[]
  valueField: string
  groupAgg: AggType
  rowFields: string[]
  colFields: string[]
  crossValueFields: string[]
  crossAgg: AggType
  aliases: Record<string, string>
  valueFormats: Record<string, CellFormatSpec>
  where: string
  paramText: string
  /** 分页配置；`undefined` = 不分页（见 `withPage`） */
  page?: PageConfig
  exportFormula: boolean
  expandMin: number
  expandMax: number
  keepExpandEmpty: boolean
  dump: boolean
  loopField: string
  dbSelection: { database?: string; table?: string; engine?: DbEngine }
  grid: TemplateGrid
}

/**
 * 组装渲染请求。
 *
 * - `sample`：用服务端内置样例（不连库）
 * - `error`：校验不通过，带一句给用户看的话
 * - `request`：可直接提交给 `/api/report/render` 的完整请求
 */
export function buildRenderRequest(input: RenderRequestInput): BuildResult {
  const {
    mode,
    canvasTable,
    groupFields,
    valueField,
    groupAgg,
    rowFields,
    colFields,
    crossValueFields,
    crossAgg,
    aliases,
    valueFormats,
    where,
    paramText,
    page,
    exportFormula,
    expandMin,
    expandMax,
    keepExpandEmpty,
    dump,
    loopField,
    dbSelection,
    grid,
  } = input

  if (mode === 'sample') return { kind: 'sample' }

  const dsName = 'ds1'
  let template: ReportTemplate
  if (mode === 'free') {
    const tpl = { sheets: [gridToSheet(grid, '自由模板')] }
    if (tpl.sheets[0].rows.length === 0) {
      return { kind: 'error', message: '模板是空的：先在格子里填内容或绑定字段' }
    }
    // 只套导出公式。
    // **不套 withExpandControl**：那个函数按「最内/最外层」猜层级，
    // 而自由模板的主格层级是用户一格一格定好的，让它再猜一遍会覆盖用户意图。
    // **也不套 withPage**：free 分支的 options 只存导出公式 / 调试两项，
    // 分页开关既进不了存盘文件也进不了请求（UI 上那个开关也据此不显示）。
    // 循环变量是**模板的一部分**（不在 options 里），所以必须进 rawTemplate 才存得住
    const looped = withLoopField(tpl, loopField)
    template = withExportFormula(looped, exportFormula)
    const rawTemplate = looped
    const opts: ReportOptions = {
      exportFormula: exportFormula || undefined,
      dump: dump || undefined,
    }
    const { database: db1, table: tb1, engine: eg1 } = dbSelection
    if (!db1 || !tb1) return { kind: 'error', message: '请先在数据源里选择库和表' }
    const p1 = parseParams(paramText)
    if (!p1.ok) return { kind: 'error', message: p1.message ?? '参数不合法' }
    return {
      kind: 'request',
      req: {
        template,
        dump: dump ? true : undefined,
        sources: [
          {
            name: dsName,
            database: db1,
            engine: eg1,
            table: tb1,
            where: where.trim() || undefined,
            params: p1.params?.length ? p1.params : undefined,
          },
        ],
      },
      headerRows: 0,
      rawTemplate,
      options: opts,
    }
  } else if (mode === 'canvas') {
    if (!canvasTable?.columns?.length) {
      return { kind: 'error', message: '请先在画布里选中一个带字段列的表格控件' }
    }
    template = buildDetailTemplate({
      sheetName: '画布明细表',
      ds: dsName,
      columns: canvasTable.columns,
      aliases,
      valueFormats,
      title: '画布表格明细',
    })
  } else if (mode === 'cross') {
    if (rowFields.length === 0 || colFields.length === 0 || crossValueFields.length === 0) {
      return { kind: 'error', message: '交叉表需要至少一个行字段、一个列字段和一个数值字段' }
    }
    template = buildCrossTemplate({
      sheetName: '交叉表',
      ds: dsName,
      rowFields,
      colFields,
      valueFields: crossValueFields,
      agg: crossAgg,
      aliases,
      valueFormats,
      // 这里**不传 page**：构造器会把它丢掉（`buildCrossTemplate` 的返回值
      // 没有 `page` 字段），传了反而让人以为分页已经接上了。
      // 分页统一由下面的 `withPage(template, page)` 后处理，见该函数注释。
      title: `${rowFields.join('/')} × ${colFields.join('/')}`,
    })
  } else {
    if (groupFields.length === 0 || !valueField) {
      return { kind: 'error', message: '请选择至少一个分组字段和一个数值字段' }
    }
    template = buildGroupTemplate({
      sheetName: '分组汇总',
      ds: dsName,
      groupFields,
      valueField,
      agg: groupAgg,
      aliases,
      valueFormats,
      title: `${groupFields.join(' / ')} · ${valueField} 汇总`,
    })
  }

  // 循环变量是**模板的一部分**（不在 options 里），必须落在 rawTemplate 里才存得住
  template = withLoopField(template, loopField)

  // 存原样：打开报表时由服务端按 options 再套一次
  const rawTemplate = template
  const opts: ReportOptions = {
    rowsPerPage: page?.rows_per_page,
    repeatHeaderRows: page?.repeat_header_rows,
    repeatFooterRows: page?.repeat_footer_rows,
    exportFormula: exportFormula || undefined,
    expandMinCount: expandMin || undefined,
    expandMaxCount: expandMax || undefined,
    keepExpandEmpty: keepExpandEmpty || undefined,
    dump: dump || undefined,
  }

  // 导出公式 / 展开控制 / 分页：统一后处理，不动三个构造器的签名。
  // **必须在 rawTemplate 之后** —— 存盘只存开关，打开报表时由服务端
  // `apply_options` 再套一次，两条路才等价。
  template = withExportFormula(template, exportFormula)
  template = withExpandControl(template, {
    minCount: expandMin,
    maxCount: expandMax,
    keepEmpty: keepExpandEmpty,
  })
  template = withPage(template, page)

  const { database, table, engine } = dbSelection
  if (!database || !table) return { kind: 'error', message: '请先在数据源里选择库和表' }

  // 参数框是 JSON 数组；空串按「无参数」处理
  const parsed = parseParams(paramText)
  if (!parsed.ok) return { kind: 'error', message: parsed.message ?? '参数不合法' }
  const params = parsed.params?.length ? parsed.params : undefined
  const whereClause = where.trim() ? where.trim() : undefined

  return {
    kind: 'request',
    req: {
      template,
      dump: dump ? true : undefined,
      sources: [{ name: dsName, database, engine, table, where: whereClause, params }],
    },
    headerRows: headerRowCount(template),
    rawTemplate,
    options: opts,
  }
}
