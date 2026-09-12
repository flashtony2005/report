/**
 * ShapeProps 共享逻辑（P4.2）—— Vue / React 两端同源。
 *
 * 从 ShapeProps.vue 抽出的 patch 生成器（纯函数，不触碰 store）：
 * 虚线开关、统一/四角圆角、矩形⇄圆形切换、正圆还原。
 */
import type { LineControl, RectControl } from '@/types/control'

/** 虚线开关当前状态（strokeDashArray 有值即虚线） */
export function isDashed(c: LineControl | RectControl | null | undefined): boolean {
  return !!c?.strokeDashArray?.length
}

/** 虚线开关 patch：开 = [6,4]，关 = 清除 */
export function dashedPatch(on: boolean): Record<string, unknown> {
  return { strokeDashArray: on ? [6, 4] : undefined }
}

/** 统一圆角：设定后清空四角独立覆盖，使其回落到统一值 */
export function unifiedRadiusPatch(v: number | null): Record<string, unknown> {
  return {
    cornerRadius: v ?? 0,
    cornerRadiusTL: undefined,
    cornerRadiusTR: undefined,
    cornerRadiusBR: undefined,
    cornerRadiusBL: undefined,
  }
}

/** 四角独立圆角 patch */
export function cornerRadiusPatch(side: 'TL' | 'TR' | 'BR' | 'BL', v: number | null): Record<string, unknown> {
  return { [`cornerRadius${side}`]: v ?? 0 }
}

/** 某角有效圆角：独立覆盖优先，回落统一值 */
export function radiusOf(c: RectControl | null | undefined, side: 'TL' | 'TR' | 'BR' | 'BL'): number {
  return c?.[`cornerRadius${side}`] ?? c?.cornerRadius ?? 0
}

/** 矩形⇄圆形切换：切到圆形时强制正方形（正圆）并清圆角；切回矩形保留尺寸 */
export function shapeChangePatch(c: RectControl, v: 'rect' | 'circle'): Record<string, unknown> {
  if (v === 'circle') {
    const size = Math.max(c.width ?? 0, c.height ?? 0)
    return { shape: 'circle', cornerRadius: 0, width: size, height: size }
  }
  return { shape: 'rect', cornerRadius: c.cornerRadius ?? 0 }
}

/** 圆形一键还原为正圆（取当前长边为直径） */
export function perfectCirclePatch(c: RectControl): Record<string, unknown> {
  const size = Math.max(c.width ?? 0, c.height ?? 0)
  return { width: size, height: size }
}
