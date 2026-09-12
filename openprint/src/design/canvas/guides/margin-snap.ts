/**
 * 页边距吸附线位置（纯函数，独立于 Fabric）
 *
 * 修复前的 bug：`SmartGuides.collectCandidates` 把右/下边距内边界写成
 * `(210 - margin.right)` / `(297 - margin.bottom)` —— 硬编码 A4。
 * 非 A4 页面（如 100×150mm 标签、241×140mm 快递单）右/下吸附线会跑到页外，
 * 拖拽控件时吸附到错误位置。
 *
 * 抽成纯函数后：① 页面尺寸从参数取，不可能再写死；② 可单测（此前 0 覆盖）。
 * 与 `page-gap.ts` / `ruler-geometry.ts` / `touch-gesture.ts` 同源的抽离惯例。
 */
import { MM_TO_PX } from '@/utils/constants'

export interface MarginMm {
  top: number
  right: number
  bottom: number
  left: number
}

export interface MarginSnapLines {
  /** 左边距内边界（px） */
  left: number
  /** 右边距内边界（px）：页面宽 - 右边距 */
  right: number
  /** 上边距内边界（px） */
  top: number
  /** 下边距内边界（px）：页面高 - 下边距 */
  bottom: number
}

/** 计算四条页边距内边界的吸附线（入参：页面宽高 px + 边距 mm） */
export function computeMarginSnapLines(
  pageWidthPx: number,
  pageHeightPx: number,
  margin: MarginMm,
): MarginSnapLines {
  return {
    left: margin.left * MM_TO_PX,
    right: pageWidthPx - margin.right * MM_TO_PX,
    top: margin.top * MM_TO_PX,
    bottom: pageHeightPx - margin.bottom * MM_TO_PX,
  }
}

/** 边距区中心吸附线：左右/上下边距内边界的中点 */
export function computeMarginCenters(lines: MarginSnapLines): { v: number; h: number } {
  return {
    v: lines.left + (lines.right - lines.left) / 2,
    h: lines.top + (lines.bottom - lines.top) / 2,
  }
}
