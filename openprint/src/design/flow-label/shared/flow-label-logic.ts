/**
 * flow-label-logic —— 流水标签批量打印的纯逻辑（框架无关）
 *
 * 从 Vue 版 `design/modals/FlowLabelModal.vue` 的 computed / 纯函数里 1:1 抽出，
 * 供 Vue 端与 React 端共用，避免重写时行为漂移（映射合并、进度统计、间隔判定
 * 这类"差一点但看不出来"的逻辑最容易写歪）。
 *
 * 本模块不依赖 DOM、不依赖 Vue/React，只吃纯数据。
 */
import { autoMapFields } from '@/core/layout-engine/placeholder-scan'
import type { ImportColumn } from '@/types/data-import'

/** 数据预览最多渲染的行数（其余行照样参与打印，只是不铺到 DOM） */
export const FLOW_PREVIEW_ROWS = 50

export interface FlowRowResult {
  /** 行下标（相对有效行数组） */
  index: number
  success: boolean
  error?: string
  durationMs: number
}

/* ------------------------------ 数据行 ------------------------------ */

/** 有效行：剔除已删行（deleted 存原始下标） */
export function filterRows<T>(rows: T[], deleted: Set<number>): T[] {
  if (deleted.size === 0) return rows
  return rows.filter((_, i) => !deleted.has(i))
}

/**
 * 字段映射 → 单行数据：把映射列的值拍平到顶层字段（{{no}} → data.no）。
 * 未映射的占位符不出现在数据里；列值缺失给空串。
 */
export function buildMappedRowData(
  mapping: Record<string, string | null>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const [ph, colKey] of Object.entries(mapping)) {
    if (colKey) data[ph] = row[colKey] ?? ''
  }
  return data
}

/** 行简要数据（失败列表展示用）：`ph=value / ph=value` */
export function rowSummary(
  mapping: Record<string, string | null>,
  row: Record<string, unknown> | undefined,
): string {
  if (!row) return ''
  return Object.entries(mapping)
    .filter(([, colKey]) => colKey)
    .map(([ph, colKey]) => `${ph}=${row[colKey as string] ?? ''}`)
    .join(' / ')
}

/* ------------------------------ 映射 ------------------------------ */

/**
 * 重新计算映射：先自动映射，再保留"列仍存在"的手动映射。
 * 数据文件换了一批列时，残留的旧映射会被自动映射覆盖掉。
 */
export function mergeMapping(
  placeholders: string[],
  columns: ImportColumn[],
  prev: Record<string, string | null> = {},
): Record<string, string | null> {
  const next = autoMapFields(placeholders, columns)
  const keys = new Set(columns.map((c) => c.key))
  for (const ph of placeholders) {
    const keep = prev[ph]
    if (keep && keys.has(keep)) next[ph] = keep
  }
  return next
}

/** 列下拉选项：首项为「— 不映射 —」（空串代表不映射） */
export function columnOptions(columns: ImportColumn[]): Array<{ label: string; value: string }> {
  return [
    { label: '— 不映射 —', value: '' },
    ...columns.map((c) => ({ label: c.title || c.key, value: c.key })),
  ]
}

/* ------------------------------ 批量统计 ------------------------------ */

/** 本次实际打印行数：限制 >0 取 min，否则全部 */
export function computePrintTotal(total: number, limitRows: number): number {
  return limitRows > 0 ? Math.min(limitRows, total) : total
}

export interface FlowStats {
  done: number
  successCount: number
  failCount: number
  /** 0–100 整数 */
  progressPct: number
  /** 平均每张耗时 ms */
  avgMs: number
  /** 预计剩余 ms */
  etaMs: number
}

export function computeFlowStats(opts: {
  results: FlowRowResult[]
  printTotal: number
  elapsedMs: number
}): FlowStats {
  const { results, printTotal, elapsedMs } = opts
  const done = results.length
  const successCount = results.filter((r) => r.success).length
  const failCount = done - successCount
  const avgMs = done > 0 ? elapsedMs / done : 0
  return {
    done,
    successCount,
    failCount,
    progressPct: printTotal > 0 ? Math.round((done / printTotal) * 100) : 0,
    avgMs,
    etaMs: done > 0 ? avgMs * (printTotal - done) : 0,
  }
}

/** 时长格式化：<60s 显示 `x.xs`，否则 `Nm Xs` */
export function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${(s % 60).toFixed(0)}s`
}

/** 最后一行之后不再等待间隔 */
export function shouldWaitInterval(
  i: number,
  totalRows: number,
  interval: number,
  stopped: boolean,
): boolean {
  return i < totalRows - 1 && interval > 0 && !stopped
}

/** 预览行下标钳制（数据变少时不要越界） */
export function clampPreviewIndex(idx: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max(0, idx), total - 1)
}

/* ------------------------------ 打印机 ------------------------------ */

export interface FlowPrinterLike {
  name: string
  isDefault?: boolean
  isOnline?: boolean
  supportsColor?: boolean
}

export function printerOptionLabel(p: FlowPrinterLike): string {
  return `${p.name}${p.isDefault ? ' · 默认' : ''}${p.isOnline ? '' : '（离线）'}`
}

export function buildPrinterOptions(
  printers: FlowPrinterLike[],
): Array<{ label: string; value: string; disabled: boolean }> {
  return printers.map((p) => ({
    label: printerOptionLabel(p),
    value: p.name,
    disabled: !p.isOnline,
  }))
}

/** 打印机列表就绪时自动选中默认机；已选中的仍在列表里就不动 */
export function pickDefaultPrinter(
  selected: string,
  printers: FlowPrinterLike[],
  def: FlowPrinterLike | null,
): string {
  if (selected && printers.some((p) => p.name === selected)) return selected
  return def?.name ?? ''
}

/** 未连接时的一句话提示 */
export function connHint(probeState: string, probeError: string): string {
  return probeState === 'connected'
    ? '已连上客户端但未枚举到打印机'
    : probeError || '打印客户端不可达'
}

/* ------------------------------ 启动条件 ------------------------------ */

export function canStartBatch(opts: {
  connected: boolean
  rowCount: number
  placeholderCount: number
  hasPrinter: boolean
  running: boolean
}): boolean {
  return (
    opts.connected &&
    opts.rowCount > 0 &&
    opts.placeholderCount > 0 &&
    opts.hasPrinter &&
    !opts.running
  )
}
