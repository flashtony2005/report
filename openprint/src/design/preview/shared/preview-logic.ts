/**
 * 预览/导出共享逻辑（框架无关）—— Vue PreviewPanel 与 React PreviewPanel 共用
 *
 * 只放「两端必须逐字节一致」的常量与纯函数：
 * - 告警码中文标签：预览面板告警弹层两端文案一致
 * - 缩放范围与步长：预览右下角缩放条行为一致
 */
import type { RenderWarning } from '@/core/layout-engine/types'

/** 渲染告警码 → 中文标签（未知码回退原码显示） */
export const WARNING_LABEL: Record<RenderWarning['code'], string> = {
  BINDING_MISSING: '字段缺失',
  EXPRESSION_ERROR: '表达式错误',
  DATASOURCE_NOT_ARRAY: '数据源非数组',
  DATASOURCE_EMPTY: '数据为空',
  CONTENT_OVERFLOW: '内容溢出',
  IMAGE_UNRESOLVED: '图片未解析',
  BARCODE_FAILED: '条码失败',
  CHART_FAILED: '图表失败',
  MATH_FAILED: '公式失败',
  SIGNATURE_EMPTY: '签名为空',
  PAGE_LIMIT_REACHED: '触达页数上限',
  ROW_TOO_TALL: '行高超页',
  LABEL_GRID_DATA_MISSING: '标签数据源缺失',
  LABEL_GRID_DATA_EMPTY: '标签数据为空',
}

/** 缩放范围：下限与 fitWidth 的 0.2 一致，上限 200% */
export const SCALE_MIN = 0.2
export const SCALE_MAX = 2
/** 缩放步长：预览右下角 ± 按钮与 Ctrl+滚轮共用（25%） */
export const SCALE_STEP = 0.25

/** 缩放钳制：限定在 [SCALE_MIN, SCALE_MAX]，保留两位小数 */
export function clampScale(v: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100))
}
