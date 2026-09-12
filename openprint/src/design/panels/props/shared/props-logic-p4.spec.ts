/**
 * P4.2 四个面板共享逻辑测试（两端同源防线）：
 * shape-props-logic / chart-props-logic / label-grid-props-logic / table-props-logic。
 * 变异验证基准：改任何一行共享逻辑都必须在此抓到。
 */
import { describe, expect, it } from 'vitest'
import type { LineControl, RectControl, LabelGridControl, TableControl } from '@/types/control'
import {
  cornerRadiusPatch,
  dashedPatch,
  isDashed,
  perfectCirclePatch,
  radiusOf,
  shapeChangePatch,
  unifiedRadiusPatch,
} from './shape-props-logic'
import {
  addSeriesAt,
  alignSeriesData,
  categoriesPatch,
  categoriesText,
  removeSeriesAt,
  seriesColorOf,
  seriesDataText,
  setSeriesColorAt,
  setSeriesNameAt,
  showLegendDefault,
} from './chart-props-logic'
import {
  contentWidthOf,
  fitCardPatch,
  geometryPatch,
  maxColumnsOf,
  rowsHeightPatch,
  visibleRowsOf,
} from './label-grid-props-logic'
import {
  cleanOptions,
  columnFieldOptions,
  defaultSummary,
  fieldTypeMapOf,
  formatFromKind,
  groupFieldOptions,
  isAggregateOn,
  isPresetDatePattern,
  mergeClean,
  normalizeColumnFormat,
  stylePickPatch,
  summaryFieldOptions,
  tableSourceOptions,
  withSummaryExpr,
  withSummaryFallback,
} from './table-props-logic'
import type { ChartSeries } from '@/core/chartkit/types'

/* ============================ shape-props-logic ============================ */

describe('shape-props-logic', () => {
  it('isDashed / dashedPatch 开关往返', () => {
    const line = { type: 'line', strokeDashArray: [6, 4] } as unknown as LineControl
    expect(isDashed(line)).toBe(true)
    expect(isDashed({} as LineControl)).toBe(false)
    expect(dashedPatch(true)).toEqual({ strokeDashArray: [6, 4] })
    expect(dashedPatch(false)).toEqual({ strokeDashArray: undefined })
  })
  it('unifiedRadiusPatch 清空四角独立覆盖', () => {
    expect(unifiedRadiusPatch(4)).toEqual({
      cornerRadius: 4,
      cornerRadiusTL: undefined,
      cornerRadiusTR: undefined,
      cornerRadiusBR: undefined,
      cornerRadiusBL: undefined,
    })
    expect(unifiedRadiusPatch(null).cornerRadius).toBe(0)
  })
  it('cornerRadiusPatch 按角写键', () => {
    expect(cornerRadiusPatch('TL', 3)).toEqual({ cornerRadiusTL: 3 })
    expect(cornerRadiusPatch('BR', null)).toEqual({ cornerRadiusBR: 0 })
  })
  it('radiusOf 独立覆盖优先、回落统一值、兜底 0', () => {
    expect(radiusOf({ cornerRadius: 2, cornerRadiusTL: 5 } as RectControl, 'TL')).toBe(5)
    expect(radiusOf({ cornerRadius: 2 } as RectControl, 'TR')).toBe(2)
    expect(radiusOf(null, 'BL')).toBe(0)
  })
  it('shapeChangePatch：切圆强制正方形并清圆角；切回矩形保留尺寸', () => {
    const rect = { width: 30, height: 20, cornerRadius: 3 } as RectControl
    expect(shapeChangePatch(rect, 'circle')).toEqual({ shape: 'circle', cornerRadius: 0, width: 30, height: 30 })
    expect(shapeChangePatch(rect, 'rect')).toEqual({ shape: 'rect', cornerRadius: 3 })
  })
  it('perfectCirclePatch 取长边为直径', () => {
    expect(perfectCirclePatch({ width: 20, height: 35 } as RectControl)).toEqual({ width: 35, height: 35 })
  })
})

/* ============================ chart-props-logic ============================ */

describe('chart-props-logic', () => {
  const c = {
    type: 'chart',
    kind: 'bar',
    categories: ['一月', '二月'],
    series: [
      { name: '销量', data: [10, 20] },
      { name: '利润', data: [5, 8] },
    ],
  } as never as Parameters<typeof categoriesPatch>[0]

  it('categoriesText 换行拼接', () => {
    expect(categoriesText(c)).toBe('一月\n二月')
  })
  it('categoriesPatch 对齐各序列数据长度（缺位补 0）', () => {
    const p = categoriesPatch(c, '甲\n乙\n丙') as { categories: string[]; series: { data: number[] }[] }
    expect(p.categories).toEqual(['甲', '乙', '丙'])
    expect(p.series[0]!.data).toEqual([10, 20, 0])
    expect(p.series[1]!.data).toEqual([5, 8, 0])
  })
  it('setSeriesNameAt / setSeriesColorAt 不可变更新', () => {
    const s: ChartSeries[] = [{ name: 'A', data: [1] }, { name: 'B', data: [2] }]
    expect(setSeriesNameAt(s, 1, 'C')[1]!.name).toBe('C')
    expect(s[1]!.name).toBe('B')
    expect(setSeriesColorAt(s, 0, '#FF0000')[0]!.color).toBe('#FF0000')
  })
  it('alignSeriesData 非数值缺位补 0、过滤空行', () => {
    const s: ChartSeries[] = [{ name: 'A', data: [] }]
    const out = alignSeriesData(s, 0, '3\n\nx\n7', ['a', 'b', 'c'])
    expect(out[0]!.data).toEqual([3, 0, 7])
    expect(seriesDataText(out, 0)).toBe('3\n0\n7')
  })
  it('addSeriesAt 名称/零数据/调色板颜色', () => {
    const out = addSeriesAt([{ name: '系列1', data: [0] }], ['a', 'b'])
    expect(out[1]!.name).toBe('系列2')
    expect(out[1]!.data).toEqual([0, 0])
    expect(typeof out[1]!.color).toBe('string')
  })
  it('removeSeriesAt 至少保留 1 条', () => {
    const one: ChartSeries[] = [{ name: 'A', data: [] }]
    expect(removeSeriesAt(one, 0)).toBe(one)
    expect(removeSeriesAt([...one, { name: 'B', data: [] }], 0)).toHaveLength(1)
  })
  it('seriesColorOf 未设置时按调色板回落', () => {
    expect(seriesColorOf([{ name: 'A', data: [] }], 0)).toBe(seriesColorOf([], 0))
    expect(seriesColorOf([{ name: 'A', data: [], color: '#123456' }], 0)).toBe('#123456')
  })
  it('showLegendDefault 多序列默认显示', () => {
    expect(showLegendDefault(undefined, 2)).toBe(true)
    expect(showLegendDefault(undefined, 1)).toBe(false)
    expect(showLegendDefault({ showLegend: false }, 2)).toBe(false)
  })
})

/* ========================== label-grid-props-logic ========================== */

describe('label-grid-props-logic', () => {
  const geo = { columns: 3, gapX: 2, gapY: 2, cardWidth: 30, cardHeight: 20 }

  it('contentWidthOf 页宽减边距', () => {
    expect(contentWidthOf({ width: 210, margin: { left: 15, right: 15 } })).toBe(180)
  })
  it('maxColumnsOf 按卡宽+间距计算上限', () => {
    // (180+2)/(30+2) = 5.6 → 5
    expect(maxColumnsOf(180, geo)).toBe(5)
    expect(maxColumnsOf(180, { ...geo, cardWidth: 0 })).toBeGreaterThanOrEqual(1)
  })
  it('visibleRowsOf 按容器高算可见行', () => {
    // (60+2)/(20+2) = 2.8 → 2
    const ctl = { height: 60 } as LabelGridControl
    expect(visibleRowsOf(ctl, geo)).toBe(2)
    expect(visibleRowsOf(null, geo)).toBe(1)
  })
  it('geometryPatch 重算容器宽高（所见即所得）', () => {
    const ctl = { width: 94, height: 64, columns: 3, gapX: 2, gapY: 2, cardWidth: 30, cardHeight: 20, children: [] } as unknown as LabelGridControl
    const p = geometryPatch(ctl, { columns: 4 }, 3)
    // 宽 = 30*4 + 2*3 = 126；高 = 20*3 + 2*2 = 64
    expect(p.width).toBe(126)
    expect(p.height).toBe(64)
    expect(p.columns).toBe(4)
  })
  it('rowsHeightPatch 行数决定高度', () => {
    expect(rowsHeightPatch(geo, 3)).toEqual({ height: 64 })
  })
  it('fitCardPatch 按子组件包围盒收紧卡片尺寸', () => {
    const ctl = {
      width: 94, height: 64, columns: 3, gapX: 2, gapY: 2, cardWidth: 30, cardHeight: 20,
      children: [{ type: 'text', left: 2, top: 3, width: 20, height: 10 }],
    } as unknown as LabelGridControl
    const p = fitCardPatch(ctl, 3)
    expect(p.cardWidth).toBe(22) // 2+20
    expect(p.cardHeight).toBe(13) // 3+10
    // 宽 = 22*3 + 2*2 = 70；高 = 13*3 + 2*2 = 43
    expect(p.width).toBe(70)
    expect(p.height).toBe(43)
  })
})

/* ============================ table-props-logic ============================ */

describe('table-props-logic', () => {
  it('mergeClean 清除 null / 空串，保留 false / 0', () => {
    expect(mergeClean({ a: 1, b: 2 }, { b: null, c: '', d: false, e: 0 })).toEqual({ a: 1, d: false, e: 0 })
  })
  it('cleanOptions 清除显式 undefined 键', () => {
    const out = cleanOptions({ repeatHeader: true } as never, { summaryRow: undefined, striped: true } as never)
    expect(out).toEqual({ repeatHeader: true, striped: true })
    expect('summaryRow' in out).toBe(false)
  })
  it('isAggregateOn 识别四种开启值', () => {
    expect(isAggregateOn({ aggregate: true } as never)).toBe(true)
    expect(isAggregateOn({ aggregate: 'sum' } as never)).toBe(true)
    expect(isAggregateOn({ aggregate: 'avg' } as never)).toBe(true)
    expect(isAggregateOn({ aggregate: 'count' } as never)).toBe(true)
    expect(isAggregateOn({ aggregate: false } as never)).toBe(false)
    expect(isAggregateOn({} as never)).toBe(false)
  })
  it('normalizeColumnFormat / formatFromKind：none 视为清除', () => {
    expect(normalizeColumnFormat(undefined)).toBeUndefined()
    expect(normalizeColumnFormat({ kind: 'none' } as never)).toBeUndefined()
    expect(normalizeColumnFormat({ kind: 'date' } as never)).toEqual({ kind: 'date' })
    expect(formatFromKind('none')).toBeUndefined()
    expect(formatFromKind('currency')!.kind).toBe('currency')
  })
  it('columnFieldOptions 只列明细数组字段并带不绑定项', () => {
    const fields = [
      { path: 'order.no', label: '单号', type: 'string' },
      { path: 'items[].qty', label: '数量', type: 'number' },
      { path: 'items[].price', label: '单价', type: 'number' },
    ] as never
    const opts = columnFieldOptions(fields)
    expect(opts[0]).toEqual({ label: '（不绑定）', value: '' })
    expect(opts).toHaveLength(3)
    expect(opts[1]!.value).toBe('items[].qty')
    expect(opts[1]!.label).toContain('数量')
  })
  it('fieldTypeMapOf 按 path 建索引', () => {
    const m = fieldTypeMapOf([{ path: 'a.b', type: 'date' }] as never)
    expect(m.get('a.b')).toBe('date')
  })
  it('groupFieldOptions 取数组表字段、value 为裸字段名', () => {
    const fields = [
      { path: 'items[].qty', label: '数量', type: 'number', tableId: 'items' },
      { path: 'order.no', label: '单号', type: 'string', tableId: 'order' },
    ] as never
    const tables = [{ id: 'items', isArray: true }, { id: 'order' }]
    const opts = groupFieldOptions(fields, tables)
    expect(opts).toEqual([{ label: '数量 · items[].qty', value: 'qty' }])
  })
  it('summaryFieldOptions 只取已绑定字段的列', () => {
    const cols = [
      { title: '数量', field: 'items[].qty' },
      { title: '备注' },
    ] as never
    expect(summaryFieldOptions(cols)).toEqual([{ label: '数量 · items[].qty', value: 'items[].qty' }])
  })
  it('isPresetDatePattern 预设 true / 自定义 false', () => {
    expect(isPresetDatePattern('YYYY-MM-DD')).toBe(true)
    expect(isPresetDatePattern('YYYY年MM月DD日')).toBe(true)
    expect(isPresetDatePattern('__custom__')).toBe(false)
    expect(isPresetDatePattern(undefined)).toBe(false)
  })
  it('defaultSummary 兜底求和配置', () => {
    expect(defaultSummary()).toEqual({ type: 'sum', fields: [], label: '合计' })
  })
  it('withSummaryExpr 空串删除键、非空写入并切 custom', () => {
    const cur = defaultSummary()
    expect(withSummaryExpr(cur, 'amount', 'sum.amount - 1')).toEqual({
      type: 'custom', fields: [], label: '合计',
      expressions: { amount: 'sum.amount - 1' },
    })
    const withExpr = withSummaryExpr(cur, 'amount', 'x')
    expect(withSummaryExpr(withExpr, 'amount', '  ').expressions).toEqual({})
  })
  it('withSummaryFallback 空串清除 expression', () => {
    const cur = { ...defaultSummary(), expression: 'rows.length' }
    expect(withSummaryFallback(cur, null).expression).toBeUndefined()
    expect(withSummaryFallback(cur, 'allRows.length').expression).toBe('allRows.length')
  })
  it('stylePickPatch 带 borders 的预设一并套用；纯配色预设保留当前边框', () => {
    const p1 = stylePickPatch('grid')
    expect(p1).toEqual({ tableStyle: 'grid', borders: 'all' })
    const p2 = stylePickPatch('report')
    expect(p2).toEqual({ tableStyle: 'report', borders: 'three-line' })
  })

  /* 表格「数据设置 → 数据源」下拉 —— 必须是「表（数组）」，不能是「列」。
     回归：早先错喂 flatFields（全是 items[].列名），下拉里"都是列、没有表"。 */
  it('tableSourceOptions 只列数组表，value 用表 pathPrefix', () => {
    const tables = [
      { id: 'order', name: '订单主表', relation: 'main', pathPrefix: 'order' },
      { id: 'customer', name: '客户信息', relation: 'join', pathPrefix: 'customer' },
      { id: 'items', name: '订单明细', relation: 'detail', pathPrefix: 'items[]', isArray: true },
    ] as never
    expect(tableSourceOptions(tables)).toEqual([{ label: '订单明细  ·  items[]', value: 'items[]' }])
  })
  it('tableSourceOptions 对未标 isArray 的明细表/[] 前缀表也认（外部数据源兜底）', () => {
    const tables = [
      { id: 'a', name: '明细A', relation: 'detail', pathPrefix: 'a.' },
      { id: 'b', name: '明细B', relation: 'main', pathPrefix: 'b[]' },
      { id: 'c', name: '主表', relation: 'main', pathPrefix: 'c.' },
      { id: 'd', name: '单表明细', relation: 'main', pathPrefix: 'items', isArray: true },
    ] as never
    expect(tableSourceOptions(tables).map((o) => o.value)).toEqual(['a.', 'b[]', 'items'])
  })
  it('tableSourceOptions 无表时返回空数组（不报错）', () => {
    expect(tableSourceOptions(undefined)).toEqual([])
    expect(tableSourceOptions([])).toEqual([])
  })
  it('tableSourceOptions 结果里绝不含列路径（防回归到 flatFields）', () => {
    const tables = [{ id: 'items', name: '订单明细', relation: 'detail', pathPrefix: 'items[]', isArray: true }] as never
    const opts = tableSourceOptions(tables)
    expect(opts.every((o) => !o.value.includes('[].'))).toBe(true)
    expect(opts.every((o) => !o.value.includes('.'))).toBe(true)
  })
})
