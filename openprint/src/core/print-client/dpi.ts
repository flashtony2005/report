/**
 * 打印 DPI 决策 —— 弹窗缺省值 / 手动覆盖 / maxDpi 钳制的唯一出口
 *
 * 背景：PDF 按打印机实际 DPI 栅格化（scale = dpi / 96），
 * 与客户端 QPrinter 的打印分辨率一致，避免客户端二次重采样导致「打不准」。
 * 客户端 /printers 现已返回每台打印机的 defaultDpi / maxDpi。
 */
import type { PrinterInfo } from './types'

/** 打印机未上报 defaultDpi 时的回退 DPI（≈旧固定 scale 3 = 288dpi 的清晰度档位） */
export const FALLBACK_PRINT_DPI = 300

/** 手动输入的分辨率下限（低于 72dpi 打印件不可用） */
export const MIN_PRINT_DPI = 72

/**
 * 把 DPI 钳制到打印机能力范围内。
 * maxDpi 缺失/非法（<=0）视为无上限，仅钳下限。
 */
export function clampDpi(dpi: number, maxDpi?: number): number {
  let v = Number.isFinite(dpi) ? Math.round(dpi) : FALLBACK_PRINT_DPI
  v = Math.max(MIN_PRINT_DPI, v)
  if (typeof maxDpi === 'number' && maxDpi > 0 && v > maxDpi) v = Math.floor(maxDpi)
  return v
}

/**
 * 解析本次打印实际使用的 DPI：
 * 1. 手动输入的合法值（>0）优先；
 * 2. 否则取打印机 defaultDpi；
 * 3. 再否则回退 FALLBACK_PRINT_DPI；
 * 最后统一钳制到 [MIN_PRINT_DPI, maxDpi]。
 */
export function resolvePrintDpi(
  manual: number | null | undefined,
  printer: Pick<PrinterInfo, 'defaultDpi' | 'maxDpi'> | null | undefined,
): number {
  const manualDpi = typeof manual === 'number' && manual > 0 ? manual : 0
  const base =
    manualDpi > 0
      ? manualDpi
      : printer && printer.defaultDpi > 0
        ? printer.defaultDpi
        : FALLBACK_PRINT_DPI
  return clampDpi(base, printer?.maxDpi)
}
