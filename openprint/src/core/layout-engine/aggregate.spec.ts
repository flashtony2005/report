import { describe, expect, it } from 'vitest'

import {
  aggValueForRows,
  columnAggregatable,
  footerKindOf,
  formatAggNumber,
  isAggToken,
  parseAggToken,
  stripItems,
  toChineseCapitalRMB,
} from '@/core/layout-engine/aggregate'
import { buildTableModel, sliceTable } from '@/core/layout-engine/table-engine'
import {
  buildDesignGrid,
  insertTableColumn,
  insertTableRow,
  rowRoleLabel,
  seedSummaryTail,
} from '@/core/layout-engine/table-cells'
import type { TableCell, TableColumn, TableControl } from '@/types/control'
import type { EvalContext } from './types'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'

/* ============================ 纯函数 ============================ */

describe('parseAggToken / isAggToken', () => {
  it('识别各类聚合 token', () => {
    expect(parseAggToken('{{#pageSum}}')).toBe('pageSum')
    expect(parseAggToken('{{#totalSum}}')).toBe('totalSum')
    expect(parseAggToken('{{#pageCap}}')).toBe('pageCap')
    expect(parseAggToken('{{#totalCap}}')).toBe('totalCap')
    expect(parseAggToken('{{#pageAvg}}')).toBe('pageAvg')
    expect(parseAggToken('{{ #totalCount }}')).toBe('totalCount')
  })
  it('非 token 返回 null', () => {
    expect(parseAggToken('{{item.qty}}')).toBeNull()
    expect(parseAggToken('本页合计')).toBeNull()
    expect(parseAggToken('{{order.total}}')).toBeNull()
    expect(isAggToken('{{#totalSum}}')).toBe(true)
    expect(isAggToken('总量')).toBe(false)
  })
  it('footerKindOf 归类', () => {
    expect(footerKindOf('pageSum')).toBe('pageSubtotal')
    expect(footerKindOf('totalSum')).toBe('grandTotal')
    expect(footerKindOf('totalCap')).toBe('capital')
    expect(footerKindOf(null)).toBe('static')
  })
})

describe('stripItems', () => {
  it('去除 items[]. 前缀', () => {
    expect(stripItems('items[].amount')).toBe('amount')
    expect(stripItems('order.no')).toBe('order.no')
    expect(stripItems(undefined)).toBe('')
  })
})

describe('aggValueForRows', () => {
  const rows = [
    { qty: 2, price: 3 },
    { qty: 3, price: 4 },
  ]
  it('求和', () => {
    expect(aggValueForRows('totalSum', rows, 'qty')).toBe(5)
    expect(aggValueForRows('pageSum', rows, 'price')).toBe(7)
  })
  it('平均', () => {
    expect(aggValueForRows('totalAvg', rows, 'price')).toBe(3.5)
  })
  it('计数', () => {
    expect(aggValueForRows('totalCount', rows, 'qty')).toBe(2)
  })
})

describe('formatAggNumber', () => {
  it('整数不带小数，小数保留两位并加千分位', () => {
    expect(formatAggNumber(18)).toBe('18')
    expect(formatAggNumber(22650)).toBe('22,650')
    expect(formatAggNumber(18.5)).toBe('18.50')
    expect(formatAggNumber(1234567.5)).toBe('1,234,567.50')
  })
})

describe('toChineseCapitalRMB', () => {
  it('整数大写', () => {
    expect(toChineseCapitalRMB(22650)).toBe('贰万贰仟陆佰伍拾元整')
    expect(toChineseCapitalRMB(18)).toBe('壹拾捌元整')
    expect(toChineseCapitalRMB(100)).toBe('壹佰元整')
    expect(toChineseCapitalRMB(1000000)).toBe('壹佰万元整')
  })
  it('小数（角/分）', () => {
    expect(toChineseCapitalRMB(100.05)).toBe('壹佰元零伍分')
    expect(toChineseCapitalRMB(100.5)).toBe('壹佰元伍角')
    expect(toChineseCapitalRMB(0.05)).toBe('伍分')
  })
  it('零与负数', () => {
    expect(toChineseCapitalRMB(0)).toBe('零元整')
    expect(toChineseCapitalRMB(-22650)).toBe('负贰万贰仟陆佰伍拾元整')
  })
})

describe('columnAggregatable', () => {
  it('显式 aggregate 优先', () => {
    expect(columnAggregatable({ title: 'x', field: 'a', width: 10, aggregate: false }, undefined)).toBe(false)
    expect(columnAggregatable({ title: 'x', field: 'a', width: 10, aggregate: true }, undefined)).toBe(true)
  })
  it('按数据首行采样推断数值列', () => {
    const col = { title: '金额', field: 'items[].amount', width: 10 }
    expect(columnAggregatable(col, { amount: 5 })).toBe(true)
    expect(columnAggregatable(col, { amount: 'abc' })).toBe(false)
    expect(columnAggregatable({ title: '名称', field: 'items[].name', width: 10 }, { name: 'x' })).toBe(false)
  })
})

/* ====================== 引擎：尾行聚合集成 ====================== */

function mkTailTable(): TableControl {
  const columns: TableColumn[] = [
    { title: '序号', expression: '{{rowIndex + 1}}', width: 15, align: 'center' },
    { title: '名称', field: 'items[].name', width: 60 },
    { title: '数量', field: 'items[].qty', width: 25, align: 'right', aggregate: true },
    { title: '单价', field: 'items[].price', width: 30, align: 'right', aggregate: true },
    { title: '金额', field: 'items[].amount', width: 30, align: 'right', aggregate: true },
  ]
  const cells: TableCell[][] = [
    [
      { text: '序号' },
      { text: '名称' },
      { text: '数量' },
      { text: '单价' },
      { text: '金额' },
    ],
    [
      { expression: '{{rowIndex + 1}}' },
      { field: 'items[].name' },
      { field: 'items[].qty' },
      { field: 'items[].price' },
      { field: 'items[].amount' },
    ],
    [
      { text: '本页合计', style: { bold: true } },
      {},
      { text: '{{#pageSum}}', style: { bold: true, align: 'right' } },
      { text: '{{#pageSum}}', style: { bold: true, align: 'right' } },
      { text: '{{#pageSum}}', style: { bold: true, align: 'right' } },
    ],
    [
      { text: '总计', style: { bold: true } },
      {},
      { text: '{{#totalSum}}', style: { bold: true, align: 'right' } },
      { text: '{{#totalSum}}', style: { bold: true, align: 'right' } },
      { text: '{{#totalSum}}', style: { bold: true, align: 'right' } },
    ],
    [
      { text: '大写金额', style: { bold: true } },
      {},
      {},
      {},
      { text: '{{#totalCap}}', style: { bold: true } },
    ],
  ]
  const data = [
    { name: 'a', qty: 1, price: 10, amount: 10 },
    { name: 'b', qty: 2, price: 10, amount: 20 },
    { name: 'c', qty: 3, price: 10, amount: 30 },
    { name: 'd', qty: 4, price: 10, amount: 40 },
    { name: 'e', qty: 5, price: 10, amount: 50 },
  ]
  return {
    id: 't',
    type: 'table',
    left: 0,
    top: 0,
    width: 160,
    height: 60,
    columns,
    cells,
    headerRows: 1,
    staticRows: 3,
    data,
    options: { repeatHeader: true, repeatFooter: true, pageRows: 'auto', borders: 'all' },
  }
}

function aggCellText(footer: { cells: { text?: string }[] }, col: number): string {
  return footer.cells[col]?.text ?? ''
}

describe('buildTableModel —— 尾行聚合结构', () => {
  const measurer = createCjkMeasurer()
  const ctx: EvalContext = { data: { items: [] } }
  const model = buildTableModel({ control: mkTailTable(), ctx, measurer, widthMm: 160, heightMm: 60 })

  it('尾行被识别为 pageSubtotal / grandTotal / capital', () => {
    expect(model.footerRows).toHaveLength(3)
    expect(model.footerRows[0]!.footerKind).toBe('pageSubtotal')
    expect(model.footerRows[1]!.footerKind).toBe('grandTotal')
    expect(model.footerRows[2]!.footerKind).toBe('capital')
  })

  it('数值列 token 被标记 isAgg + aggField，字符串列不计算', () => {
    const pageRow = model.footerRows[0]!
    // 数量列（index2）应为聚合单元格
    expect(pageRow.cells[2]!.isAgg).toBe(true)
    expect(pageRow.cells[2]!.aggField).toBe('qty')
    expect(pageRow.cells[2]!.tokenKind).toBe('pageSum')
    // 名称列（index1）无 token
    expect(pageRow.cells[1]!.isAgg).toBeFalsy()
    expect(pageRow.cells[1]!.text).toBe('')
  })

  it('单页切片：本页合计=总计=全量，大写金额为整表总计', () => {
    const slice = sliceTable(model, { avail: 1000, start: 0 })
    expect(slice.isLast).toBe(true)
    const f = slice.footerRows
    expect(f).toHaveLength(3)
    // 数量：1+2+3+4+5=15
    expect(aggCellText(f[0]!, 2)).toBe('15')
    expect(aggCellText(f[1]!, 2)).toBe('15')
    // 金额：10+20+30+40+50=150
    expect(aggCellText(f[0]!, 4)).toBe('150')
    expect(aggCellText(f[1]!, 4)).toBe('150')
    // 大写金额 = 壹佰伍拾元整
    expect(aggCellText(f[2]!, 4)).toBe('壹佰伍拾元整')
  })
})

describe('sliceTable —— 强制分页时本页合计逐页、总计仅末页', () => {
  const measurer = createCjkMeasurer()
  const ctx: EvalContext = { data: { items: [] } }
  const control: TableControl = { ...mkTailTable(), options: { repeatHeader: true, repeatFooter: true, pageRows: 2, borders: 'all' } }
  const model = buildTableModel({ control, ctx, measurer, widthMm: 160, heightMm: 60 })

  it('第 1 页（非末页）只有本页合计，不含总计/大写', () => {
    const s1 = sliceTable(model, { avail: 1000, start: 0 })
    expect(s1.isLast).toBe(false)
    // 本页合计 = 前 2 行：数量 1+2=3，金额 10+20=30
    expect(aggCellText(s1.footerRows[0]!, 2)).toBe('3')
    expect(aggCellText(s1.footerRows[0]!, 4)).toBe('30')
    // 末页专属行不出现
    expect(s1.footerRows.find((r) => r.footerKind === 'grandTotal')).toBeUndefined()
    expect(s1.footerRows.find((r) => r.footerKind === 'capital')).toBeUndefined()
  })

  it('末页同时含本页合计、总计与大写金额', () => {
    // 5 行 / 每页 2 → 第 3 页（start=4）为末页，仅 1 行
    const s3 = sliceTable(model, { avail: 1000, start: 4 })
    expect(s3.isLast).toBe(true)
    expect(s3.footerRows.find((r) => r.footerKind === 'grandTotal')).toBeTruthy()
    expect(s3.footerRows.find((r) => r.footerKind === 'capital')).toBeTruthy()
    // 末页本页合计 = 第 5 行：数量 5，金额 50
    expect(aggCellText(s3.footerRows[0]!, 2)).toBe('5')
    expect(aggCellText(s3.footerRows[0]!, 4)).toBe('50')
    // 总计仍为全量 15 / 150
    const grand = s3.footerRows.find((r) => r.footerKind === 'grandTotal')!
    expect(aggCellText(grand, 2)).toBe('15')
    expect(aggCellText(grand, 4)).toBe('150')
    // 大写金额取整表金额总计
    const cap = s3.footerRows.find((r) => r.footerKind === 'capital')!
    expect(aggCellText(cap, 4)).toBe('壹佰伍拾元整')
  })
})

/* ====================== seedSummaryTail / 行角色 ====================== */

describe('seedSummaryTail', () => {
  it('自动植入三行尾结构并标记数值列 aggregate', () => {
    const base: TableControl = {
      id: 't',
      type: 'table',
      left: 0,
      top: 0,
      width: 160,
      height: 60,
      columns: [
        { title: '名称', field: 'items[].name', width: 60 },
        { title: '数量', field: 'items[].qty', width: 25, align: 'right' },
        { title: '金额', field: 'items[].amount', width: 30, align: 'right' },
      ],
      headerRows: 1,
      data: [
        { name: 'a', qty: 1, amount: 10 },
        { name: 'b', qty: 2, amount: 20 },
      ],
      options: { repeatHeader: true, repeatFooter: true, pageRows: 'auto', borders: 'all' },
    }
    const seeded = seedSummaryTail(base)
    const grid = buildDesignGrid(seeded)
    expect(grid.rowCount).toBe(5) // 1 表头 + 1 数据 + 3 尾
    // 金额列（index2）被标记 aggregate
    expect(seeded.columns[2]!.aggregate).toBe(true)
    // 尾行含 token
    const lastRows = grid.cells.slice(grid.headerRows + 1)
    expect(lastRows.some((r) => r.some((c) => c.text === '{{#pageSum}}'))).toBe(true)
    expect(lastRows.some((r) => r.some((c) => c.text === '{{#totalCap}}'))).toBe(true)
  })

  it('幂等：已植入则不重复', () => {
    const base: TableControl = {
      id: 't',
      type: 'table',
      left: 0,
      top: 0,
      width: 160,
      height: 60,
      columns: [
        { title: '名称', field: 'items[].name', width: 60 },
        { title: '金额', field: 'items[].amount', width: 30, align: 'right' },
      ],
      headerRows: 1,
      data: [{ name: 'a', amount: 1 }],
      options: { pageRows: 'auto' },
    }
    const once = seedSummaryTail(base)
    const twice = seedSummaryTail(once)
    expect(buildDesignGrid(twice).rowCount).toBe(buildDesignGrid(once).rowCount)
  })
})

describe('rowRoleLabel', () => {
  it('聚合尾行返回正确角色名', () => {
    const seeded = seedSummaryTail({
      id: 't',
      type: 'table',
      left: 0,
      top: 0,
      width: 160,
      height: 60,
      columns: [
        { title: '名称', field: 'items[].name', width: 60 },
        { title: '金额', field: 'items[].amount', width: 30, align: 'right' },
      ],
      headerRows: 1,
      data: [{ name: 'a', amount: 1 }],
      options: { pageRows: 'auto' },
    })
    const grid = buildDesignGrid(seeded)
    expect(rowRoleLabel(grid, 0)).toBe('标题行')
    expect(rowRoleLabel(grid, 1)).toBe('数据行')
    // 尾行：本页合计 / 总计 / 大写金额
    expect(rowRoleLabel(grid, 2)).toBe('本页合计行')
    expect(rowRoleLabel(grid, 3)).toBe('总计行')
    expect(rowRoleLabel(grid, 4)).toBe('大写金额行')
  })
})

describe('insertTableRow / insertTableColumn', () => {
  it('插入行后行数+1，数据表维持单数据样例行', () => {
    const base: TableControl = {
      id: 't',
      type: 'table',
      left: 0,
      top: 0,
      width: 160,
      height: 60,
      columns: [{ title: 'A', field: 'items[].a', width: 30 }],
      headerRows: 1,
      data: [{ a: 1 }],
      options: { pageRows: 'auto' },
    }
    const seeded = seedSummaryTail(base) // 5 行
    const withRow = insertTableRow(seeded, 3) // 在第 3 行（本页合计）上方插入
    const grid = buildDesignGrid(withRow)
    expect(grid.rowCount).toBe(6)
    expect(grid.staticRows).toBe(4)
  })

  it('插入列后列数+1，每行单元格同步扩展', () => {
    const base: TableControl = {
      id: 't',
      type: 'table',
      left: 0,
      top: 0,
      width: 160,
      height: 60,
      columns: [{ title: 'A', field: 'items[].a', width: 30 }],
      headerRows: 1,
      data: [{ a: 1 }],
      options: { pageRows: 'auto' },
    }
    const withCol = insertTableColumn(base, 1) // 在列 1 左侧插入
    expect(withCol.columns).toHaveLength(2)
    const grid = buildDesignGrid(withCol)
    expect(grid.colCount).toBe(2)
    expect(grid.cells.every((r) => r.length === 2)).toBe(true)
  })
})
