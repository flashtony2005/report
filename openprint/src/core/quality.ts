/**
 * 打印清晰度预设 —— 统一的「低 / 中 / 高」三档，映射到目标 DPI。
 *
 * 历史：早期用裸 scale（1/2/3），含义不直观；现收敛为语义化预设，
 * 内部仍换算成 scale = dpi / 96（与 PDF/DPI 感知栅格化一致）。
 * - low   = 96dpi  （scale 1，体积最小，适合草稿/内部流转）
 * - medium = 192dpi（scale 2，均衡）
 * - high  = 288dpi（scale 3，无损 PNG 底图，打印推荐，默认档）
 */
export type PrintQuality = 'low' | 'medium' | 'high'

/** 清晰度预设 → 目标 DPI（客户端据此设置打印分辨率，避免二次重采样打不准） */
export const QUALITY_DPI: Record<PrintQuality, number> = {
  low: 96,
  medium: 192,
  high: 288,
}

/** 清晰度预设 → 栅格倍率 scale（dpi / 96） */
export function qualityToScale(q?: PrintQuality): number | undefined {
  return q ? QUALITY_DPI[q] / 96 : undefined
}

/** 把清晰度预设解析为「最终 DPI」：manual > quality > fallback（fallback 通常取打印机 defaultDpi） */
export function resolveQualityDpi(
  manual?: number,
  quality?: PrintQuality,
  fallback?: number,
): number {
  if (typeof manual === 'number' && manual > 0) return manual
  if (quality) return QUALITY_DPI[quality]
  return fallback ?? 288
}
