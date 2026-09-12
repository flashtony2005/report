/**
 * 单位换算 —— 三层坐标单一换算入口
 * 真理源：《OpenPrint-设计方案.md》§11.5（锁定精确常数，不要用近似值）
 *
 * 三层坐标：协议层（mm/in/pt）⇄ 画布层（CSS px @96dpi）⇄ 缩放层（px × zoom）
 * 本文件只负责前两层；zoom 由画布层处理（mmToPx(...) * zoom）。
 */

export const MM_PER_INCH = 25.4 // 精确
export const PT_PER_INCH = 72 // 精确（PostScript 标准）
export const PX_PER_INCH = 96 // CSS 标准
export const MM_PER_PT = MM_PER_INCH / PT_PER_INCH // 0.3527...
export const MM_PER_PX = MM_PER_INCH / PX_PER_INCH // 0.2645...
export const PT_PER_MM = PT_PER_INCH / MM_PER_INCH // 2.834...
export const PX_PER_MM = PX_PER_INCH / MM_PER_INCH // 3.779...

export const mmToPx = (mm: number): number => mm / MM_PER_PX
export const pxToMm = (px: number): number => px * MM_PER_PX
export const mmToPt = (mm: number): number => mm / MM_PER_PT
export const ptToMm = (pt: number): number => pt * MM_PER_PT
export const ptToPx = (pt: number): number => mmToPx(ptToMm(pt))
export const pxToPt = (px: number): number => mmToPt(pxToMm(px))

/** 打印 DPI → 栅格化倍率（页面渲染基准 96 CSS dpi）：600dpi → 6.25x */
export const dpiToScale = (dpi: number): number => dpi / PX_PER_INCH

import type { PageUnit } from '@/types/template'

/** 任意协议单位 → mm（Renderer 内部统一 mm 参与排版） */
export function toMm(value: number, unit: PageUnit): number {
  switch (unit) {
    case 'mm':
      return value
    case 'in':
      return value * MM_PER_INCH
    case 'pt':
      return ptToMm(value)
  }
}

/** mm → 任意协议单位 */
export function fromMm(mm: number, unit: PageUnit): number {
  switch (unit) {
    case 'mm':
      return mm
    case 'in':
      return mm / MM_PER_INCH
    case 'pt':
      return mmToPt(mm)
  }
}
