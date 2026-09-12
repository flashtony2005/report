/**
 * 触控手势数学测试（P6.3 移动端二期）
 */
import { describe, expect, it } from 'vitest'
import { parsePinch, pinchTransform, pointerClientXY } from './touch-gesture'
import type { TouchListLike } from './touch-gesture-types'

const touchList = (pts: Array<{ x: number; y: number }>): TouchListLike =>
  pts.map((p) => ({ clientX: p.x, clientY: p.y })) as unknown as TouchListLike

describe('parsePinch', () => {
  it('不足两指返回 null', () => {
    expect(parsePinch(touchList([]))).toBeNull()
    expect(parsePinch(touchList([{ x: 10, y: 10 }]))).toBeNull()
  })

  it('提取两指间距与中点', () => {
    const s = parsePinch(touchList([{ x: 100, y: 100 }, { x: 200, y: 200 }]))!
    expect(s.dist).toBeCloseTo(Math.hypot(100, 100))
    expect(s.midX).toBe(150)
    expect(s.midY).toBe(150)
  })
})

describe('pinchTransform', () => {
  it('间距放大 2 倍 → zoom 翻倍', () => {
    const prev = parsePinch(touchList([{ x: 0, y: 0 }, { x: 100, y: 0 }]))!
    const next = parsePinch(touchList([{ x: 0, y: 0 }, { x: 200, y: 0 }]))!
    const t = pinchTransform(prev, next, 1)
    expect(t.zoom).toBeCloseTo(2)
  })

  it('间距缩小一半 → zoom 减半', () => {
    const prev = parsePinch(touchList([{ x: 0, y: 0 }, { x: 200, y: 0 }]))!
    const next = parsePinch(touchList([{ x: 0, y: 0 }, { x: 100, y: 0 }]))!
    expect(pinchTransform(prev, next, 0.8).zoom).toBeCloseTo(0.4)
  })

  it('中点位移 → 平移增量', () => {
    const prev = parsePinch(touchList([{ x: 0, y: 0 }, { x: 100, y: 0 }]))!
    const next = parsePinch(touchList([{ x: 30, y: -20 }, { x: 130, y: -20 }]))!
    const t = pinchTransform(prev, next, 1)
    expect(t.zoom).toBeCloseTo(1)
    expect(t.dx).toBe(30)
    expect(t.dy).toBe(-20)
  })

  it('prev.dist 为 0 时 ratio 兜底 1（不除零）', () => {
    const prev: { dist: number; midX: number; midY: number } = { dist: 0, midX: 0, midY: 0 }
    const next: { dist: number; midX: number; midY: number } = { dist: 50, midX: 10, midY: 10 }
    const t = pinchTransform(prev, next, 1.5)
    expect(t.zoom).toBeCloseTo(1.5)
  })
})

describe('pointerClientXY', () => {
  it('TouchEvent 取 touches[0]', () => {
    const e = { touches: touchList([{ x: 7, y: 8 }]) }
    expect(pointerClientXY(e)).toEqual({ x: 7, y: 8 })
  })

  it('Touchend 取 changedTouches[0]', () => {
    const e = { changedTouches: touchList([{ x: 3, y: 4 }]) }
    expect(pointerClientXY(e)).toEqual({ x: 3, y: 4 })
  })

  it('MouseEvent 直接取 clientX/Y', () => {
    expect(pointerClientXY({ clientX: 1, clientY: 2 })).toEqual({ x: 1, y: 2 })
  })
})
