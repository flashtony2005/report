import { describe, expect, it } from 'vitest'

import {
  buildTableModel,
  normalizeColumnWidths,
  sliceTable,
} from '@/core/layout-engine/table-engine'
import { isDataTable, seedSummaryTail } from '@/core/layout-engine/table-cells'
import type { TableColumn, TableControl } from '@/types/control'
import type { EvalContext } from './types'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'

type Model = ReturnType<typeof buildTableModel>

describe('normalizeColumnWidths —— 列宽归一化', () => {
  it('按比例缩放使列宽和 = totalWidth', () => {
    const cols: TableColumn[] = [
      { title: 'A', field: 'a', width: 10 },
      { title: 'B', field: 'b', width: 20 },
    ]
    const out = normalizeColumnWidths(cols, 30)
    expect(out).toEqual([10, 20])
    expect(out.reduce((s, w) => s + w, 0)).toBeCloseTo(30, 6)
  })

  it('全部为 0 时均分', () => {
    const cols: TableColumn[] = [{ title: 'A', field: 'a', width: 0 }, { title: 'B', field: 'b', width: 0 }]
    const out = normalizeColumnWidths(cols, 10)
    expect(out[0]).toBeCloseTo(5, 6)
    expect(out[1]).toBeCloseTo(5, 6)
  })

  it('含 0 宽列时保持 0，其余按比例', () => {
    const cols: TableColumn[] = [
      { title: 'A', field: 'a', width: 2 },
      { title: 'B', field: 'b', width: 0 },
      { title: 'C', field: 'c', width: 2 },
    ]
    const out = normalizeColumnWidths(cols, 8)
    expect(out[0]).toBeCloseTo(4, 6)
    expect(out[1]).toBe(0)
    expect(out[2]).toBeCloseTo(4, 6)
    expect(out.reduce((s, w) => s + w, 0)).toBeCloseTo(8, 6)
  })
})

describe('buildTableModel —— 表格建模', () => {
  const measurer = createCjkMeasurer()
  const control = {
    id: 'tbl',
    type: 'table',
    left: 0,
    top: 0,
    width: 100,
    height: 50,
    dataSource: 'items',
    columns: [
      { field: 'name', title: '名称', width: 60, align: 'left' },
      { field: 'qty', title: '数量', width: 40, align: 'right' },
    ],
    options: { repeatHeader: true },
  } as unknown as Parameters<typeof buildTableModel>[0]['control']

  it('根据 dataSource 生成与数据等量的数据行', () => {
    const ctx = { data: { items: [{ name: 'A', qty: 1 }, { name: 'B', qty: 2 }, { name: 'C', qty: 3 }] } }
    const model = buildTableModel({ control, ctx, measurer, widthMm: 100, heightMm: 50 })
    expect(model.rows.length).toBe(3)
    expect(model.columnWidths.length).toBe(2)
    expect(model.columnWidths.reduce((s, w) => s + w, 0)).toBeCloseTo(100, 6)
    expect(model.headerRows.length).toBeGreaterThan(0)
    expect(model.isLayoutGrid).toBe(false)
  })

  it('无数据源时退化为布局网格（固定行数）', () => {
    const grid = { ...control, dataSource: '' } as unknown as Parameters<typeof buildTableModel>[0]['control']
    const model = buildTableModel({ control: grid, ctx: { data: {} }, measurer, widthMm: 100, heightMm: 50 })
    expect(model.isLayoutGrid).toBe(true)
    expect(model.rows.length).toBeGreaterThan(0)
  })

  /** 取出第一条数据行的第 col 列渲染文本 */
  function dataCellText(ctrl: Parameters<typeof buildTableModel>[0]['control'], ctx: EvalContext, col: number): string {
    const model = buildTableModel({ control: ctrl, ctx, measurer, widthMm: 100, heightMm: 50 })
    const row = model.rows.find((r) => r.kind === 'data')
    if (!row) throw new Error('no data row')
    return (row.cells[col] as { text: string }).text
  }

  it('列格式 decimal：数字按小数位+千分位渲染', () => {
    const c = {
      ...control,
      columns: [{ field: 'price', title: '单价', width: 40, align: 'right', format: { kind: 'decimal', digits: 2 } }],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    expect(dataCellText(c, { data: { items: [{ price: 1234.5 }] } }, 0)).toBe('1,234.50')
  })

  it('列格式 currency：带币种符号', () => {
    const c = {
      ...control,
      columns: [{ field: 'amount', title: '金额', width: 40, align: 'right', format: { kind: 'currency', code: 'CNY' } }],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    expect(dataCellText(c, { data: { items: [{ amount: 9999.9 }] } }, 0)).toBe('¥9,999.90')
  })

  it('单元格 format 覆盖列 format', () => {
    const c = {
      ...control,
      columns: [{ field: 'qty', title: '数量', width: 40, align: 'right', format: { kind: 'decimal', digits: 2 } }],
      cells: [
        [{ text: '数量' }],
        [{ field: 'qty', format: { kind: 'int' } }],
      ],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    expect(dataCellText(c, { data: { items: [{ qty: 1234.5 }] } }, 0)).toBe('1,235')
  })

  it('单元格显式三态：variable / expression / fixed 各按模式取值', () => {
    // variable：cell.field 优先（即使列也有 field，也以单元格为准）
    const c1 = {
      ...control,
      columns: [{ field: 'name', title: '名称', width: 60 }],
      cells: [
        [{ text: '名称' }],
        [{ contentType: 'variable', field: 'qty' }],
      ],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    expect(dataCellText(c1, { data: { items: [{ name: 'A', qty: 7 }] } }, 0)).toBe('7')

    // expression：行表达式求值（作用域含 row / rowIndex）
    const c2 = {
      ...control,
      columns: [{ field: 'name', title: '名称', width: 60 }],
      cells: [
        [{ text: '名称' }],
        [{ contentType: 'expression', expression: '{{row.qty * 2}}' }],
      ],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    expect(dataCellText(c2, { data: { items: [{ qty: 3 }] } }, 0)).toBe('6')

    // fixed：固定文字（即使列有 field 也不走绑定）
    const c3 = {
      ...control,
      columns: [{ field: 'name', title: '名称', width: 60 }],
      cells: [
        [{ text: '名称' }],
        [{ contentType: 'fixed', text: 'N/A' }],
      ],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    expect(dataCellText(c3, { data: { items: [{ name: 'A' }] } }, 0)).toBe('N/A')
  })

  it('显式 fixed 模式 text 为空时回落列 field（不打断整列）', () => {
    const c = {
      ...control,
      columns: [{ field: 'qty', title: '数量', width: 60 }],
      cells: [
        [{ text: '数量' }],
        [{ contentType: 'fixed' }],
      ],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    expect(dataCellText(c, { data: { items: [{ qty: 5 }] } }, 0)).toBe('5')
  })

  it('表头/静态行显式三态：variable 绑字段 / expression 插值', () => {
    const c = {
      ...control,
      dataSource: '',
      headerRows: 1,
      staticRows: 1,
      cells: [
        // 表头：variable 模式绑 order.no
        [{ contentType: 'variable', field: 'order.no' }, { text: '数量' }],
        // 静态尾行：expression 模式插值合计
        [{ contentType: 'expression', expression: '{{order.total}}' }, { text: '' }],
      ],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    const ctx = { data: { order: { no: 'NO-001', total: 5 } } }
    const model = buildTableModel({ control: c, ctx, measurer, widthMm: 100, heightMm: 50 })
    expect(model.headerRows[0]!.cells[0]!.text).toBe('NO-001')
    const staticRow = model.rows.find((r) => r.kind === 'static')
    expect(staticRow).toBeTruthy()
    expect(staticRow!.cells[0]!.text).toBe('5')
  })

  it('表头/静态行绑定 cell.field 应解析主表标量（回归：staticCellText 曾忽略 field）', () => {
    const c = {
      ...control,
      dataSource: '',
      headerRows: 1,
      staticRows: 1,
      cells: [
        [{ field: 'order.no' }, { text: '数量' }],
        [{ field: 'order.total' }, { text: '' }],
      ],
    } as unknown as Parameters<typeof buildTableModel>[0]['control']
    const ctx = { data: { order: { no: 'NO-001', total: 5 } } }
    const model = buildTableModel({ control: c, ctx, measurer, widthMm: 100, heightMm: 50 })
    // 表头单元格：绑定 order.no → 解析出主表标量（修复前为空）
    expect(model.headerRows[0]!.cells[0]!.text).toBe('NO-001')
    // 静态尾行单元格：绑定 order.total → 解析出 5
    const staticRow = model.rows.find((r) => r.kind === 'static')
    expect(staticRow).toBeTruthy()
    expect(staticRow!.cells[0]!.text).toBe('5')
  })
})

describe('sliceTable —— 分页切片（含空尾片回归）', () => {
  function mkModel(rowCount: number): Model {
    return {
      control: { id: 't', type: 'table', options: { repeatHeader: true, repeatFooter: false } } as Model['control'],
      columns: [],
      columnWidths: [],
      headerRows: [{ kind: 'header', height: 8, cells: [] }],
      rows: Array.from({ length: rowCount }, (_, i) => ({
        kind: 'data',
        height: 8,
        dataIndex: i,
        cells: [],
      })) as Model['rows'],
      footerRows: [{ kind: 'summary', height: 8, cells: [{ text: '合计', align: 'left' }] }],
      dataRows: [],
      warnings: [],
      isLayoutGrid: false,
    } as Model
  }

  it('从 start=0 切片：取全部行，末片挂合计行', () => {
    const model = mkModel(3)
    const slice = sliceTable(model, { avail: 100, start: 0 })
    expect(slice.rows.length).toBe(3)
    expect(slice.footerRows.length).toBeGreaterThan(0) // 末片 + 空间充足 → 合计行
    expect(slice.isLast).toBe(true)
    expect(slice.nextStart).toBe(3)
  })

  it('空尾片（start 越界）不挂合计行，也不产出多余数据行', () => {
    const model = mkModel(3)
    const slice = sliceTable(model, { avail: 100, start: 3 })
    expect(slice.rows.length).toBe(0) // 关键回归：不再渲染第二个空表
    expect(slice.footerRows.length).toBe(0) // 关键回归：空尾片不再挂合计
    expect(slice.isLast).toBe(true)
    expect(slice.nextStart).toBe(3)
  })

  it('空间不足时本页少放，nextStart 后移（行预算含 0.2mm 边框，防渲染溢出压页脚）', () => {
    const model = mkModel(5)
    // 默认 borders:'all'：header 8+0.2、每行 8+0.2。avail=24 → budget=24-8.2=15.8，
    // 仅放得下 1 行（1×8.2=8.2≤15.8；第 2 行 16.4>15.8）——宁少排一行，不压页脚。
    const slice = sliceTable(model, { avail: 24, start: 0 })
    expect(slice.rows.length).toBe(1)
    expect(slice.nextStart).toBe(1)
    expect(slice.isLast).toBe(false)
  })
})

/* ----------------------- 合计行（options.summaryRow） ----------------------- */

function mkSummaryControl(
  opts: TableControl['options'],
  columns?: TableColumn[],
): Parameters<typeof buildTableModel>[0]['control'] {
  return {
    id: 'tbl',
    type: 'table',
    left: 0,
    top: 0,
    width: 100,
    height: 50,
    dataSource: 'items',
    columns: columns ?? [
      { field: 'name', title: '名称', width: 60, align: 'left' },
      { field: 'qty', title: '数量', width: 40, align: 'right' },
    ],
    options: opts,
  } as unknown as Parameters<typeof buildTableModel>[0]['control']
}

describe('buildTableModel —— 合计行（options.summaryRow）', () => {
  const measurer = createCjkMeasurer()

  it('求和：表尾合计行在聚合列显示总和，首列显示标签', () => {
    const ctx = { data: { items: [{ name: 'A', qty: 1 }, { name: 'B', qty: 2 }, { name: 'C', qty: 3 }] } }
    const model = buildTableModel({
      control: mkSummaryControl({ summaryRow: { type: 'sum', fields: ['qty'], label: '合计' } }),
      ctx,
      measurer,
      widthMm: 100,
      heightMm: 50,
    })
    expect(model.footerRows.length).toBe(1)
    const row = model.footerRows[0]!
    expect(row.kind).toBe('summary')
    expect(row.cells[0]!.text).toBe('合计')
    const qtyCell = row.cells.find((c) => c.text === '6')
    expect(qtyCell).toBeTruthy()
    expect(qtyCell!.bold).toBe(true)
    expect(qtyCell!.align).toBe('right')
  })

  it('计数：聚合列显示数据总行数', () => {
    const ctx = { data: { items: [{ name: 'A', qty: 1 }, { name: 'B', qty: 2 }, { name: 'C', qty: 3 }] } }
    const model = buildTableModel({
      control: mkSummaryControl({ summaryRow: { type: 'count', fields: ['qty'], label: '合计' } }),
      ctx,
      measurer,
      widthMm: 100,
      heightMm: 50,
    })
    const row = model.footerRows[0]!
    expect(row.cells.find((c) => c.text === '3')).toBeTruthy()
  })

  it('合计值沿用该列的显示格式（currency → 带币种符号与小数位）', () => {
    const columns: TableColumn[] = [
      { field: 'name', title: '名称', width: 60, align: 'left' },
      {
        field: 'amount',
        title: '金额',
        width: 40,
        align: 'right',
        format: { kind: 'currency', code: 'CNY', digits: 2, thousands: true },
      },
    ]
    const ctx = {
      data: { items: [{ name: 'A', amount: 4200 }, { name: 'B', amount: 1800.5 }] },
    }
    const model = buildTableModel({
      control: mkSummaryControl({ summaryRow: { type: 'sum', fields: ['amount'], label: '合计' } }, columns),
      ctx,
      measurer,
      widthMm: 100,
      heightMm: 50,
    })
    const texts = model.footerRows[0]!.cells.map((c) => c.text)
    // 6000.5 按列格式渲染成 ¥6,000.50，而不是老逻辑的 6,000.50
    expect(texts).toContain('¥6,000.50')
  })

  it('合计值在列未配置 format 时回退老格式（整数不带小数、统一千分位）', () => {
    const ctx = { data: { items: [{ name: 'A', qty: 1234 }, { name: 'B', qty: 1 }] } }
    const model = buildTableModel({
      control: mkSummaryControl({ summaryRow: { type: 'sum', fields: ['qty'], label: '合计' } }),
      ctx,
      measurer,
      widthMm: 100,
      heightMm: 50,
    })
    const texts = model.footerRows[0]!.cells.map((c) => c.text)
    expect(texts).toContain('1,235')
  })

  it('未配置合计行时不生成表尾', () => {
    const ctx = { data: { items: [{ name: 'A', qty: 1 }] } }
    const model = buildTableModel({
      control: mkSummaryControl({}),
      ctx,
      measurer,
      widthMm: 100,
      heightMm: 50,
    })
    expect(model.footerRows.length).toBe(0)
  })
})

describe('buildTableModel —— 分组小计（groupBy + summaryRow）', () => {
  const measurer = createCjkMeasurer()
  const control = {
    id: 'tbl',
    type: 'table',
    left: 0,
    top: 0,
    width: 100,
    height: 50,
    dataSource: 'items',
    groupBy: 'cat',
    columns: [
      { field: 'name', title: '名称', width: 60, align: 'left' },
      { field: 'qty', title: '数量', width: 40, align: 'right' },
    ],
    options: { summaryRow: { type: 'sum', fields: ['qty'], label: '合计' } },
  } as unknown as Parameters<typeof buildTableModel>[0]['control']

  it('按分组字段生成组头 + 每组小计 + 末尾总计', () => {
    const ctx = {
      data: {
        items: [
          { name: 'A', qty: 1, cat: 'x' },
          { name: 'B', qty: 2, cat: 'x' },
          { name: 'C', qty: 3, cat: 'y' },
        ],
      },
    }
    const model = buildTableModel({ control, ctx, measurer, widthMm: 100, heightMm: 50 })
    expect(model.rows.some((r) => r.kind === 'group')).toBe(true)
    const subs = model.rows.filter((r) => r.kind === 'subtotal')
    expect(subs.length).toBe(2)
    // 每组内求和：x=1+2=3，y=3，均显示 3
    expect(subs.every((s) => s.cells.find((c) => c.text === '3'))).toBe(true)
    // 末尾总计 = 1+2+3 = 6
    const total = model.footerRows.find((r) => r.kind === 'summary')
    expect(total?.cells.find((c) => c.text === '6')).toBeTruthy()
  })

  it('分组小计应用自定义标签与样式', () => {
    const ctx = {
      data: {
        items: [
          { name: 'A', qty: 1, cat: 'x' },
          { name: 'B', qty: 2, cat: 'x' },
        ],
      },
    }
    const model = buildTableModel({
      control: {
        id: 'tbl',
        type: 'table',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        dataSource: 'items',
        groupBy: 'cat',
        columns: [
          { field: 'name', title: '名称', width: 60, align: 'left' },
          { field: 'qty', title: '数量', width: 40, align: 'right' },
        ],
        options: {
          summaryRow: {
            type: 'sum',
            fields: ['qty'],
            label: '总计',
            subtotalLabel: '${key} 分组小计',
            subtotalStyle: { bold: true, backgroundColor: '#EEF3FF', color: '#c00' },
          },
        },
      } as unknown as Parameters<typeof buildTableModel>[0]['control'],
      ctx,
      measurer,
      widthMm: 100,
      heightMm: 50,
    })
    const subs = model.rows.filter((r) => r.kind === 'subtotal')
    expect(subs.length).toBe(1)
    expect(subs[0]!.cells[0]!.text).toBe('x 分组小计')
    // 整行套用 subtotalStyle（标签格也应带颜色）
    expect(subs[0]!.cells[0]!.color).toBe('#c00')
    expect(subs[0]!.cells[0]!.background).toBe('#EEF3FF')
    // 聚合列显示本组求和 1+2=3
    expect(subs[0]!.cells.find((c) => c.text === '3')).toBeTruthy()
  })

  it('自定义合计表达式在表尾生效（footer 显示求值结果）', () => {
    const ctx = { data: { items: [{ name: 'A', amount: 10 }, { name: 'B', amount: 20 }] } }
    const model = buildTableModel({
      control: {
        id: 'tbl',
        type: 'table',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        dataSource: 'items',
        // 首列为非聚合列（放标签），第二列为聚合列（放自定义求值结果）
        columns: [
          { field: 'name', title: '名称', width: 60, align: 'left' },
          { field: 'amount', title: '金额', width: 40, align: 'right' },
        ],
        options: {
          summaryRow: {
            type: 'custom',
            fields: ['amount'],
            label: '自定义合计',
            expression: 'sum.amount + 5',
          },
        },
      } as unknown as Parameters<typeof buildTableModel>[0]['control'],
      ctx,
      measurer,
      widthMm: 100,
      heightMm: 50,
    })
    expect(model.footerRows.length).toBe(1)
    const row = model.footerRows[0]!
    expect(row.kind).toBe('summary')
    expect(row.cells[0]!.text).toBe('自定义合计')
    // 聚合列显示 (10+20) + 5 = 35
    expect(row.cells.find((c) => c.text === '35')).toBeTruthy()
  })
})

describe('rowSpan 纵向合并渲染', () => {
  const measurer = createCjkMeasurer()

  it('布局网格：纵向合并时下方被吞单元格不进 cells，锚点带 rowSpan', () => {
    const control = {
      id: 'tbl',
      type: 'table',
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      columns: [
        { title: 'A', width: 50 },
        { title: 'B', width: 50 },
      ],
      headerRows: 0,
      designRows: 2,
      cells: [
        [
          { rowSpan: 2, text: '合并' },
          { text: '右1' },
        ],
        [
          { text: '下左' },
          { text: '下右' },
        ],
      ],
      options: {},
    } as unknown as TableControl

    const model = buildTableModel({ control, ctx: { data: {} }, measurer, widthMm: 100, heightMm: 40 })
    expect(model.isLayoutGrid).toBe(true)
    // 第 0 行：锚点(合并, rowSpan=2) + 右1 → 2 个单元格
    expect(model.rows[0]!.cells.length).toBe(2)
    expect(model.rows[0]!.cells[0]!.rowSpan).toBe(2)
    // 第 1 行：被吞的"下左"不出现，只剩"下右" → 1 个单元格
    expect(model.rows[1]!.cells.length).toBe(1)
    expect(model.rows[1]!.cells[0]!.text).toBe('下右')
  })

  it('数据行模板的 rowSpan 被强制为 1（不跨记录）', () => {
    const control = {
      id: 'tbl',
      type: 'table',
      left: 0,
      top: 0,
      width: 100,
      height: 60,
      dataSource: 'items',
      columns: [
        { field: 'name', title: '名称', width: 50 },
        { field: 'qty', title: '数量', width: 50 },
      ],
      cells: [
        [{ text: '名称' }, { text: '数量' }],
        [{ rowSpan: 2, field: 'name' }, { field: 'qty' }],
      ],
      options: {},
    } as unknown as TableControl

    const ctx = { data: { items: [{ name: 'A', qty: 1 }, { name: 'B', qty: 2 }] } }
    const model = buildTableModel({ control, ctx, measurer, widthMm: 100, heightMm: 60 })
    // 每条数据行的首格不应带 rowSpan（避免跨记录合并）
    expect(model.rows.every((r) => r.cells[0]!.rowSpan === undefined)).toBe(true)
  })
})

describe('buildTableModel —— 内嵌 data（与 dataSource 字段解耦）', () => {
  const measurer = createCjkMeasurer()

  it('无 dataSource、带 data 时按内嵌数据生成数据行并解析字段', () => {
    const control = {
      id: 'tbl',
      type: 'table',
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      // 注意：这里刻意不设置 dataSource
      columns: [
        { title: '名称', field: 'items[].name', width: 50 },
        { title: '数量', field: 'items[].qty', width: 50 },
      ],
      headerRows: 1,
      data: [
        { name: 'A', qty: 1 },
        { name: 'B', qty: 2 },
      ],
      options: { pageRows: 'auto', repeatHeader: true, borders: 'all' },
    } as unknown as TableControl

    // 全局 ctx 里没有任何 items，证明数据完全来自 control.data
    const ctx = { data: {} } as unknown as EvalContext
    const model = buildTableModel({ control, ctx, measurer, widthMm: 100, heightMm: 50 })
    expect(model.rows).toHaveLength(2)
    expect(model.rows[0]!.cells[0]!.text).toBe('A')
    expect(model.rows[1]!.cells[1]!.text).toBe('2')
    // 表头来自 columns.title
    expect(model.headerRows[0]!.cells[0]!.text).toBe('名称')
  })

  it('isDataTable 对内嵌 data 返回 true（供 analyzeBody 识别为分页流表）', () => {
    const withData = {
      id: 't',
      type: 'table',
      columns: [],
      data: [{ a: 1 }],
    } as unknown as TableControl
    expect(isDataTable(withData)).toBe(true)
    const empty = {
      id: 't2',
      type: 'table',
      columns: [],
      data: [],
    } as unknown as TableControl
    expect(isDataTable(empty)).toBe(false)
  })
})

describe('sliceTable —— 分页聚合（本页合计 / 总计 / 大写金额）', () => {
  const measurer = createCjkMeasurer()
  const amountCol = 1

  function mkSeededTable(): Model {
    const control = {
      id: 't',
      type: 'table',
      left: 0,
      top: 0,
      width: 180,
      height: 50,
      dataSource: 'items',
      columns: [
        { title: '名称', field: 'items[].name', width: 120, align: 'left', headerAlign: 'center' },
        { title: '金额', field: 'items[].amount', width: 60, align: 'right', headerAlign: 'center' },
      ],
      // 10 行内嵌数据，金额 10,20,...,100（全表合计 550）
      data: Array.from({ length: 10 }, (_, i) => ({ name: 'x' + (i + 1), amount: (i + 1) * 10 })),
      options: { repeatHeader: true, repeatFooter: false, pageRows: 2 } as TableControl['options'],
    } as unknown as TableControl
    const seeded = seedSummaryTail(control, { numericColumns: [amountCol], moneyColumn: amountCol, capital: true })
    return buildTableModel({ control: seeded, ctx: {} as EvalContext, measurer, widthMm: 180, heightMm: 50 })
  }

  function sliceAll(model: Model): ReturnType<typeof sliceTable>[] {
    const out: ReturnType<typeof sliceTable>[] = []
    let start = 0
    for (let p = 0; p < 20; p++) {
      const s = sliceTable(model, { avail: 1000, start })
      out.push(s)
      if (s.isLast) break
      start = s.nextStart
    }
    return out
  }

  const num = (t: string | undefined): number => Number((t ?? '').replace(/,/g, ''))

  it('每页本页合计 = 本页数据行之和；非末页不出现总计 / 大写金额', () => {
    const slices = sliceAll(mkSeededTable())
    expect(slices.length).toBe(5) // 10 行 / 每页 2 行
    slices.forEach((s, p) => {
      const subtotal = s.footerRows.find((r) => r.kind === 'subtotal')
      expect(subtotal, `第 ${p + 1} 页应有本页合计`).toBeTruthy()
      const pageSum = num(subtotal!.cells[amountCol]!.text)
      const expected = (p * 2 + 1) * 10 + (p * 2 + 2) * 10
      expect(pageSum).toBe(expected)
      if (p < slices.length - 1) {
        expect(s.footerRows.some((r) => r.footerKind === 'grandTotal')).toBe(false)
        expect(s.footerRows.some((r) => r.footerKind === 'capital')).toBe(false)
      }
    })
  })

  it('末页出现总计（全表之和=550）与大写金额（伍佰伍拾元整）；末页本页合计=末页本页之和', () => {
    const slices = sliceAll(mkSeededTable())
    const last = slices[slices.length - 1]!
    const total = last.footerRows.find((r) => r.footerKind === 'grandTotal')
    const cap = last.footerRows.find((r) => r.footerKind === 'capital')
    expect(total, '末页应有总计').toBeTruthy()
    expect(cap, '末页应有大写金额').toBeTruthy()
    expect(num(total!.cells[amountCol]!.text)).toBe(550) // 10+20+...+100
    expect(cap!.cells[amountCol]!.text).toBe('伍佰伍拾元整')
    // 末页本页合计 = 末页本页数据（第 9、10 行 90+100）
    const subtotal = last.footerRows.find((r) => r.kind === 'subtotal')
    expect(num(subtotal!.cells[amountCol]!.text)).toBe(190)
  })
})
