import { describe, expect, it } from 'vitest'
import {
  buildCrossTemplate,
  buildDetailTemplate,
  buildGroupTemplate,
  cellPos,
  colName,
  DEFAULT_FIELD_LABELS,
  headerRowCount,
  labelOf,
  parseParams,
  colIndex,
  clearGridMerge,
  deleteGridCol,
  deleteGridRow,
  emptyGrid,
  formatCellText,
  gridToSheet,
  gridToWorkbookData,
  insertGridCol,
  insertGridRow,
  isMergeAnchor,
  mergeAt,
  mergeSpanOf,
  PARENT_HIGHLIGHT,
  PARENT_STYLE_ID,
  parentChainOf,
  parentPosOf,
  parentTreeOf,
  parseCellText,
  parsePos,
  SEMANTIC_LEGEND,
  semanticBgOf,
  SELECTED_STYLE_ID,
  setGridCell,
  setGridMerge,
  stripArrayPrefix,
  templateToGrid,
  toWorkbookData,
  validateTemplate,
  withExpandControl,
  withExportFormula,
  type CellTpl,
  type ReportTemplate,
  type TplNode,
} from './grid-report'

describe('位置名', () => {
  it('列下标转 Excel 列名', () => {
    expect(colName(0)).toBe('A')
    expect(colName(25)).toBe('Z')
    expect(colName(26)).toBe('AA')
  })

  it('行列转位置名', () => {
    expect(cellPos(0, 0)).toBe('A1')
    expect(cellPos(2, 3)).toBe('D3')
  })

  it('去掉 items[]. 前缀', () => {
    expect(stripArrayPrefix('items[].amount')).toBe('amount')
    expect(stripArrayPrefix('items.amount')).toBe('amount')
    expect(stripArrayPrefix('amount')).toBe('amount')
  })
})

describe('字段中文别名映射', () => {
  it('显式别名 > 内置别名 > 字段原名', () => {
    expect(labelOf('region')).toBe('地区')
    expect(labelOf('region', { region: '大区' })).toBe('大区')
    expect(labelOf('unknown_col')).toBe('unknown_col')
  })

  it('内置别名表覆盖常见业务字段', () => {
    expect(DEFAULT_FIELD_LABELS.city).toBe('城市')
    expect(DEFAULT_FIELD_LABELS.amount).toBe('金额')
  })

  it('分组模板的表头与小计标签用中文别名', () => {
    const rows = buildGroupTemplate({
      groupFields: ['region', 'city', 'salesman'],
      valueField: 'amount',
      aliases: { city: '地市' },
    }).sheets[0]!.rows
    // 表头：显式别名 city→地市，未指定的走内置表
    expect(rows[0]!.cells.map((c) => c.value)).toEqual(['地区', '地市', '销售员', '金额'])
    // 小计 / 合计标签也跟着中文化
    expect(rows[2]!.cells[1]!.value).toBe('地市小计')
    expect(rows[3]!.cells[0]!.value).toBe('地区合计')
  })

  it('交叉表的行/列/数值表头与「xx合计」都用别名', () => {
    const rows = buildCrossTemplate({
      rowFields: ['region'],
      colFields: ['month'],
      valueFields: ['amount'],
      aliases: { month: '销售月份' },
    }).sheets[0]!.rows
    expect(rows[0]!.cells[0]!.value).toBe('地区')
    expect(rows[0]!.cells[2]!.value).toBe('金额合计')
    expect(headerRowCount({ sheets: [{ name: 'x', rows }] })).toBe(1)
    void DEFAULT_FIELD_LABELS
  })
})

describe('参数输入解析', () => {
  it('空串 → 空参数', () => {
    expect(parseParams('   ')).toEqual({ ok: true, params: [] })
  })

  it('JSON 数组原样通过', () => {
    expect(parseParams('["华东", 1000]')).toEqual({ ok: true, params: ['华东', 1000] })
  })

  it('非数组 / 非法 JSON 报错', () => {
    expect(parseParams('{"a":1}').ok).toBe(false)
    expect(parseParams('华东').ok).toBe(false)
    expect(parseParams('[1,').message).toContain('合法 JSON')
  })
})

describe('分组汇总模板', () => {
  it('三级分组：主格链 + 小计 + 合计 + 总计', () => {
    const tpl = buildGroupTemplate({
      sheetName: '销售分组汇总',
      ds: 'ds1',
      groupFields: ['region', 'city', 'salesman'],
      valueField: 'amount',
      title: '2026 年销售分组汇总表',
    })
    const rows = tpl.sheets[0]!.rows
    // 标题 + 表头 + 明细 + 城市小计 + 地区合计 + 总计
    expect(rows).toHaveLength(6)

    // 明细行：A3/B3/C3 行展开且链式挂父格，D3 取数值挂 C3
    const detail = rows[2]!.cells
    expect(detail[0]!.model).toMatchObject({ field: 'region', expand_type: 'r' })
    expect(detail[1]!.model).toMatchObject({ field: 'city', expand_type: 'r', row_parent: 'A3' })
    expect(detail[2]!.model).toMatchObject({ field: 'salesman', expand_type: 'r', row_parent: 'B3' })
    expect(detail[3]!.model).toMatchObject({ field: 'amount', row_parent: 'C3' })

    // 城市小计：D3[B3:+0].sum()
    const citySub = rows[3]!.cells
    expect(citySub[1]!.value).toBe('城市小计')
    expect(citySub[3]!.model!.value_expr).toBe('D3[B3:+0].sum()')

    // 地区合计
    const regionSub = rows[4]!.cells
    expect(regionSub[0]!.value).toBe('地区合计')
    expect(regionSub[3]!.model!.value_expr).toBe('D3[A3:+0].sum()')

    // 总计
    expect(rows[5]!.cells[3]!.model!.value_expr).toBe('D3.sum()')
  })

  it('单级分组：不产生与总计重复的小计行', () => {
    const rows = buildGroupTemplate({
      groupFields: ['region'],
      valueField: 'amount',
    }).sheets[0]!.rows
    // 表头 + 明细 + 总计
    expect(rows).toHaveLength(3)
    expect(rows[2]!.cells[1]!.model!.value_expr).toBe('B2.sum()')
    // 总计标签不能被数值格覆盖（单级分组时只有 1 个分组列可用）
    expect(rows[2]!.cells[0]!.value).toBe('总计')
  })

  it('分组内数值必须聚合，否则小计/总计全错', () => {
    const rows = buildGroupTemplate({
      groupFields: ['region', 'city'],
      valueField: 'amount',
    }).sheets[0]!.rows
    // 明细行数值格声明 agg=sum（华东下有 4 个城市，只取首行会显示 12,000 而非 37,900）
    expect(rows[1]!.cells[2]!.model).toMatchObject({ field: 'amount', agg: 'sum' })
  })

  it('聚合方式可切换（如按次数计数）', () => {
    const rows = buildGroupTemplate({
      groupFields: ['region'],
      valueField: 'amount',
      agg: 'count',
    }).sheets[0]!.rows
    expect(rows[1]!.cells[1]!.model).toMatchObject({ field: 'amount', agg: 'count' })
  })

  it('标题行横向铺到行尾', () => {
    const rows = buildGroupTemplate({
      groupFields: ['a', 'b'],
      valueField: 'v',
      title: '标题',
    }).sheets[0]!.rows
    expect(rows[0]!.cells[0]!.merge_to_end).toBe(true)
  })
})

describe('画布表格 → 明细表模板', () => {
  it('首列行展开，其余列取字段并挂首列', () => {
    const tpl = buildDetailTemplate({
      ds: 'ds1',
      columns: [
        { title: '姓名', field: 'items[].name' },
        { title: '金额', field: 'items[].amount' },
      ],
      title: '画布表格明细',
    })
    const rows = tpl.sheets[0]!.rows
    expect(rows).toHaveLength(3)
    expect(rows[1]!.cells.map((c) => c.value)).toEqual(['姓名', '金额'])
    const detail = rows[2]!.cells
    expect(detail[0]!.model).toMatchObject({ expand_type: 'r' })
    expect(detail[0]!.model!.field).toBeUndefined()
    expect(detail[1]!.model).toMatchObject({ field: 'amount', row_parent: 'A3' })
  })

  it('没有字段列时报错', () => {
    expect(() => buildDetailTemplate({ columns: [{ title: '静态列' }] })).toThrow()
  })
})

describe('交叉表模板', () => {
  it('单值字段：列展开 + 行展开 + 行/列合计 + 总计', () => {
    const tpl = buildCrossTemplate({
      ds: 'ds1',
      rowFields: ['region'],
      colFields: ['month'],
      valueFields: ['amount'],
      title: '交叉表',
    })
    const rows = tpl.sheets[0]!.rows
    // 标题 + 列头 + 明细 + 合计行
    expect(rows).toHaveLength(4)

    // 列头：A2 行字段表头，B2 月份列展开，C2 金额合计（列号由 col_after 推算）
    const head = rows[1]!.cells
    expect(head[0]!.value).toBe('地区')
    expect(head[1]!.model).toMatchObject({ field: 'month', expand_type: 'c' })
    expect(head[2]!.value).toBe('金额合计')
    expect(head[2]!.model).toMatchObject({ col_after: 'B2' })

    // 明细：A3 地区行展开，B3 金额挂 (A3, B2)，C3 行合计
    const detail = rows[2]!.cells
    expect(detail[0]!.model).toMatchObject({ field: 'region', expand_type: 'r' })
    expect(detail[1]!.model).toMatchObject({
      field: 'amount',
      agg: 'sum',
      row_parent: 'A3',
      col_parent: 'B2',
    })
    expect(detail[2]!.model).toMatchObject({
      row_parent: 'A3',
      col_after: 'B2',
      value_expr: 'B3[A3:+0].sum()',
    })

    // 合计行：B4 列合计沿列主格链汇总，C4 总计
    const total = rows[3]!.cells
    expect(total[0]!.value).toBe('合计')
    expect(total[1]!.model).toMatchObject({ col_parent: 'B2', value_expr: 'B3[B2:+0].sum()' })
    expect(total[2]!.model).toMatchObject({ col_after: 'B2', value_expr: 'B3.sum()' })
  })

  it('双值字段：第一行列头纵向合并，第二行是金额/数量指标子表头', () => {
    const rows = buildCrossTemplate({
      rowFields: ['region'],
      colFields: ['month'],
      valueFields: ['amount', 'qty'],
    }).sheets[0]!.rows
    // 列头 + 指标子表头 + 明细 + 合计行
    expect(rows).toHaveLength(4)

    // 行字段表头纵跨两行；合计表头同样纵跨
    expect(rows[0]!.cells[0]!.value).toBe('地区')
    expect(rows[0]!.cells[0]!.merge_down).toBe(1)
    expect(rows[0]!.cells[1]!.model).toMatchObject({ field: 'month', expand_type: 'c' })
    expect(rows[0]!.cells[3]!.value).toBe('金额合计')
    expect(rows[0]!.cells[3]!.model).toMatchObject({ col_after: 'B1' })
    expect(rows[0]!.cells[3]!.merge_down).toBe(1)
    expect(rows[0]!.cells[4]!.value).toBe('数量合计')

    // 指标子表头：金额 / 数量，各自挂最深列展开格
    expect(rows[1]!.cells.map((c) => c.value)).toEqual([undefined, '金额', '数量'])
    expect(rows[1]!.cells[1]!.model).toMatchObject({ col_parent: 'B1' })

    // 明细：A3 地区 | B3 金额 | C3 数量 | D3 金额行合计 | E3 数量行合计
    const detail = rows[2]!.cells
    expect(detail[3]!.model).toMatchObject({ col_after: 'B1', value_expr: 'B3[A3:+0].sum()' })
    expect(detail[4]!.model).toMatchObject({ col_after: 'D3', value_expr: 'C3[A3:+0].sum()' })
  })

  it('多级列字段：逐层 col_parent 链式，合计跟最深一层之后', () => {
    const rows = buildCrossTemplate({
      rowFields: ['region'],
      colFields: ['year', 'month'],
      valueFields: ['amount'],
    }).sheets[0]!.rows
    // 两层列头 + 明细 + 合计行
    expect(rows).toHaveLength(4)

    // 第一行列头：行字段表头纵跨两行 + 年份列展开 + 金额合计（同样纵跨）
    expect(rows[0]!.cells[0]!.value).toBe('地区')
    expect(rows[0]!.cells[0]!.merge_down).toBe(1)
    expect(rows[0]!.cells[1]!.model).toMatchObject({ field: 'year', expand_type: 'c' })
    expect(rows[0]!.cells[3]!.value).toBe('金额合计')
    expect(rows[0]!.cells[3]!.model).toMatchObject({ col_after: 'C2' })

    // 第二行列头：月份挂年份
    expect(rows[1]!.cells[2]!.model).toMatchObject({ field: 'month', expand_type: 'c', col_parent: 'B1' })
    // 数值格挂最深列格 C2
    expect(rows[2]!.cells[2]!.model).toMatchObject({ col_parent: 'C2' })
    expect(rows[2]!.cells[3]!.model).toMatchObject({ col_after: 'C2' })
  })

  it('totals=false 时不产生合计行列', () => {
    const rows = buildCrossTemplate({
      rowFields: ['region'],
      colFields: ['month'],
      valueFields: ['amount'],
      totals: false,
    }).sheets[0]!.rows
    expect(rows).toHaveLength(2)
    expect(rows[1]!.cells).toHaveLength(2)
  })

  it('缺字段时报错', () => {
    expect(() => buildCrossTemplate({ rowFields: [], colFields: ['m'], valueFields: ['v'] })).toThrow()
    expect(() => buildCrossTemplate({ rowFields: ['r'], colFields: [], valueFields: ['v'] })).toThrow()
    expect(() => buildCrossTemplate({ rowFields: ['r'], colFields: ['m'], valueFields: [] })).toThrow()
  })
})

describe('展开结果 → Univer 工作簿', () => {
  it('rowspan/colspan 转成 mergeData', () => {
    const data = toWorkbookData({
      name: 't',
      rows: [
        [
          { text: '标题', pos: 'A1', rowspan: 1, colspan: 3 },
          { text: '', pos: '', rowspan: 1, colspan: 1 },
          { text: '', pos: '', rowspan: 1, colspan: 1 },
        ],
        [
          { text: '地区', pos: 'A2', rowspan: 2, colspan: 1 },
          { text: '金额', pos: 'B2', rowspan: 1, colspan: 1 },
        ],
      ],
    })
    const sheet = data.sheets.sheet1
    expect(sheet.mergeData).toEqual([
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 },
      { startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 },
    ])
    expect(sheet.cellData[0]![0]!.v).toBe('标题')
    // 列数不足时补到 10，保证 Univer 有足够的空白列可用
    expect(sheet.columnCount).toBe(10)
  })

  it('headerRows 指定的行套表头样式，其余行不套', () => {
    const data = toWorkbookData(
      {
        name: 't',
        rows: [
          [
            { text: '地区', pos: 'A1', rowspan: 1, colspan: 1 },
            { text: '金额', pos: 'B1', rowspan: 1, colspan: 1 },
          ],
          [
            { text: '华东', pos: 'A2', rowspan: 1, colspan: 1 },
            { text: '100', pos: 'B2', rowspan: 1, colspan: 1 },
          ],
        ],
      },
      { headerRows: 1 },
    )
    const sheet = data.sheets.sheet1
    expect(sheet.cellData[0]![0]!.s).toBe('grid-hdr')
    expect(sheet.cellData[1]![0]!.s).toBeUndefined()
    expect(data.styles['grid-hdr']).toMatchObject({ bl: 1, ht: 2 })
  })

  it('headerRowCount 数到第一个行展开格为止', () => {
    const group = buildGroupTemplate({
      groupFields: ['region'],
      valueField: 'amount',
      title: '标题',
    })
    // 标题 + 表头
    expect(headerRowCount(group)).toBe(2)
    const cross = buildCrossTemplate({
      rowFields: ['region'],
      colFields: ['year', 'month'],
      valueFields: ['amount'],
      title: '标题',
    })
    // 标题 + 两层列头
    expect(headerRowCount(cross)).toBe(3)
  })
})

/** 收集模板里所有带数值格式的格子（位置 / 字段 / 格式种类） */
function collectFormats(tpl: ReportTemplate): Array<{ pos: string; field?: string; kind: string }> {
  const out: Array<{ pos: string; field?: string; kind: string }> = []
  tpl.sheets[0]!.rows.forEach((r, ri) =>
    r.cells.forEach((c, ci) => {
      if (c.model?.format) {
        out.push({ pos: cellPos(ri, ci), field: c.model.field, kind: c.model.format.kind })
      }
    }),
  )
  return out
}

describe('数值列格式', () => {
  it('分组模板：明细 / 小计 / 总计三处都带上数值格式（同列口径一致）', () => {
    const tpl = buildGroupTemplate({
      groupFields: ['region', 'city'],
      valueField: 'amount',
      valueFormats: { amount: { kind: 'currency', code: 'CNY', digits: 2, thousands: true } },
      title: '标题',
    })
    const hits = collectFormats(tpl)
    expect(hits.length).toBe(3)
    expect(hits.every((h) => h.kind === 'currency')).toBe(true)
  })

  it('分组模板：未配置格式时不下发 format（服务端走全局兜底）', () => {
    const tpl = buildGroupTemplate({ groupFields: ['region'], valueField: 'amount' })
    expect(collectFormats(tpl).length).toBe(0)
    // 也不该留 undefined 键（否则 JSON 里会出现 "format": null 噪音）
    const raw = JSON.stringify(tpl)
    expect(raw.includes('"format"')).toBe(false)
  })

  it('交叉表模板：数值格 / 行合计 / 列合计 / 总计 全部套用，未配置的字段不受影响', () => {
    const tpl = buildCrossTemplate({
      rowFields: ['region'],
      colFields: ['year', 'month'],
      valueFields: ['amount', 'qty'],
      valueFormats: { amount: { kind: 'decimal', digits: 3, thousands: false } },
      title: '标题',
    })
    const hits = collectFormats(tpl)
    // amount 的：数值格 + 行合计 + 列合计 + 总计
    expect(hits.length).toBe(4)
    expect(hits.every((h) => h.kind === 'decimal')).toBe(true)
    // 只有数值格绑字段；三类合计格是 value_expr（无 field），但格式同样落地
    expect(hits.filter((h) => h.field === 'amount').length).toBe(1)
  })

  it('明细模板：只有配置了的列带格式', () => {
    const tpl = buildDetailTemplate({
      columns: [
        { title: '地区', field: 'items[].region' },
        { title: '金额', field: 'items[].amount' },
      ],
      valueFormats: { amount: { kind: 'int', thousands: true } },
    })
    const hits = collectFormats(tpl)
    expect(hits.length).toBe(1)
    expect(hits[0]!.kind).toBe('int')
    expect(hits[0]!.field).toBe('amount')
  })
})

describe('展开控制：min / max / keepEmpty 打在不同层级', () => {
  /** 三级分组：明细行是 A3(region) → B3(city) → C3(salesman) */
  const threeLevel = () =>
    buildGroupTemplate({
      ds: 'ds1',
      groupFields: ['region', 'city', 'salesman'],
      valueField: 'amount',
    })

  /**
   * 明细行 = 行展开格最多的那一行。
   * 不能写死下标：有没有 title 会让明细行的行号差 1。
   */
  const detailModels = (tpl: ReturnType<typeof threeLevel>) => {
    const rows = tpl.sheets[0]!.rows
    let best = rows[0]!
    for (const r of rows) {
      const n = r.cells.filter((c) => c.model?.expand_type === 'r').length
      if (n > best.cells.filter((c) => c.model?.expand_type === 'r').length) best = r
    }
    return best.cells.map((c) => c.model!)
  }

  it('minCount 只打在最内层（明细级），maxCount 只打在最外层', () => {
    const models = detailModels(withExpandControl(threeLevel(), { minCount: 5, maxCount: 10 }))

    // A3 最外层：拿 max，不拿 min
    expect(models[0]!.expand_max_count).toBe(10)
    expect(models[0]!.expand_min_count).toBeUndefined()
    // B3 中间层：两个都不拿
    expect(models[1]!.expand_max_count).toBeUndefined()
    expect(models[1]!.expand_min_count).toBeUndefined()
    // C3 最内层：拿 min，不拿 max
    expect(models[2]!.expand_min_count).toBe(5)
    expect(models[2]!.expand_max_count).toBeUndefined()
  })

  it('keepEmpty 打在所有行展开格上（空报表也要撑住表头）', () => {
    const models = detailModels(withExpandControl(threeLevel(), { keepEmpty: true }))
    expect(models.slice(0, 3).map((m) => m.keep_expand_empty)).toEqual([true, true, true])
    // 数值格不展开，不该被带上
    expect(models[3]!.keep_expand_empty).toBeUndefined()
  })

  it('0 / undefined 视为不限制，不写进模板', () => {
    const models = detailModels(withExpandControl(threeLevel(), { minCount: 0, maxCount: 0 }))
    expect(models[0]!.expand_max_count).toBeUndefined()
    expect(models[2]!.expand_min_count).toBeUndefined()
  })

  it('三个都不给时原样返回（同一个对象引用）', () => {
    const tpl = threeLevel()
    expect(withExpandControl(tpl, {})).toBe(tpl)
    expect(withExpandControl(tpl, { minCount: 0, maxCount: 0, keepEmpty: false })).toBe(tpl)
  })

  it('单级分组：min / max 落在同一个格上', () => {
    const tpl = buildGroupTemplate({ groupFields: ['region'], valueField: 'amount' })
    const m = withExpandControl(tpl, { minCount: 3, maxCount: 8 }).sheets[0]!.rows[1]!.cells[0]!
      .model!
    expect(m.expand_min_count).toBe(3)
    expect(m.expand_max_count).toBe(8)
  })

  it('交叉表：只作用于行展开格，列展开格不受影响', () => {
    const tpl = buildCrossTemplate({
      ds: 'ds1',
      rowFields: ['region'],
      colFields: ['month'],
      valueFields: ['amount'],
    })
    const out = withExpandControl(tpl, { minCount: 2, maxCount: 7, keepEmpty: true })
    // 交叉表里有纯字面量格（"地区" 这类表头）没有 model，`c.model!` 会骗过类型系统
    // 却把 undefined 混进数组，下一行读 expand_type 直接抛。
    const all = out.sheets[0]!.rows
      .flatMap((r) => r.cells.map((c) => c.model))
      .filter((m): m is NonNullable<typeof m> => !!m)
    const rowExp = all.filter((m) => m.expand_type === 'r')
    const colExp = all.filter((m) => m.expand_type === 'c')
    expect(rowExp.length).toBeGreaterThan(0)
    expect(colExp.length).toBeGreaterThan(0)
    expect(rowExp.every((m) => m.keep_expand_empty === true)).toBe(true)
    expect(rowExp.some((m) => m.expand_max_count === 7)).toBe(true)
    // 列展开格一个都没被带上
    expect(colExp.every((m) => m.keep_expand_empty === undefined)).toBe(true)
    expect(colExp.every((m) => m.expand_min_count === undefined)).toBe(true)
  })
})

describe('自由模板：per-cell 属性按格直设', () => {
  /**
   * 自由模板的提交链路是：网格 → `gridToSheet` → `withExportFormula`。
   * 任何一关重建了 model，设计器里设的 `expand_min_count` 就会被静默抹掉——
   * UI 上完全看不出来，渲染结果只是「没补空行」，用户会以为功能没做。
   *
   * 这一组就是守住这条链路：值设下去，就得活着发出去。
   */
  const submit = (grid: ReturnType<typeof emptyGrid>) => {
    const tpl = withExportFormula({ sheets: [gridToSheet(grid, '自由模板')] }, true)
    return tpl.sheets[0]!.rows[1]!.cells[0]!.model
  }

  it('设了就能活到提交', () => {
    const grid = emptyGrid(3, 2)
    grid[1][0] = { value: null, model: { ds: 'ds1', field: 'city', expand_type: 'r', expand_min_count: 5 } }
    expect(submit(grid)?.expand_min_count).toBe(5)
  })

  it('固定列表展开（expand_expr）活着走完提交', () => {
    const grid = emptyGrid(3, 2)
    grid[1][0] = {
      value: null,
      model: { ds: 'ds1', field: 'month', expand_type: 'r', expand_expr: '["1月","2月","3月"]' },
    }
    expect(submit(grid)?.expand_expr).toBe('["1月","2月","3月"]')
  })

  /**
   * `validateTemplate` 里两条「没有数据集 / 没有字段就报警」的规则都给
   * `expand_expr` 留了口子（写了它就不再要求 ds / field）。这个口子以前是**空头支票**——
   * 引擎根本不读 `expand_expr`，用户照着提示写完只会拿到一张静默出错的报表。
   * 现在引擎实现了，这条就是守住「提示别再骗人」。
   */
  it('写了 expand_expr 就不再催数据集 —— 引擎确实认它', () => {
    const grid = emptyGrid(3, 2)
    grid[1][0] = { value: null, model: { expand_type: 'r', expand_expr: '["1月","2月"]' } }
    const tpl = { sheets: [gridToSheet(grid, '自由模板')] }
    const warns = validateTemplate(tpl)
    expect(warns.filter((w) => w.includes('A2'))).toEqual([])
  })

  it('格上同时有 value_expr 时也要留住 —— withExportFormula 会重建 model', () => {
    const grid = emptyGrid(3, 2)
    grid[1][0] = {
      value: null,
      model: {
        ds: 'ds1',
        field: 'city',
        expand_type: 'r',
        expand_min_count: 4,
        value_expr: 'C2[A2:+0].sum()',
      },
    }
    const m = submit(grid)
    // 先确认确实走了「重建 model」那条分支，否则下面那条断言是空转
    expect(m?.export_formula).toBe(true)
    expect(m?.expand_min_count).toBe(4)
  })

  it('展示表达式 / 字典 / 数字格式 / 最多条数 / 空集保留 都活着走完提交', () => {
    const grid = emptyGrid(3, 2)
    grid[1][0] = {
      value: null,
      model: {
        ds: 'ds1',
        field: 'amount',
        expand_type: 'r',
        // 带 value_expr 才能逼 withExportFormula 走「重建 model」分支，
        // 否则这条测试测的是原样透传，什么都没守住
        value_expr: 'B2[A2:+0].sum()',
        format_expr: 'IF(value >= 1000, "大额", "小额")',
        dict: { '1': '是', '0': '否' },
        format: { kind: 'currency', digits: 1 },
        expand_max_count: 9,
        keep_expand_empty: true,
      },
    }
    const m = submit(grid)
    expect(m?.export_formula).toBe(true)
    expect(m?.format_expr).toBe('IF(value >= 1000, "大额", "小额")')
    expect(m?.dict).toEqual({ '1': '是', '0': '否' })
    // 嵌套对象也要整只活着，不能只剩 kind
    expect(m?.format).toEqual({ kind: 'currency', digits: 1 })
    expect(m?.expand_max_count).toBe(9)
    expect(m?.keep_expand_empty).toBe(true)
  })

  it('col_after / merge_to_end 也活着走完提交（且不互相串位）', () => {
    const grid = emptyGrid(3, 2)
    grid[1][0] = {
      value: null,
      model: { ds: 'ds1', field: 'amount', col_after: 'C1' },
      merge_to_end: true,
    }
    const tpl = withExportFormula({ sheets: [gridToSheet(grid, '自由模板')] }, true)
    const cell = tpl.sheets[0]!.rows[1]!.cells[0]!
    // col_after 是 model 字段
    expect(cell.model?.col_after).toBe('C1')
    // merge_to_end 是 CellTpl 字段，不在 model 里 —— 两条各走各的路，别串
    expect(cell.merge_to_end).toBe(true)
    expect((cell.model as Record<string, unknown>).merge_to_end).toBeUndefined()
  })
})

describe('自由模板：格文本 ↔ 语义', () => {
  it('字面量不套 {{}}', () => {
    expect(parseCellText('地区')).toEqual({ kind: 'literal', text: '地区' })
    expect(parseCellText('2026 年销售汇总')).toEqual({ kind: 'literal', text: '2026 年销售汇总' })
    expect(parseCellText('')).toEqual({ kind: 'literal', text: '' })
  })

  it('{{ds1.city}} → 字段绑定', () => {
    expect(parseCellText('{{ds1.city}}')).toEqual({ kind: 'field', ds: 'ds1', field: 'city' })
  })

  it('{{ds1.amount.sum()}} → 字段 + 聚合', () => {
    expect(parseCellText('{{ds1.amount.sum()}}')).toEqual({
      kind: 'field',
      ds: 'ds1',
      field: 'amount',
      agg: 'sum',
    })
  })

  it('{{D3[B3:+0].sum()}} → 表达式（不是字段）', () => {
    expect(parseCellText('{{D3[B3:+0].sum()}}')).toEqual({
      kind: 'expr',
      expr: 'D3[B3:+0].sum()',
    })
  })

  // `=` 是 NopReport / 润乾的惯例，也是 formatCellText 现在写出去的形式。
  // `{{}}` 仍然认（历史写法），但不再产出——两种写法只留一种。
  it('=ds1.city → 字段绑定', () => {
    expect(parseCellText('=ds1.city')).toEqual({ kind: 'field', ds: 'ds1', field: 'city' })
  })

  it('=ds1.amount.sum() → 字段 + 聚合', () => {
    expect(parseCellText('=ds1.amount.sum()')).toEqual({
      kind: 'field',
      ds: 'ds1',
      field: 'amount',
      agg: 'sum',
    })
  })

  it('=D3[B3:+0].sum() → 表达式（不是字段）', () => {
    expect(parseCellText('=D3[B3:+0].sum()')).toEqual({
      kind: 'expr',
      expr: 'D3[B3:+0].sum()',
    })
  })

  it('`=` 单独一个字符是字面量，不是空绑定', () => {
    // 跟 Univer `isFormulaString` 的 length > 1 判定对齐：
    // `=` 本身不是公式，也不该被我们当绑定吃掉
    expect(parseCellText('=')).toEqual({ kind: 'literal', text: '=' })
    expect(parseCellText('{{}}')).toEqual({ kind: 'literal', text: '{{}}' })
    expect(parseCellText('= ')).toEqual({ kind: 'literal', text: '= ' })
  })

  it('formatCellText 写出 `=` 方言，不再写 `{{}}`', () => {
    expect(formatCellText({ value: null, model: { ds: 'ds1', field: 'city' } })).toBe('=ds1.city')
    expect(formatCellText({ value: null, model: { ds: 'ds1', field: 'amount', agg: 'sum' } })).toBe(
      '=ds1.amount.sum()',
    )
    expect(formatCellText({ value: null, model: { ds: 'ds1', value_expr: 'D3[B3:+0].sum()' } })).toBe(
      '=D3[B3:+0].sum()',
    )
    // 字面量不加前缀，原样出去
    expect(formatCellText({ value: '地区', model: undefined })).toBe('地区')
  })

  it('两种写法解析结果一致（= 与 {{}} 等价）', () => {
    const pairs = ['ds1.city', 'ds1.amount.sum()', 'D3[B3:+0].sum()']
    for (const inner of pairs) {
      expect(parseCellText(`=${inner}`)).toEqual(parseCellText(`{{${inner}}}`))
    }
  })

  it('formatCellText 与 parseCellText 可往返', () => {
    const cases: CellTpl[] = [
      { value: '地区', model: undefined },
      { value: null, model: { ds: 'ds1', field: 'city', expand_type: 'r' } },
      { value: null, model: { ds: 'ds1', field: 'amount', agg: 'sum' } },
      { value: null, model: { ds: 'ds1', value_expr: 'D3[B3:+0].sum()' } },
    ]
    for (const c of cases) {
      const text = formatCellText(c)
      const back = parseCellText(text)
      // 字面量 / 表达式 / 字段都要能认回来
      if (c.model?.value_expr) expect(back).toEqual({ kind: 'expr', expr: c.model.value_expr })
      else if (c.model?.field) {
        expect(back).toMatchObject({ kind: 'field', ds: 'ds1', field: c.model.field })
      } else expect(back).toEqual({ kind: 'literal', text: '地区' })
    }
  })
})

describe('自由模板：位置名解析', () => {
  it('列名 → 下标 / 位置名 → 行列', () => {
    expect(colIndex('A')).toBe(0)
    expect(colIndex('Z')).toBe(25)
    expect(colIndex('AA')).toBe(26)
    expect(parsePos('A1')).toEqual({ r: 0, c: 0 })
    expect(parsePos('D3')).toEqual({ r: 2, c: 3 })
    expect(parsePos('nonsense')).toBeNull()
  })
})

describe('自由模板：插删行列要重映射引用', () => {
  /** 3×3 网格：A1 字面量；B2 绑 city 且左主格 A2；C2 值表达式 D3[B3:+0].sum() */
  function sample(): ReturnType<typeof templateToGrid> {
    const g = templateToGrid(
      {
        name: 't',
        rows: [
          { cells: [{ value: '标题', model: undefined }] },
          {
            cells: [
              { value: null, model: { ds: 'ds1', field: 'region', expand_type: 'r' } },
              {
                value: null,
                model: { ds: 'ds1', field: 'city', expand_type: 'r', row_parent: 'A2' },
              },
              {
                value: null,
                model: { ds: 'ds1', value_expr: 'D3[B3:+0].sum()', row_parent: 'B2' },
              },
            ],
          },
        ],
      },
      3,
      3,
    )
    return g
  }

  it('在第 1 行前插入一行：行引用整体 +1', () => {
    const g = insertGridRow(sample(), 0)
    // 在第 0 行前插入 → 原「标题」行降到第 1 行，region 那行降到第 2 行
    expect(g[1][0].model).toBeUndefined()
    expect(g[2][0].model?.field).toBe('region')
    // A2 → A3
    expect(g[2][1].model?.row_parent).toBe('A3')
    // B2 → B3；表达式里的 D3→D4、B3→B4
    expect(g[2][2].model?.row_parent).toBe('B3')
    expect(g[2][2].model?.value_expr).toBe('D4[B4:+0].sum()')
  })

  it('删除第 1 行：后面的 -1，指向被删行的引用清空', () => {
    const g = deleteGridRow(sample(), 0)
    // 原第 2 行升到第 1 行
    expect(g[0][0].model?.field).toBe('region')
    // row_parent 原 A2 → 现在 A1
    expect(g[0][1].model?.row_parent).toBe('A1')
    // 表达式 D3[B3:+0] → D2[B2:+0]
    expect(g[0][2].model?.value_expr).toBe('D2[B2:+0].sum()')
  })

  it('删除被引用的那一行：引用清空而不是错位', () => {
    const g = templateToGrid(
      {
        name: 't',
        rows: [
          { cells: [{ value: null, model: { ds: 'ds1', field: 'region', expand_type: 'r' } }] },
          {
            cells: [
              {
                value: null,
                model: { ds: 'ds1', field: 'city', expand_type: 'r', row_parent: 'A1' },
              },
            ],
          },
        ],
      },
      2,
      1,
    )
    // 删掉 A1（被 A2 认作主格的那一行）
    const out = deleteGridRow(g, 0)
    expect(out[0][0].model?.row_parent).toBeUndefined()
  })

  it('插列：列引用平移', () => {
    const g = insertGridCol(sample(), 0)
    // A2 → B2（原来的 region 格右移了一列）
    expect(g[1][0].model).toBeUndefined()
    expect(g[1][1].model?.field).toBe('region')
    expect(g[1][2].model?.row_parent).toBe('B2')
  })

  it('数据集名 ds1 不会被当成单元格引用', () => {
    const g = templateToGrid(
      {
        name: 't',
        rows: [{ cells: [{ value: null, model: { ds: 'ds1', field: 'city' } }] }],
      },
      1,
      1,
    )
    const out = insertGridRow(g, 0)
    // ds 名不变（关键：若把 ds1 当引用会变成 ds2）
    expect(out[1][0].model?.ds).toBe('ds1')
    expect(out[1][0].model?.field).toBe('city')
  })

  it('B3:+0 的相对偏移不被平移', () => {
    const g = templateToGrid(
      {
        name: 't',
        rows: [
          { cells: [{ value: null, model: { ds: 'ds1', field: 'a', expand_type: 'r' } }] },
          {
            cells: [
              {
                value: null,
                model: { ds: 'ds1', value_expr: 'B3:+0', row_parent: 'A1' },
              },
            ],
          },
        ],
      },
      2,
      1,
    )
    const out = insertGridRow(g, 0)
    // B3 是引用 → B4；:+0 是偏移，必须原样保留
    expect(out[2][0].model?.value_expr).toBe('B4:+0')
  })

  it('setGridCell 越界不改网格', () => {
    const g = templateToGrid({ name: 't', rows: [] }, 2, 2)
    expect(setGridCell(g, 9, 9, { value: 'x', model: undefined })).toBe(g)
  })
})

describe('自由模板：网格 ↔ SheetTpl', () => {
  it('尾部空行被裁掉，中间空格保留', () => {
    const g = templateToGrid(
      {
        name: 't',
        rows: [
          { cells: [{ value: '标题', model: undefined }, { value: null, model: undefined }] },
          { cells: [] },
        ],
      },
      2,
      2,
    )
    const sheet = gridToSheet(g, 'x')
    expect(sheet.rows.length).toBe(1)
    expect(sheet.rows[0].cells.length).toBe(2)
    expect(sheet.rows[0].cells[1].value).toBeNull()
  })
})

describe('自由模板：模板体检', () => {
  const tpl = (rows: ReportTemplate['sheets'][number]['rows']): ReportTemplate => ({
    sheets: [{ name: 's', rows }],
  })

  it('展开格没有数据集 → 报警', () => {
    const w = validateTemplate(
      tpl([{ cells: [{ value: null, model: { expand_type: 'r' } }] }]),
    )
    expect(w.some((x) => x.includes('没有数据集'))).toBe(true)
  })

  it('主格指向没有模型的格子 → 报警', () => {
    const w = validateTemplate(
      tpl([
        {
          cells: [
            { value: null, model: { ds: 'ds1', field: 'a', expand_type: 'r' } },
            { value: null, model: { ds: 'ds1', field: 'b', row_parent: 'B9' } },
          ],
        },
      ]),
    )
    expect(w.some((x) => x.includes('没有数据模型'))).toBe(true)
  })

  it('主格指向自己 → 报警', () => {
    const w = validateTemplate(
      tpl([{ cells: [{ value: null, model: { ds: 'ds1', field: 'a', row_parent: 'A1' } }] }]),
    )
    expect(w.some((x) => x.includes('指向自己'))).toBe(true)
  })

  it('主格成环 → 报警', () => {
    const w = validateTemplate(
      tpl([
        {
          cells: [
            { value: null, model: { ds: 'ds1', field: 'a', expand_type: 'r', row_parent: 'B1' } },
            { value: null, model: { ds: 'ds1', field: 'b', expand_type: 'r', row_parent: 'A1' } },
          ],
        },
      ]),
    )
    expect(w.some((x) => x.includes('成环'))).toBe(true)
  })

  it('正常模板零告警', () => {
    const w = validateTemplate(
      tpl([
        { cells: [{ value: '标题', model: undefined }] },
        {
          cells: [
            { value: null, model: { ds: 'ds1', field: 'region', expand_type: 'r' } },
            {
              value: null,
              model: { ds: 'ds1', field: 'city', expand_type: 'r', row_parent: 'A2' },
            },
            { value: null, model: { ds: 'ds1', value_expr: 'C2[B2:+0].sum()', row_parent: 'B2' } },
          ],
        },
      ]),
    )
    expect(w).toEqual([])
  })
})

describe('自由模板：合并单元格', () => {
  const tpl = (rows: ReportTemplate['sheets'][number]['rows']): ReportTemplate => ({
    sheets: [{ name: 's', rows }],
  })

  it('合并后锚点带跨度，被覆盖的格清空且不再是锚点', () => {
    const r = setGridMerge(emptyGrid(4, 4), 0, 0, 2, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(mergeSpanOf(r.grid[0][0])).toMatchObject({ rows: 2, cols: 2 })
    expect(isMergeAnchor(r.grid[0][0])).toBe(true)
    // 被盖住的格必须是空的，否则服务端布局时那一格会冒出来
    expect(formatCellText(r.grid[1][1])).toBe('')
    expect(isMergeAnchor(r.grid[1][1])).toBe(false)
  })

  it('mergeAt 能从任意一格反查到整个合并块', () => {
    const r = setGridMerge(emptyGrid(4, 5), 1, 1, 2, 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const [rr, cc] of [
      [1, 1],
      [1, 3],
      [2, 1],
      [2, 3],
    ] as const) {
      expect(mergeAt(r.grid, rr, cc)).toMatchObject({ r: 1, c: 1, rows: 2, cols: 3 })
    }
    // 区域外一格都不该命中
    expect(mergeAt(r.grid, 0, 1)).toBeNull()
    expect(mergeAt(r.grid, 1, 0)).toBeNull()
    expect(mergeAt(r.grid, 1, 4)).toBeNull()
    expect(mergeAt(r.grid, 3, 1)).toBeNull()
  })

  it('越界拒绝', () => {
    const r = setGridMerge(emptyGrid(3, 3), 2, 2, 2, 2)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('超出网格')
  })

  it('被覆盖的格有内容时拒绝 —— 不静默丢数据', () => {
    const grid = emptyGrid(3, 3)
    grid[0][1] = { value: '表头', model: undefined }
    const r = setGridMerge(grid, 0, 0, 1, 2)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('B1')
    expect(r.message).toContain('有内容')
  })

  it('与已有合并块交叠时拒绝', () => {
    const first = setGridMerge(emptyGrid(4, 4), 1, 1, 2, 2)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = setGridMerge(first.grid, 2, 2, 2, 2)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.message).toContain('已经有')
  })

  it('取消合并：从被覆盖的格也能取消，锚点回到单格', () => {
    const r = setGridMerge(emptyGrid(3, 3), 0, 0, 2, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const cleared = clearGridMerge(r.grid, 1, 1)
    expect(isMergeAnchor(cleared[0][0])).toBe(false)
    expect(mergeAt(cleared, 1, 1)).toBeNull()
  })

  it('插行落在合并块内部 → 跨度 +1；落在外面 / 锚点上方 → 不动', () => {
    const r = setGridMerge(emptyGrid(6, 4), 0, 0, 2, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // 插在第 2 行 → 落在 [0,1] 内部，块要长高
    const inside = insertGridRow(r.grid, 1)
    expect(mergeSpanOf(inside[0][0])).toMatchObject({ rows: 3, cols: 2 })

    // 插在第 4 行 → 合并块够不着
    expect(mergeSpanOf(insertGridRow(r.grid, 3)[0][0]).rows).toBe(2)

    // 插在第 1 行 → 在锚点上方，锚点平移、跨度不变
    const above = insertGridRow(r.grid, 0)
    expect(mergeSpanOf(above[1][0])).toMatchObject({ rows: 2, cols: 2 })
  })

  it('删行落在合并块内部 → 跨度 -1；缩到 1 行自动解除行合并', () => {
    const two = setGridMerge(emptyGrid(6, 4), 0, 0, 2, 2)
    expect(two.ok).toBe(true)
    if (!two.ok) return
    const shrunk = deleteGridRow(two.grid, 1)
    // 行跨度回到 1，但列跨度还在 → 整体仍算合并
    expect(mergeSpanOf(shrunk[0][0])).toMatchObject({ rows: 1, cols: 2 })
    expect(isMergeAnchor(shrunk[0][0])).toBe(true)

    const three = setGridMerge(emptyGrid(6, 4), 0, 0, 3, 2)
    expect(three.ok).toBe(true)
    if (!three.ok) return
    expect(mergeSpanOf(deleteGridRow(three.grid, 2)[0][0]).rows).toBe(2)
  })

  it('删列落在合并块内部 → 列跨度 -1', () => {
    const r = setGridMerge(emptyGrid(6, 5), 0, 1, 2, 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(mergeSpanOf(deleteGridCol(r.grid, 2)[0][1])).toMatchObject({ rows: 2, cols: 2 })
  })

  it('合并跨度与位置引用两条重映射互不干扰', () => {
    const grid = emptyGrid(5, 4)
    grid[3][0] = { value: null, model: { ds: 'ds1', field: 'a', row_parent: 'A2' } }
    const r = setGridMerge(grid, 0, 0, 2, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = insertGridRow(r.grid, 1)
    expect(mergeSpanOf(out[0][0]).rows).toBe(3) // 合并块长高
    expect(out[4][0].model?.row_parent).toBe('A3') // 引用同步平移
  })

  it('体检能报出手写 JSON 里的越界与交叠合并', () => {
    const outOfRange = validateTemplate(
      tpl([{ cells: [{ value: '标题', model: undefined, merge_across: 5, merge_down: 0 }] }]),
    )
    expect(outOfRange.some((x) => x.includes('列'))).toBe(true)

    const overlap = validateTemplate(
      tpl([
        {
          cells: [
            { value: 'a', model: undefined, merge_across: 2, merge_down: 0 },
            { value: null, model: undefined },
            { value: 'b', model: undefined, merge_across: 2, merge_down: 0 },
          ],
        },
      ]),
    )
    expect(overlap.some((x) => x.includes('交叠'))).toBe(true)
  })

  it('设计态画布把合并块喂给 Univer 的 mergeData', () => {
    const r = setGridMerge(emptyGrid(4, 4), 0, 0, 2, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = gridToWorkbookData(r.grid) as {
      sheets: Record<string, { mergeData: unknown[] }>
    }
    expect(data.sheets.sheet1.mergeData).toEqual([
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
    ])
  })

  // 见 `gridToWorkbookData` 注释：`4` = Univer `CellValueType.FORCE_STRING`，
  // 强制把单元格当字符串，阻止 Univer 看到 `v` 以 `=` 开头就把它挪到 `f` 当公式。
  it('非空单元格一律带 t: 4（Univer FORCE_STRING），保住 `=` / `{{...}}` 字面量', () => {
    const grid = emptyGrid(4, 2)
    grid[0][0] = { value: '=ds1.city', model: undefined }
    grid[1][0] = { value: '=D3[B3:+0].sum()', model: undefined }
    grid[2][0] = { value: '{{ds1.city}}', model: undefined }
    grid[3][0] = { value: 'hello literal', model: undefined }
    // B1 空 + 无 model：验证空单元格确实不进 cellData
    const data = gridToWorkbookData(grid) as {
      sheets: Record<string, {
        cellData: Record<string, Record<string, { v: unknown; t?: number }>>
      }>
    }
    const cd = data.sheets.sheet1.cellData
    expect(cd[0][0]).toEqual({ v: '=ds1.city', t: 4 })
    expect(cd[1][0]).toEqual({ v: '=D3[B3:+0].sum()', t: 4 })
    expect(cd[2][0]).toEqual({ v: '{{ds1.city}}', t: 4 })
    expect(cd[3][0]).toEqual({ v: 'hello literal', t: 4 })
    expect(cd[0][1]).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * 主格树：让「关系」常显
 *
 * 主格是关系不是属性，而 Univer 只画底色 + 字色两个通道（bd / ul 实测画不出来），
 * 两个通道都已经被占满 —— 格子里没有第三个通道能静态表达关系。
 * 关系本质是树，所以常显一棵树，而不是硬塞进格子。
 * ------------------------------------------------------------------ */
describe('自由模板：主格树（关系常显）', () => {
  const cell = (value: string | null, model?: CellTpl['model']): CellTpl => ({ value, model })

  /**
   *   A1 字面量    B1 字段     C1 表达式   D1 字段    E1 只扩展
   *   A2 纵扩展    B2 横扩展   C2 ←A2      D2 ←A2(上主格 B2)
   */
  function treeGrid(): ReturnType<typeof emptyGrid> {
    return [
      [
        cell('地区'),
        cell(null, { ds: 'ds1', field: 'city' }),
        cell(null, { ds: 'ds1', value_expr: 'B1[A1:+0].sum()' }),
        cell(null, { ds: 'ds1', field: 'amount' }),
        cell(null, { ds: 'ds1', expand_type: 'r' }),
      ],
      [
        cell(null, { ds: 'ds1', field: 'region', expand_type: 'r' }),
        cell(null, { ds: 'ds1', field: 'city', expand_type: 'c' }),
        cell(null, { ds: 'ds1', field: 'amount', row_parent: 'A2' }),
        cell(null, { ds: 'ds1', value_expr: 'C2[A2:+0].sum()', row_parent: 'A2', col_parent: 'B2' }),
        cell(null),
      ],
    ]
  }
  /** 树压成 `pos(孩子1,孩子2)` 的形式，好断言 */
  const shape = (ns: TplNode[]): string[] =>
    ns.map((n) => n.pos + (n.children.length ? `(${n.children.map((c) => c.pos).join(',')})` : ''))

  it('按 row_parent 分层：A2 挂着 C2 / D2', () => {
    expect(shape(parentTreeOf(treeGrid()))).toEqual(['B1', 'C1', 'D1', 'E1', 'A2(C2,D2)', 'B2'])
  })

  it('字面量格不进树 —— 标题不属于任何主格链', () => {
    const all = parentTreeOf(treeGrid())
    const flat: string[] = []
    const walk = (ns: TplNode[]) => ns.forEach((n) => (flat.push(n.pos), walk(n.children)))
    walk(all)
    expect(flat).not.toContain('A1') // A1 是字面量，没有 model
    expect(flat).toContain('C2')
  })

  it('col_parent 不参与建树 —— 混进来「链」就变成图了', () => {
    const all = parentTreeOf(treeGrid())
    const b2 = all.find((n) => n.pos === 'B2')
    expect(b2?.children).toEqual([]) // D2 有 col_parent B2，但不该挂到 B2 下
  })

  it('主格成环：不会死循环，也不会让节点凭空消失', () => {
    const g: ReturnType<typeof emptyGrid> = [
      [
        cell(null, { ds: 'ds1', field: 'a', expand_type: 'r', row_parent: 'B1' }),
        cell(null, { ds: 'ds1', field: 'b', expand_type: 'r', row_parent: 'A1' }),
      ],
    ]
    const tree = parentTreeOf(g)
    expect(tree.map((n) => n.pos).sort()).toEqual(['A1', 'B1'])
    expect(tree.every((n) => n.cycle)).toBe(true)
  })

  it('主格指向没有 model 的格 → 当根并标 orphan，不静默丢关系', () => {
    const g: ReturnType<typeof emptyGrid> = [
      [cell('标题'), cell(null, { ds: 'ds1', field: 'a', row_parent: 'A1' })],
    ]
    const tree = parentTreeOf(g)
    expect(tree.map((n) => n.pos)).toEqual(['B1'])
    expect(tree[0]?.orphan).toBe(true)
    // 它是「悬空」不是「成环」：若主格判定放水把它挂到一个不存在的父格下，
    // 它会被当成环拎出来（cycle: true），这里就会红。
    expect(tree[0]?.cycle).toBeFalsy()
  })

  it('主格指向自己 → 当根，不自我嵌套', () => {
    const g: ReturnType<typeof emptyGrid> = [[cell(null, { ds: 'ds1', field: 'a', row_parent: 'A1' })]]
    const tree = parentTreeOf(g)
    expect(tree.map((n) => n.pos)).toEqual(['A1'])
    expect(tree[0]?.children).toEqual([])
  })

  it('parentChainOf：由近及远，只跟 row_parent', () => {
    const g = treeGrid()
    expect(parentChainOf(g, g[1][2])).toEqual(['A2']) // C2
    expect(parentChainOf(g, g[1][3])).toEqual(['A2']) // D2 的上主格 B2 不算进链
    expect(parentChainOf(g, g[1][0])).toEqual([]) // A2 自己是根
    expect(parentChainOf(g, undefined)).toEqual([])
  })

  it('parentChainOf 遇到环会截断，不死循环', () => {
    const g: ReturnType<typeof emptyGrid> = [
      [
        cell(null, { ds: 'ds1', field: 'a', row_parent: 'B1' }),
        cell(null, { ds: 'ds1', field: 'b', row_parent: 'A1' }),
      ],
    ]
    expect(parentChainOf(g, g[0][0]).length).toBeLessThanOrEqual(2)
  })

  it('空网格 / 全字面量 → 空树，不报错', () => {
    expect(parentTreeOf(emptyGrid(3, 3))).toEqual([])
    expect(parentTreeOf([[cell('标题')]])).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 非线性语义「画进网格」
 *
 * 用户看模板时看不见三件事：哪一格会往下长、哪一格的数是算出来的、
 * 谁挂在谁下面。这三者决定报表形状，却都藏在 model 里。
 * 这里把它们编码成**样式**（不是文本标记 —— 文本是回写载体，塞标记会
 * 在用户编辑时静默冲掉 model）。
 * ------------------------------------------------------------------ */
describe('自由模板：非线性语义画进网格', () => {
  const cell = (value: string | null, model?: CellTpl['model']): CellTpl => ({ value, model })

  /**
   * 一格一种语义，位置固定：
   *   A1 字面量      B1 字段         C1 表达式        D1 字段+行测试   E1 只扩展
   *   A2 纵扩展+字段  B2 横扩展+字段  C2 字段+左主格   D2 表达式+双主格 E2 空
   */
  function semGrid(): ReturnType<typeof emptyGrid> {
    return [
      [
        cell('地区'),
        cell(null, { ds: 'ds1', field: 'city' }),
        cell(null, { ds: 'ds1', value_expr: 'B1[A1:+0].sum()' }),
        cell(null, { ds: 'ds1', field: 'amount', row_test_expr: 'amount > 0' }),
        cell(null, { ds: 'ds1', expand_type: 'r' }),
      ],
      [
        cell(null, { ds: 'ds1', field: 'region', expand_type: 'r' }),
        cell(null, { ds: 'ds1', field: 'city', expand_type: 'c' }),
        cell(null, { ds: 'ds1', field: 'amount', row_parent: 'A2' }),
        cell(null, { ds: 'ds1', value_expr: 'C2[A2:+0].sum()', row_parent: 'A2', col_parent: 'B2' }),
        cell(null),
      ],
    ]
  }

  type Wb = {
    styles: Record<string, Record<string, unknown>>
    sheets: Record<string, { cellData: Record<number, Record<number, { v?: string; s?: string }>> }>
  }
  const build = (selected?: string): Wb =>
    gridToWorkbookData(semGrid(), { selected }) as unknown as Wb

  /** 某格最终套到的样式对象；没套样式返回 null */
  const styleAt = (wb: Wb, r: number, c: number): Record<string, unknown> | null => {
    const id = wb.sheets.sheet1.cellData[r]?.[c]?.s
    return id ? wb.styles[id] ?? null : null
  }
  /** 深挖出样式表里出现过的所有 #rrggbb —— 用来交叉核对图例 */
  const allColors = (wb: Wb): Set<string> => {
    const out = new Set<string>()
    const walk = (v: unknown) => {
      if (typeof v === 'string') {
        if (/^#[0-9A-Fa-f]{6}$/.test(v)) out.add(v.toUpperCase())
        return
      }
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(wb.styles)
    return out
  }

  it('底色 = 扩展方向：纵向黄 / 横向绿 / 不扩展无底色', () => {
    const wb = build()
    expect(styleAt(wb, 1, 0)?.bg).toEqual({ rgb: '#FFF1B8' }) // A2 纵向
    expect(styleAt(wb, 1, 1)?.bg).toEqual({ rgb: '#D7F0E3' }) // B2 横向
    expect(styleAt(wb, 0, 1)?.bg).toBeUndefined() // B1 只绑字段，不扩展
    expect(styleAt(wb, 0, 0)).toBeNull() // A1 纯字面量：完全不套样式
  })

  it('字色 = 内容来源：字段蓝 / 表达式紫斜 / 字面量不标', () => {
    const wb = build()
    expect(styleAt(wb, 0, 1)?.cl).toEqual({ rgb: '#1668DC' })
    expect(styleAt(wb, 0, 2)?.cl).toEqual({ rgb: '#6B4FBB' })
    expect(styleAt(wb, 0, 2)?.it).toBe(1)
    expect(styleAt(wb, 0, 0)).toBeNull()
  })

  it('挂了测试表达式：不再画边框/下划线 —— Univer 画不出来，画了等于没画', () => {
    const wb = build()
    // 实测（截图数像素）：`bd` 完全不渲染；`ul` 虽渲染但永远用字色，`cl` 被无视。
    // 所以这里断言的是**没有**多余样式，而不是它长什么样 ——
    // 若哪天有人又加回 bd/ul，这条会红，提醒他去看《Univer 实际能画什么》。
    expect(styleAt(wb, 0, 3)?.bd).toBeUndefined()
    expect(styleAt(wb, 0, 3)?.ul).toBeUndefined()
    // 但它仍然是字段格，该有的字色还在
    expect(styleAt(wb, 0, 3)?.cl).toEqual({ rgb: '#1668DC' })
  })

  it('两个维度可以叠：扩展格同时是字段格 → 既有底色又有字色', () => {
    const wb = build()
    const a2 = styleAt(wb, 1, 0)
    expect(a2?.bg).toEqual({ rgb: '#FFF1B8' })
    expect(a2?.cl).toEqual({ rgb: '#1668DC' })
  })

  it('合并锚点保留语义底色 —— 合并不会把样式吃掉', () => {
    const base = setGridCell(emptyGrid(3, 3), 0, 0, {
      value: null,
      model: { ds: 'ds1', field: 'region', expand_type: 'r' },
    })
    const r = setGridMerge(base, 0, 0, 1, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const wb = gridToWorkbookData(r.grid) as unknown as Wb
    // 锚点仍然是黄色扩展格（Univer 会把底色铺满整个合并块，浏览器实测过）
    expect(styleAt(wb, 0, 0)?.bg).toEqual({ rgb: '#FFF1B8' })
    // 被覆盖的格已被清空，不该有内容也不该有样式
    expect(wb.sheets.sheet1.cellData[0]?.[1]).toBeUndefined()
    // 合并块本身要交给 Univer
    expect(
      (gridToWorkbookData(r.grid) as unknown as { sheets: Record<string, { mergeData: unknown[] }> })
        .sheets.sheet1.mergeData,
    ).toEqual([{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }])
  })

  it('语义样式按需注册：没用到的组合不进 styles', () => {
    const wb = build()
    expect(Object.keys(wb.styles).sort()).toEqual(
      [
        SELECTED_STYLE_ID,
        PARENT_STYLE_ID,
        'tpl-n-field',
        'tpl-n-expr',
        'tpl-r-n',
        'tpl-r-field',
        'tpl-c-field',
      ].sort(),
    )
  })

  it('选中格压过语义样式，主格高亮压过语义底色', () => {
    const wb = build('C2')
    expect(wb.sheets.sheet1.cellData[1]?.[2]?.s).toBe(SELECTED_STYLE_ID)
    // C2 的左主格是 A2（本身是黄色扩展格），此时应该让位给主格色
    expect(wb.sheets.sheet1.cellData[1]?.[0]?.s).toBe(PARENT_STYLE_ID)
    expect(wb.styles[PARENT_STYLE_ID].bg).toEqual({ rgb: PARENT_HIGHLIGHT })
  })

  it('选中 / 主格样式不带边框 —— Univer 画不出 bd，加了是自欺', () => {
    const wb = build('C2')
    expect(wb.styles[SELECTED_STYLE_ID].bd).toBeUndefined()
    expect(wb.styles[PARENT_STYLE_ID].bd).toBeUndefined()
    // 两者靠底色区分，且底色必须不同，否则主格高亮等于没有
    expect(wb.styles[PARENT_STYLE_ID].bg).toEqual({ rgb: PARENT_HIGHLIGHT })
    expect(wb.styles[PARENT_STYLE_ID].bg).not.toEqual(wb.styles[SELECTED_STYLE_ID].bg)
  })

  it('没选中任何格时，不产生主格高亮', () => {
    const wb = build()
    expect(wb.sheets.sheet1.cellData[1]?.[0]?.s).toBe('tpl-r-field')
  })

  it('图例里的每个颜色都真的被用上 —— 改了配色忘了改图例会红', () => {
    // 用不带 selected 的那份：选中 C2 会让 A2 让位给主格色，黄色就注册不进来了
    const used = allColors(build())
    const declared = SEMANTIC_LEGEND.flatMap((x) => [x.bg, x.fg]).filter(
      (x): x is string => typeof x === 'string',
    )
    expect(declared.length).toBeGreaterThan(0)
    for (const color of declared) {
      expect(used).toContain(color.toUpperCase())
    }
  })

  it('图例声明的呈现方式与实际一致：标了 border 就得真画在边框上', () => {
    const wb = build()
    const walk = (v: unknown, into: Set<string>) => {
      if (typeof v === 'string') {
        if (/^#[0-9A-Fa-f]{6}$/.test(v)) into.add(v.toUpperCase())
        return
      }
      if (Array.isArray(v)) v.forEach((x) => walk(x, into))
      else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, into))
    }
    const pools: Record<string, Set<string>> = { bg: new Set(), fg: new Set() }
    for (const st of Object.values(wb.styles)) {
      if (st.bg) walk(st.bg, pools.bg)
      if (st.cl) walk(st.cl, pools.fg)
    }
    for (const it of SEMANTIC_LEGEND) {
      const color = (it.bg ?? it.fg) as string | null
      if (!color) continue
      // 三种 swatch 都要查，少查一种就等于给「改声明不改实现」留了后门
      expect(pools[it.swatch]).toContain(color.toUpperCase())
    }
    // 别让这条检查变成空转：两种 swatch 都得有人用
    for (const k of ['bg', 'fg']) {
      expect(SEMANTIC_LEGEND.filter((x) => x.swatch === k).length).toBeGreaterThan(0)
    }
  })

  it('semanticBgOf：还原主格时要知道它本来的语义底色', () => {
    const g = semGrid()
    expect(semanticBgOf(g[1][0])).toBe('#FFF1B8')
    expect(semanticBgOf(g[1][1])).toBe('#D7F0E3')
    expect(semanticBgOf(g[0][1])).toBeNull() // 字段格：字色有、底色无
    expect(semanticBgOf(g[0][0])).toBeNull()
    expect(semanticBgOf(undefined)).toBeNull()
  })

  it('还原色与画布实际底色同源：涂回 semanticBgOf 就等于没动过', () => {
    const wb = build()
    const g = semGrid()
    // A2 是扩展格：它自己的语义底色 == 渲染时套的底色
    expect(wb.styles['tpl-r-field'].bg).toEqual({ rgb: semanticBgOf(g[1][0]) })
    expect(wb.styles['tpl-c-field'].bg).toEqual({ rgb: semanticBgOf(g[1][1]) })
  })

  it('parentPosOf：左右主格去重，没有主格返回空', () => {
    const g = semGrid()
    expect(parentPosOf(g[1][2])).toEqual(['A2']) // C2 只有左主格
    expect(parentPosOf(g[1][3])).toEqual(['A2', 'B2']) // D2 左右都有
    expect(parentPosOf(g[0][0])).toEqual([])
    expect(parentPosOf(undefined)).toEqual([])
    // 左右主格写同一格时只点亮一次
    expect(parentPosOf(cell(null, { row_parent: 'A2', col_parent: 'A2' }))).toEqual(['A2'])
  })
})
