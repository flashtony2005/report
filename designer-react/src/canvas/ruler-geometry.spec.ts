/**
 * ruler-geometry —— 标尺几何计算（纯函数）
 *
 * 从 Vue 版 `canvas/rulers/RulerOverlay.vue` 的 computed 中抽出，
 * 理由与 P1 抽 `control-factory` 相同：**刻度换算是最容易在跨框架重写时写错、
 * 又最难靠肉眼发现的部分**（差一个 RULER_THICK 就整体偏移 20px）。
 * 抽成纯函数后可以脱离 DOM 直接断言。
 *
 * 坐标约定（《标尺与辅助系统》§4.3）：
 * - 页面左上角 = 画布坐标 (0,0)，zoom=1 时 1mm = MM_TO_PX px
 * - 画布在 stage 内向右下各偏移 RULER_THICK，故 stage 坐标 = 画布坐标 * zoom + offset + RULER_THICK
 */
import { describe, expect, it } from 'vitest'
import { MM_TO_PX, RULER_THICK } from '@/utils/constants'
import { computeBand, computeTicks, tickStep, type RulerBand } from './ruler-geometry'

describe('tickStep —— 刻度密度自适应', () => {
  it('zoom >= 2 时步长 1mm（最密）', () => {
    expect(tickStep(2)).toBe(1)
    expect(tickStep(3.5)).toBe(1)
  })

  it('zoom >= 1 且 < 2 时步长 5mm', () => {
    expect(tickStep(1)).toBe(5)
    expect(tickStep(1.99)).toBe(5)
  })

  it('zoom >= 0.5 且 < 1 时步长 10mm', () => {
    expect(tickStep(0.5)).toBe(10)
    expect(tickStep(0.99)).toBe(10)
  })

  it('zoom < 0.5 时步长 20mm（最疏）', () => {
    expect(tickStep(0.49)).toBe(20)
    expect(tickStep(0.1)).toBe(20)
  })
})

describe('computeTicks —— 刻度坐标换算', () => {
  it('zoom=1 offset=0 时，0mm 应落在 RULER_THICK 处', () => {
    const ticks = computeTicks({ zoom: 1, offset: 0, size: 1000 })
    expect(ticks[0].mm).toBe(0)
    expect(ticks[0].coord).toBeCloseTo(RULER_THICK, 6)
  })

  it('zoom=1 时刻度间距 = 5mm * MM_TO_PX', () => {
    const ticks = computeTicks({ zoom: 1, offset: 0, size: 1000 })
    expect(ticks.length).toBeGreaterThan(2)
    const gap = ticks[1].coord - ticks[0].coord
    expect(gap).toBeCloseTo(5 * MM_TO_PX, 6)
  })

  it('zoom=2 时同一 mm 的物理间距翻倍', () => {
    const a = computeTicks({ zoom: 1, offset: 0, size: 1000 })
    const b = computeTicks({ zoom: 2, offset: 0, size: 1000 })
    const gapA = a[1].coord - a[0].coord
    const gapB = b[1].coord - b[0].coord
    // zoom=2 → step=1mm，故间距应为 zoom=1(step 5mm) 的 2/5
    expect(gapB).toBeCloseTo((gapA * 2) / 5, 6)
  })

  it('平移 offset 后，同一 mm 的刻度位移相同量且间距不变', () => {
    const a = computeTicks({ zoom: 1, offset: 0, size: 1000 })
    const b = computeTicks({ zoom: 1, offset: -100, size: 1000 })
    expect(b[1].coord - b[0].coord).toBeCloseTo(a[1].coord - a[0].coord, 6)
    // 注意：不能断言 b[0].coord === a[0].coord - 100 —— 起点会对齐到 step 的整数倍，
    // 且被标尺区滤掉的刻度不同。正确命题是「同一 mm 值」的位移量。
    const shared = a.find((t) => b.some((x) => x.mm === t.mm))!
    const counterpart = b.find((x) => x.mm === shared.mm)!
    expect(counterpart.coord).toBeCloseTo(shared.coord - 100, 6)
  })

  it('过滤掉落在标尺厚度内与超出视口的刻度', () => {
    const ticks = computeTicks({ zoom: 1, offset: 0, size: 500 })
    for (const t of ticks) {
      expect(t.coord).toBeGreaterThanOrEqual(RULER_THICK)
      expect(t.coord).toBeLessThanOrEqual(500)
    }
  })

  it('视口为 0 时不产生刻度（避免死循环）', () => {
    expect(computeTicks({ zoom: 1, offset: 0, size: 0 })).toEqual([])
  })

  it('极端缩小时仍能终止且步长变为 20mm', () => {
    const ticks = computeTicks({ zoom: 0.1, offset: 0, size: 800 })
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks[1].mm - ticks[0].mm).toBe(20)
  })
})

describe('computeBand —— 选中元素高亮带', () => {
  const band: RulerBand = { left: 0, top: 0, width: MM_TO_PX * 40, height: MM_TO_PX * 20 }

  it('zoom=1 offset=0 时宽度映射正确', () => {
    const r = computeBand(band, { zoom: 1, offsetX: 0, offsetY: 0 })
    expect(r).not.toBeNull()
    // 40mm 宽，zoom=1 → 40 * MM_TO_PX px
    expect(r!.wPx).toBeCloseTo(40 * MM_TO_PX, 6)
    expect(r!.hPx).toBeCloseTo(20 * MM_TO_PX, 6)
    expect(r!.widthMm).toBeCloseTo(40, 6)
    expect(r!.heightMm).toBeCloseTo(20, 6)
  })

  it('缩放后像素尺寸随 zoom 缩放，mm 尺寸不变', () => {
    const r = computeBand(band, { zoom: 2, offsetX: 0, offsetY: 0 })
    expect(r!.wPx).toBeCloseTo(40 * MM_TO_PX * 2, 6)
    expect(r!.widthMm).toBeCloseTo(40, 6)
  })

  it('起止坐标含 RULER_THICK 偏移', () => {
    const r = computeBand(band, { zoom: 1, offsetX: 0, offsetY: 0 })
    expect(r!.x1).toBeCloseTo(RULER_THICK, 6)
    expect(r!.y1).toBeCloseTo(RULER_THICK, 6)
  })

  it('band 为 null 时返回 null', () => {
    expect(computeBand(null, { zoom: 1, offsetX: 0, offsetY: 0 })).toBeNull()
  })
})
