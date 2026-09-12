/**
 * flow-label-logic.spec —— 流水标签共享纯逻辑单测（Vue 端跑，React 端同源复用）
 */
import { describe, expect, it } from 'vitest'
import {
  FLOW_PREVIEW_ROWS,
  buildMappedRowData,
  buildPrinterOptions,
  canStartBatch,
  clampPreviewIndex,
  columnOptions,
  computeFlowStats,
  computePrintTotal,
  connHint,
  filterRows,
  formatDuration,
  mergeMapping,
  pickDefaultPrinter,
  printerOptionLabel,
  rowSummary,
  shouldWaitInterval,
  type FlowRowResult,
} from './flow-label-logic'

const COLS = [
  { key: 'no', title: '编号' },
  { key: 'name', title: '品名' },
  { key: 'spec', title: '规格' },
]

describe('流水标签 · 数据与映射', () => {
  it('filterRows 剔除已删行（按原始下标）', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]
    expect(filterRows(rows, new Set([1, 3]))).toEqual([{ a: 1 }, { a: 3 }])
    expect(filterRows(rows, new Set())).toBe(rows) // 空集合直接复用原数组
  })

  it('buildMappedRowData 把映射列拍平到顶层，未映射的占位符不出现', () => {
    const row = { no: 'A001', name: '螺丝', spec: 'M3' }
    const data = buildMappedRowData({ no: 'no', batch: 'name', qty: null }, row)
    expect(data).toEqual({ no: 'A001', batch: '螺丝' })
  })

  it('buildMappedRowData 列值缺失补空串', () => {
    expect(buildMappedRowData({ no: 'no' }, {})).toEqual({ no: '' })
  })

  it('rowSummary 只输出已映射字段，行缺失给空', () => {
    expect(rowSummary({ no: 'no', name: 'name' }, { no: 'A1', name: '螺丝' })).toBe(
      'no=A1 / name=螺丝',
    )
    expect(rowSummary({ no: 'no' }, undefined)).toBe('')
  })

  it('mergeMapping 自动映射 + 保留仍存在的手动映射', () => {
    const merged = mergeMapping(['no', 'name', 'qty'], COLS, { name: 'spec' })
    expect(merged.no).toBe('no') // 自动：同名
    expect(merged.name).toBe('spec') // 手改保留
    expect(merged.qty).toBe(null) // 无对应列
  })

  it('mergeMapping 丢弃已不存在的旧映射', () => {
    const merged = mergeMapping(['no'], COLS, { no: '已删除的列' })
    expect(merged.no).toBe('no')
  })

  it('columnOptions 首项为「不映射」，标题优先', () => {
    const opts = columnOptions(COLS)
    expect(opts[0]).toEqual({ label: '— 不映射 —', value: '' })
    expect(opts[1]).toEqual({ label: '编号', value: 'no' })
    expect(opts).toHaveLength(4)
  })

  it('FLOW_PREVIEW_ROWS 与 DataImport 的 200 行上限无关，固定 50', () => {
    expect(FLOW_PREVIEW_ROWS).toBe(50)
  })
})

describe('流水标签 · 批量统计', () => {
  it('computePrintTotal：0=全部行，否则取 min', () => {
    expect(computePrintTotal(120, 0)).toBe(120)
    expect(computePrintTotal(120, 30)).toBe(30)
    expect(computePrintTotal(12, 30)).toBe(12)
  })

  it('computeFlowStats 汇总成功/失败/进度/均值/ETA', () => {
    const results: FlowRowResult[] = [
      { index: 0, success: true, durationMs: 100 },
      { index: 1, success: false, error: 'x', durationMs: 300 },
    ]
    const s = computeFlowStats({ results, printTotal: 4, elapsedMs: 400 })
    expect(s.done).toBe(2)
    expect(s.successCount).toBe(1)
    expect(s.failCount).toBe(1)
    expect(s.progressPct).toBe(50)
    expect(s.avgMs).toBe(200)
    expect(s.etaMs).toBe(400) // 200 × (4-2)
  })

  it('computeFlowStats 空结果不除零', () => {
    const s = computeFlowStats({ results: [], printTotal: 0, elapsedMs: 0 })
    expect(s.progressPct).toBe(0)
    expect(s.avgMs).toBe(0)
    expect(s.etaMs).toBe(0)
  })

  it('formatDuration 60s 分界', () => {
    expect(formatDuration(0)).toBe('0.0s')
    expect(formatDuration(1234)).toBe('1.2s')
    expect(formatDuration(95_000)).toBe('1m 35s')
  })

  it('shouldWaitInterval 最后一行与停止后不再等待', () => {
    expect(shouldWaitInterval(0, 10, 300, false)).toBe(true)
    expect(shouldWaitInterval(9, 10, 300, false)).toBe(false)
    expect(shouldWaitInterval(0, 10, 0, false)).toBe(false)
    expect(shouldWaitInterval(0, 10, 300, true)).toBe(false)
  })

  it('clampPreviewIndex 数据变少时回退到末行', () => {
    expect(clampPreviewIndex(9, 3)).toBe(2)
    expect(clampPreviewIndex(-1, 3)).toBe(0)
    expect(clampPreviewIndex(2, 0)).toBe(0)
  })
})

describe('流水标签 · 打印机与启动条件', () => {
  it('printerOptionLabel 标注默认/离线', () => {
    expect(printerOptionLabel({ name: 'P1', isDefault: true, isOnline: true })).toBe('P1 · 默认')
    expect(printerOptionLabel({ name: 'P2', isOnline: false })).toBe('P2（离线）')
  })

  it('buildPrinterOptions 离线机禁用', () => {
    const opts = buildPrinterOptions([
      { name: 'P1', isOnline: true },
      { name: 'P2', isOnline: false },
    ])
    expect(opts[0]?.disabled).toBe(false)
    expect(opts[1]?.disabled).toBe(true)
  })

  it('pickDefaultPrinter：已选在列不动，否则回落默认机', () => {
    const printers = [{ name: 'A' }, { name: 'B' }]
    expect(pickDefaultPrinter('B', printers, { name: 'A' })).toBe('B')
    expect(pickDefaultPrinter('已移除', printers, { name: 'A' })).toBe('A')
    expect(pickDefaultPrinter('', printers, null)).toBe('')
  })

  it('connHint 区分"已连上但无打印机"与"不可达"', () => {
    expect(connHint('connected', '')).toBe('已连上客户端但未枚举到打印机')
    expect(connHint('disconnected', '')).toBe('打印客户端不可达')
    expect(connHint('disconnected', 'ECONNREFUSED')).toBe('ECONNREFUSED')
  })

  it('canStartBatch 五个条件缺一不可', () => {
    const base = { connected: true, rowCount: 10, placeholderCount: 2, hasPrinter: true, running: false }
    expect(canStartBatch(base)).toBe(true)
    expect(canStartBatch({ ...base, connected: false })).toBe(false)
    expect(canStartBatch({ ...base, rowCount: 0 })).toBe(false)
    expect(canStartBatch({ ...base, placeholderCount: 0 })).toBe(false)
    expect(canStartBatch({ ...base, hasPrinter: false })).toBe(false)
    expect(canStartBatch({ ...base, running: true })).toBe(false)
  })
})
