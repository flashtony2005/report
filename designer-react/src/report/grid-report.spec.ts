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
  stripArrayPrefix,
  toWorkbookData,
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
