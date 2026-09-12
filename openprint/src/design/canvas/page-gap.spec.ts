import { describe, it, expect } from 'vitest'
import { pageGapPx, modelTopToCanvasY, canvasYToModelTop } from './page-gap'
import { MM_TO_PX } from '@/utils/constants'

const GAP = 24
// Word 式 A4 配置：12 上边距 + 10 下边距 → 内容区高 275mm；
// 分页步长 = 页高 - 上边距 = 285mm（下边距区也允许落控件，边距只作辅助）
const PAGE_H_MM = 297
const PAGE_H_PX = PAGE_H_MM * MM_TO_PX
const STEP_MM = 285
const MARGIN_TOP_PX = 12 * MM_TO_PX

describe('pageGapPx —— 页索引(按步长) → 累计间距', () => {
  it('首页/负值/零步长 → 0', () => {
    expect(pageGapPx(0, STEP_MM, GAP)).toBe(0)
    expect(pageGapPx(100, STEP_MM, GAP)).toBe(0)
    expect(pageGapPx(284.9, STEP_MM, GAP)).toBe(0)
    expect(pageGapPx(-10, STEP_MM, GAP)).toBe(0)
    expect(pageGapPx(500, 0, GAP)).toBe(0)
  })

  it('越过步长(285mm)即跨页，每页累加一个间距', () => {
    expect(pageGapPx(285, STEP_MM, GAP)).toBe(GAP)
    expect(pageGapPx(570, STEP_MM, GAP)).toBe(GAP * 2)
    expect(pageGapPx(855, STEP_MM, GAP)).toBe(GAP * 3)
  })
})

describe('modelTopToCanvasY / canvasYToModelTop —— 与渲染端 .op-content 同口径', () => {
  it('正文起点 = 上边距（页眉/页脚在边距内，不再叠加页眉高）', () => {
    // top=0 → 内容区起点：12mm
    expect(modelTopToCanvasY(0, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBeCloseTo(MARGIN_TOP_PX, 6)
    // 示例出库单明细表 top=23 → 12+23 = 35mm（渲染端 .op-body 在内容区内）
    expect(modelTopToCanvasY(23, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBeCloseTo(
      (12 + 23) * MM_TO_PX,
      6,
    )
  })

  it('第 1 页控件往返不漂移（含下边距区）', () => {
    for (const topMm of [0, 5, 100, 274.9, 280, 284.9]) {
      const y = modelTopToCanvasY(topMm, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)
      expect(canvasYToModelTop(y, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBeCloseTo(topMm, 6)
    }
  })

  it('第 2 页控件 = 页序堆叠(页高+间距) + 内容区起点 + 页内偏移', () => {
    const topMm = 286 // 页 2 内偏移 1mm（286 - 285）
    const y = modelTopToCanvasY(topMm, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)
    expect(y).toBeCloseTo((PAGE_H_PX + GAP) + MARGIN_TOP_PX + 1 * MM_TO_PX, 6)
    expect(canvasYToModelTop(y, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBeCloseTo(topMm, 6)
  })

  it('跨页边界往返不漂移', () => {
    for (const topMm of [284.9, 285, 285.1, 569.9, 570, 854.5]) {
      const y = modelTopToCanvasY(topMm, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)
      expect(canvasYToModelTop(y, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBeCloseTo(topMm, 6)
    }
  })

  it('落在上边距/页眉 → 吸附本页内容区起点', () => {
    // 页 1 页眉带内（12mm 上方）→ top=0
    const y = 4 * MM_TO_PX
    expect(canvasYToModelTop(y, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBe(0)
  })

  it('落在下边距区 → 精确反解，不再吸附到下一页', () => {
    // 页 1 内容区底(12+275=287mm)之下、页底(297mm)之内的下边距区 → 保留本页精确 top
    const y = MARGIN_TOP_PX + 280 * MM_TO_PX
    expect(canvasYToModelTop(y, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBeCloseTo(280, 6)
  })

  it('越过页底(页间距/下一页页眉) → 归入下一页内容区起点', () => {
    // 页 1 步长底 12+285=297mm 之下 → 下一页 top=285
    const y = MARGIN_TOP_PX + STEP_MM * MM_TO_PX + 3 * MM_TO_PX
    expect(canvasYToModelTop(y, MARGIN_TOP_PX, STEP_MM, PAGE_H_PX, GAP)).toBe(STEP_MM)
  })
})
