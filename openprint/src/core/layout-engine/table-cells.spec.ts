/**
 * 设计期单元格网格模型单测（table-cells.ts）
 *
 * 覆盖：有/无 cells 的回落、buildDesignGrid 行语义、ensureCells 物化、
 * patchCellText（表头/静态/数据样例行语义）、patchCellStyle（合并/清除）、
 * setCellSpan（横向合并 + 吞格清空）、resolveCellStyle 优先级、normalizeCellRows、designRowInfo。
 */
import { describe, expect, it } from 'vitest'
import type { TableCell, TableControl } from '@/types/control'
import {
  addTableColumn,
  buildDesignGrid,
  computeSpanLayout,
  designRowHeights,
  designRowInfo,
  ensureCells,
  moveTableColumn,
  normalizeCellRows,
  patchCell,
  patchCellStyle,
  patchCellText,
  removeTableColumn,
  removeTableRow,
  resolveCellStyle,
  setCellRowSpan,
  setCellSpan,
  setGridRows,
  seedSummaryTail,
  syncDataTableHeight,
} from './table-cells'

function baseTable(over: Partial<TableControl> = {}): TableControl {
  return {
    id: 't1',
    type: 'table',
    left: 0,
    top: 0,
    width: 180,
    height: 60,
    columns: [
      { title: '序号', expression: '{{rowIndex + 1}}', width: 15, align: 'center', headerAlign: 'center' },
      { title: '名称', field: 'name', width: 60 },
      { title: '数量', field: 'qty', width: 25, align: 'right', headerAlign: 'center' },
    ],
    options: { borders: 'all', verticalAlign: 'middle' },
    ...over,
  }
}

describe('buildDesignGrid', () => {
  it('数据表无 cells：由列配置瞬时推导 表头+数据样例行+静态尾行', () => {
    const g = buildDesignGrid(baseTable({ dataSource: 'items', staticRows: 1 }))
    expect(g.isData).toBe(true)
    expect(g.headerRows).toBe(1)
    expect(g.rowCount).toBe(1 + 1 + 1) // header + data template + 1 static
    expect(g.colCount).toBe(3)
    // 表头第 1 行：文本=列标题、加粗、对齐跟随 headerAlign
    expect(g.cells[0]![0]!.text).toBe('序号')
    expect(g.cells[0]![0]!.style?.bold).toBe(true)
    expect(g.cells[0]![0]!.style?.align).toBe('center')
    // 数据样例行第 2 行：带 field（来自列配置的 field）
    expect(g.cells[1]![1]!.field).toBe('name')
    expect(g.cells[1]![2]!.field).toBe('qty')
    // 静态尾行：空
    expect(g.cells[2]![0]).toEqual({})
  })

  it('布局网格（无 dataSource）无 cells：行数取 designRows（含表头）', () => {
    const g = buildDesignGrid(baseTable({ designRows: 4 }))
    expect(g.isData).toBe(false)
    expect(g.headerRows).toBe(1) // 列有标题 → 自动补 1 行表头
    expect(g.rowCount).toBe(5) // 1 表头 + 4 正文
    expect(g.colCount).toBe(3)
    expect(g.cells.every((r) => r.length === 3)).toBe(true)
  })

  it('已有 cells：按语义行数归一化（列数补齐到当前列数）', () => {
    const cells = [
      [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: '多余列应被丢弃' }],
      [{ text: 'x' }, { text: 'y' }, { text: 'z' }],
    ]
    const g = buildDesignGrid(baseTable({ dataSource: 'items', cells, staticRows: 0 }))
    expect(g.rowCount).toBe(2) // header(1) + data(1) + 0
    expect(g.colCount).toBe(3)
    expect(g.cells[0]![3]).toBeUndefined()
    expect(g.cells[0]![0]!.text).toBe('A')
  })

  it('列数为 0 时兜底为 1 列，不崩溃', () => {
    const g = buildDesignGrid(baseTable({ columns: [] }))
    expect(g.colCount).toBe(1)
    expect(g.rowCount).toBeGreaterThan(0)
  })
})

describe('ensureCells', () => {
  it('无 cells 时物化出完整网格并带上语义行数', () => {
    const next = ensureCells(baseTable({ dataSource: 'items', staticRows: 1 }))
    expect(next.cells).toBeDefined()
    expect(next.cells!.length).toBe(3)
    expect(next.headerRows).toBe(1)
    expect(next.staticRows).toBe(1)
    expect(next.designRows).toBe(0)
  })

  it('已存在且尺寸匹配则返回结构（不重建，保持既有内容）', () => {
    const cells = [
      [{ text: 'H1' }, { text: 'H2' }, { text: 'H3' }],
      [{ field: 'a' }, { field: 'b' }, { field: 'c' }],
    ]
    const orig = baseTable({ dataSource: 'items', cells, staticRows: 0 })
    const next = ensureCells(orig)
    expect(next.cells).toBe(cells)
    expect(next.headerRows).toBe(1)
  })
})

describe('patchCellText 行语义', () => {
  it('表头/静态行：写 text 字面量', () => {
    const t = baseTable({ dataSource: 'items', staticRows: 1 })
    const next = patchCellText(t, 0, 0, '序号X') // 表头行
    expect(next.cells![0]![0]!.text).toBe('序号X')
  })

  it('静态尾行：写 text 字面量', () => {
    const t = baseTable({ dataSource: 'items', staticRows: 1 })
    const next = patchCellText(t, 2, 0, '合计') // 静态行
    expect(next.cells![2]![0]!.text).toBe('合计')
  })

  it('数据样例行：与当前占位符一致 → 原样返回（不固化占位符）', () => {
    const t = baseTable({ dataSource: 'items' })
    const next = patchCellText(t, 1, 1, '{{item.name}}')
    expect(next).toBe(t)
  })

  it('数据样例行：纯字段引用回写为 field', () => {
    const t = baseTable({ dataSource: 'items' })
    const next = patchCellText(t, 1, 1, '{{item.amount}}')
    expect(next.cells![1]![1]!.field).toBe('amount')
    expect(next.cells![1]![1]!.expression).toBeUndefined()
  })

  it('数据样例行：含表达式 → 写 expression 并清 field', () => {
    const t = baseTable({ dataSource: 'items' })
    const next = patchCellText(t, 1, 2, '{{row.price * row.qty}}')
    expect(next.cells![1]![2]!.expression).toBe('{{row.price * row.qty}}')
    expect(next.cells![1]![2]!.field).toBeUndefined()
  })

  it('数据样例行：清空 → 同时清 expression 与 field', () => {
    const t = baseTable({ dataSource: 'items' })
    const next = patchCellText(t, 1, 1, '')
    expect(next.cells![1]![1]!.expression).toBeUndefined()
    expect(next.cells![1]![1]!.field).toBeUndefined()
  })
})

describe('patchCellStyle / resolveCellStyle', () => {
  it('resolveCellStyle 优先级：单元格 > 列 > 表格默认', () => {
    const t = baseTable({
      options: { defaultCellStyle: { align: 'left', color: '#000' } },
      columns: [{ title: 'A', width: 10, style: { align: 'center', color: '#f00' } }],
    })
    const resolved = resolveCellStyle(t, t.columns[0], { style: { align: 'right', bold: true } })
    expect(resolved.align).toBe('right') // 单元格覆盖
    expect(resolved.color).toBe('#f00') // 列兜底
    expect(resolved.bold).toBe(true)
  })

  it('patchCellStyle 合并并覆盖传入键；undefined 表示清除', () => {
    let t = baseTable({ dataSource: 'items' })
    t = patchCellStyle(t, 0, 0, { bold: true, color: '#ff0000' })
    expect(t.cells![0]![0]!.style?.bold).toBe(true)
    expect(t.cells![0]![0]!.style?.color).toBe('#ff0000')
    t = patchCellStyle(t, 0, 0, { color: undefined })
    expect(t.cells![0]![0]!.style?.bold).toBe(true)
    expect(t.cells![0]![0]!.style?.color).toBeUndefined()
  })
})

describe('setCellSpan 横向合并', () => {
  it('本格 colSpan=n，被吞格清空（保留矩阵规整）', () => {
    const t = baseTable({ dataSource: 'items' })
    const next = setCellSpan(t, 1, 0, 2) // 数据样例行第0列合并2列
    expect(next.cells![1]![0]!.colSpan).toBe(2)
    expect(next.cells![1]![1]!.text).toBeUndefined()
    expect(next.cells![1]![1]!.field).toBeUndefined()
    expect(next.cells![1]![1]!.colSpan).toBeUndefined()
  })

  it('合并数越界自动夹紧到剩余列数', () => {
    const t = baseTable({ dataSource: 'items' })
    const next = setCellSpan(t, 1, 1, 99) // 剩 2 列（c=1,2）
    expect(next.cells![1]![1]!.colSpan).toBe(2)
  })
})

describe('designRowInfo', () => {
  it('数据表行语义正确', () => {
    const g = buildDesignGrid(baseTable({ dataSource: 'items', staticRows: 1 }))
    expect(designRowInfo(g, 0).kind).toBe('header')
    expect(designRowInfo(g, 1).kind).toBe('data')
    expect(designRowInfo(g, 1).isDataTemplate).toBe(true)
    expect(designRowInfo(g, 2).kind).toBe('static')
  })

  it('布局网格：第 0 行为表头，其余为 static', () => {
    const g = buildDesignGrid(baseTable({ designRows: 3 }))
    expect(designRowInfo(g, 0).kind).toBe('header')
    expect(designRowInfo(g, 1).kind).toBe('static')
    expect(designRowInfo(g, 2).kind).toBe('static')
  })
})

describe('normalizeCellRows', () => {
  it('行/列不足补空、超出截断', () => {
    const out = normalizeCellRows([[{ text: 'a' }], [{ text: 'b' }, { text: 'c' }]], 3, 2)
    expect(out.length).toBe(3)
    expect(out[0]!.length).toBe(2)
    expect(out[0]![0]!.text).toBe('a')
    expect(out[0]![1]).toEqual({})
    expect(out[1]![1]!.text).toBe('c')
  })
})

describe('patchCell 不可变更新', () => {
  it('返回新控件且只改目标格', () => {
    const t = baseTable({ dataSource: 'items' })
    const next = patchCell(t, 0, 0, { text: '改' })
    expect(next).not.toBe(t)
    expect(next.cells![0]![0]!.text).toBe('改')
    expect(t.cells).toBeUndefined()
  })
})

describe('网格结构变更（#100）', () => {
  it('setGridRows 布局网格增正文行：保留已有内容并按目标维度补空', () => {
    const t = ensureCells(baseTable({ designRows: 2 }))
    t.cells![0]![0] = { text: 'H' }
    t.cells![1]![1] = { text: 'B' }
    const next = setGridRows(t, { designRows: 4 })
    expect(next.headerRows).toBe(1)
    expect(next.designRows).toBe(4)
    expect(next.cells!.length).toBe(5) // 1 表头 + 4 正文
    expect(next.cells![0]![0]!.text).toBe('H') // 表头保留
    expect(next.cells![1]![1]!.text).toBe('B') // 正文保留
    expect(next.cells![4]![0]).toEqual({}) // 新补空行
  })

  it('setGridRows 数据表增静态尾行', () => {
    const t = ensureCells(baseTable({ dataSource: 'items', staticRows: 0 }))
    const next = setGridRows(t, { staticRows: 2 })
    expect(next.staticRows).toBe(2)
    expect(next.cells!.length).toBe(4) // 1 表头 + 1 数据样例 + 2 尾
    expect(Boolean(next.dataSource?.trim())).toBe(true)
  })

  it('setGridRows 改表头行数：新增表头行用列标题兜底', () => {
    const t = baseTable({ designRows: 2 })
    const next = setGridRows(t, { headerRows: 2 })
    expect(next.headerRows).toBe(2)
    expect(next.cells!.length).toBe(4) // 2 表头 + 2 正文
    expect(next.cells![1]![0]!.text).toBe('序号') // 新表头行取列标题
  })

  it('setGridRows 减行数：截断尾部（保留前面内容）', () => {
    const t = ensureCells(baseTable({ designRows: 5 }))
    t.cells![0]![0] = { text: 'H' }
    const next = setGridRows(t, { designRows: 2 })
    expect(next.cells!.length).toBe(3) // 1 表头 + 2 正文
    expect(next.cells![0]![0]!.text).toBe('H')
  })

  it('addTableColumn：列与每行单元格同步增加，新列表头默认填标题', () => {
    const t = ensureCells(baseTable({ designRows: 2 }))
    const next = addTableColumn(t, { title: '新列', width: 20 })
    expect(next.columns.length).toBe(4)
    expect(next.cells!.every((r) => r.length === 4)).toBe(true)
    expect(next.cells![0]![3]!.text).toBe('新列') // 表头新列取标题
  })

  it('removeTableColumn：删除指定列（含对应单元格），至少留 1 列', () => {
    const t = ensureCells(baseTable({ designRows: 2 }))
    t.cells![0]![1] = { text: 'B-col1' }
    const next = removeTableColumn(t, 1)
    expect(next.columns.length).toBe(2)
    expect(next.cells!.every((r) => r.length === 2)).toBe(true)
    expect(next.columns[0]!.title).toBe('序号')
    expect(next.columns[1]!.title).toBe('数量') // 原第 2 列（数量）左移
    expect(next.cells![0]![1]!.text).toBe('数量') // 单元格同步左移
  })

  it('removeTableColumn：最后一列不可删', () => {
    const t = baseTable({ columns: [{ title: 'only', width: 10 }] })
    const next = removeTableColumn(t, 0)
    expect(next.columns.length).toBe(1)
  })

  it('removeTableRow：删除指定行（含对应单元格），至少留 1 行', () => {
    const t = ensureCells(baseTable({ designRows: 3 }))
    t.cells![2]![0] = { text: '第三行' }
    const next = removeTableRow(t, 2)
    const grid = buildDesignGrid(next)
    expect(grid.rowCount).toBe(3) // 4 行 - 1
    expect(grid.designRows).toBe(2)
    expect(grid.cells.some((r) => r[0]?.text === '第三行')).toBe(false)
    expect(grid.cells[1]![0]?.text).toBeUndefined() // 第 2 行未受影响
  })

  it('removeTableRow：删表头行时 headerRows 减一', () => {
    const t = ensureCells(baseTable({ designRows: 2 }))
    const next = removeTableRow(t, 0)
    expect(buildDesignGrid(next).headerRows).toBe(0)
    expect(buildDesignGrid(next).rowCount).toBe(2)
  })

  it('removeTableRow：数据表的数据样例行（唯一 body 行）不可删', () => {
    const t = ensureCells(baseTable({ dataSource: 'items', staticRows: 1 }))
    const next = removeTableRow(t, 1) // 第 1 行是数据样例行（headerRows=1）
    expect(next).toBe(t) // 不变
  })

  it('removeTableRow：单行表格不可删', () => {
    const t = ensureCells(baseTable({ height: 8, headerRows: 0, designRows: 0, columns: [{ title: '', width: 10 }] }))
    expect(buildDesignGrid(t).rowCount).toBe(1)
    const next = removeTableRow(t, 0)
    expect(next).toBe(t)
  })

  it('moveTableColumn：左右搬动列与单元格', () => {
    const t = ensureCells(baseTable({ designRows: 2 }))
    const next = moveTableColumn(t, 0, 2)
    expect(next.columns[2]!.title).toBe('序号')
    expect(next.cells![0]![2]!.text).toBe('序号') // 单元格同列位置搬动
    expect(next.cells![0]![0]!.text).toBe('名称')
  })
})

describe('designRowHeights —— 画布行高与渲染一致（所见即所得）', () => {
  it('数据表 auto：每行 = 单行文本估算 ≈ 6.69mm（9pt×1.35 + 上下 padding 各 1.2mm）', () => {
    const rows = designRowHeights(baseTable({ dataSource: 'items', staticRows: 2, height: 999 }))
    const grid = buildDesignGrid(baseTable({ dataSource: 'items', staticRows: 2 }))
    expect(rows.length).toBe(grid.rowCount) // 表头 + 数据样例 + 2 静态
    const expected = (9 * (25.4 / 72)) * 1.35 + 2 * 1.2
    for (const h of rows) {
      expect(h).toBeCloseTo(expected, 3)
    }
    expect(expected).toBeCloseTo(6.686, 2) // 远小于旧算法的 12mm，与渲染端单行一致
  })

  it('数据表 fixed：每行 = 指定行高', () => {
    const rows = designRowHeights(
      baseTable({ dataSource: 'items', staticRows: 1, options: { rowHeightMode: 'fixed', rowHeight: 10 } }),
    )
    expect(rows.every((h) => h === 10)).toBe(true)
  })

  it('数据表 fixed：缺省回退 8mm，且不低于 6mm 下限（与渲染端 MIN_ROW_HEIGHT 一致）', () => {
    const rows = designRowHeights(baseTable({ dataSource: 'items', options: { rowHeightMode: 'fixed' } }))
    expect(rows.every((h) => h === 8)).toBe(true)
  })

  it('布局网格：各行高度之和恰等于控件高度（画布 = 打印）', () => {
    const t = baseTable({ designRows: 3, height: 50 })
    const rows = designRowHeights(t, t.height)
    const sum = rows.reduce((s, h) => s + h, 0)
    expect(sum).toBeCloseTo(50, 6)
  })

  it('syncDataTableHeight：数据表控件高度 = 所有行高之和', () => {
    const t = baseTable({ dataSource: 'items', staticRows: 2, height: 999 })
    const synced = syncDataTableHeight(t)
    const rows = designRowHeights(t)
    expect(synced.height).toBeCloseTo(rows.reduce((s, h) => s + h, 0), 6)
    expect(synced.height).toBeLessThan(50) // 不再虚高
  })

  it('syncDataTableHeight：行数变化后高度跟随（增静态尾行）', () => {
    const before = syncDataTableHeight(baseTable({ dataSource: 'items', staticRows: 0, height: 999 }))
    const after = syncDataTableHeight(
      setGridRows(ensureCells(baseTable({ dataSource: 'items', staticRows: 0 })), { staticRows: 3 }),
    )
    expect(after.height).toBeGreaterThan(before.height)
  })
})

describe('seedSummaryTail —— 默认尾行居中', () => {
  it('植入的本页合计 / 总计 / 大写金额 尾行（有文本的单元格）全部居中对齐', () => {
    const t = baseTable({ dataSource: 'items', staticRows: 0 })
    const seeded = seedSummaryTail(t, { numericColumns: [1, 2], moneyColumn: 2, capital: true })
    const grid = buildDesignGrid(seeded)
    const tail = grid.cells.slice(grid.headerRows + 1) // 跳过表头 + 数据样例行
    expect(tail.length).toBe(3) // 本页合计 + 总计 + 大写金额
    for (const row of tail) {
      for (const cell of row) {
        if (cell.text) expect(cell.style?.align).toBe('center')
      }
    }
  })
})

describe('computeSpanLayout 合并布局', () => {
  // 构造 cells 矩阵的便捷函数：rows 是「每行每列的对象字面量」二维数组
  const mk = (rows: Array<Array<Partial<{ colSpan: number; rowSpan: number }>>>): TableCell[][] =>
    rows.map((r) => r.map((c) => ({ ...c })))

  it('无合并：全部 skip=false、跨度=1', () => {
    const cells = mk([
      [{}, {}],
      [{}, {}],
    ])
    const layout = computeSpanLayout(cells, 2, 2)
    expect(layout.every((r) => r.every((s) => !s.skip && s.colSpan === 1 && s.rowSpan === 1))).toBe(true)
  })

  it('横向合并：锚点 colSpan=2，右侧被吞', () => {
    const cells = mk([
      [{ colSpan: 2 }, {}],
      [{}, {}],
    ])
    const layout = computeSpanLayout(cells, 2, 2)
    expect(layout[0]![0]!.colSpan).toBe(2)
    expect(layout[0]![0]!.skip).toBe(false)
    expect(layout[0]![1]!.skip).toBe(true) // 被横向吞掉
    expect(layout[1]![1]!.skip).toBe(false) // 下一行不受同行跨列影响
  })

  it('纵向合并：锚点 rowSpan=2，下方同列被吞', () => {
    const cells = mk([
      [{ rowSpan: 2 }, {}],
      [{}, {}],
    ])
    const layout = computeSpanLayout(cells, 2, 2)
    expect(layout[0]![0]!.rowSpan).toBe(2)
    expect(layout[1]![0]!.skip).toBe(true) // 被纵向吞掉
    expect(layout[0]![1]!.skip).toBe(false)
    expect(layout[1]![1]!.skip).toBe(false)
  })

  it('跨列 + 跨行组合：2×2 块，其余三格均被吞', () => {
    const cells = mk([
      [{ colSpan: 2, rowSpan: 2 }, {}],
      [{}, {}],
    ])
    const layout = computeSpanLayout(cells, 2, 2)
    expect(layout[0]![0]!.colSpan).toBe(2)
    expect(layout[0]![0]!.rowSpan).toBe(2)
    expect(layout[0]![1]!.skip).toBe(true)
    expect(layout[1]![0]!.skip).toBe(true)
    expect(layout[1]![1]!.skip).toBe(true)
  })

  it('越界收敛：rowSpan 超出网格底边被截断', () => {
    const cells = mk([
      [{ rowSpan: 9 }, {}],
      [{}, {}],
    ])
    const layout = computeSpanLayout(cells, 2, 2)
    expect(layout[0]![0]!.rowSpan).toBe(2) // 只剩 2 行，截断为 2
    expect(layout[1]![0]!.skip).toBe(true)
  })
})

describe('setCellRowSpan 纵向合并', () => {
  it('rowSpan=2：本格写 rowSpan，下方同列清空', () => {
    const t = ensureCells(baseTable({ designRows: 3 }))
    const next = setCellRowSpan(t, 0, 0, 2)
    expect(next.cells![0]![0]!.rowSpan).toBe(2)
    expect(next.cells![1]![0]!.text).toBeUndefined()
    expect(next.cells![1]![0]!.field).toBeUndefined()
    expect(next.cells![2]![0]!.rowSpan).toBeUndefined() // 只吞 2 行
  })

  it('rowSpan=1：清除合并', () => {
    const t = ensureCells(baseTable({ designRows: 3 }))
    const merged = setCellRowSpan(t, 0, 0, 2)
    const cleared = setCellRowSpan(merged, 0, 0, 1)
    expect(cleared.cells![0]![0]!.rowSpan).toBeUndefined()
  })

  it('越界 rowSpan 收敛到网格底边', () => {
    const t = ensureCells(baseTable({ designRows: 2 })) // 共 1 表头 + 2 正文 = 3 行
    const next = setCellRowSpan(t, 0, 0, 99)
    expect(next.cells![0]![0]!.rowSpan).toBe(3) // 从第 0 行到底边共 3 行
    expect(next.cells![2]![0]!.rowSpan).toBeUndefined()
  })
})
