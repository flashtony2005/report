/**
 * margin-snap 单测：非 A4 页面的边距吸附线位置
 * 回归修复：旧实现把右下边距写成 (210 - margin.right) / (297 - margin.bottom)，
 * 硬编码 A4 → 非 A4 页面（标签/快递单）吸附线错位到页外。
 */
import { describe, expect, it } from 'vitest'
import { computeMarginCenters, computeMarginSnapLines } from './margin-snap'
import { MM_TO_PX } from '@/utils/constants'

describe('computeMarginSnapLines', () => {
  it('A4（210×297）：右边距线 = 210 - right，下边距线 = 297 - bottom', () => {
    const w = 210 * MM_TO_PX
    const h = 297 * MM_TO_PX
    const r = computeMarginSnapLines(w, h, { top: 10, right: 10, bottom: 10, left: 10 })
    expect(r.left).toBeCloseTo(10 * MM_TO_PX, 6)
    expect(r.top).toBeCloseTo(10 * MM_TO_PX, 6)
    expect(r.right).toBeCloseTo(200 * MM_TO_PX, 6)
    expect(r.bottom).toBeCloseTo(287 * MM_TO_PX, 6)
  })

  it('回归：非 A4 页面（100×150mm 标签）右边距线不越界、不按 A4 计算', () => {
    const w = 100 * MM_TO_PX
    const h = 150 * MM_TO_PX
    const r = computeMarginSnapLines(w, h, { top: 5, right: 8, bottom: 5, left: 6 })
    // 旧实现会给出 210-8=202mm（远在 100mm 页面之外）
    expect(r.right).toBeCloseTo(92 * MM_TO_PX, 6)
    expect(r.bottom).toBeCloseTo(145 * MM_TO_PX, 6)
    expect(r.right).toBeLessThanOrEqual(w)
    expect(r.bottom).toBeLessThanOrEqual(h)
  })

  it('零边距：吸附线贴齐页面边缘', () => {
    const w = 80 * MM_TO_PX
    const h = 60 * MM_TO_PX
    const r = computeMarginSnapLines(w, h, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(r.left).toBeCloseTo(0, 6)
    expect(r.top).toBeCloseTo(0, 6)
    expect(r.right).toBeCloseTo(w, 6)
    expect(r.bottom).toBeCloseTo(h, 6)
  })
})

describe('computeMarginCenters', () => {
  it('边距区中心 = 左右/上下内边界中点', () => {
    const lines = computeMarginSnapLines(100 * MM_TO_PX, 150 * MM_TO_PX, {
      top: 10,
      right: 10,
      bottom: 20,
      left: 20,
    })
    const c = computeMarginCenters(lines)
    expect(c.v).toBeCloseTo((lines.left + lines.right) / 2, 6)
    expect(c.h).toBeCloseTo((lines.top + lines.bottom) / 2, 6)
  })
})
