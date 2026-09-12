import { describe, it, expect } from 'vitest'
import { computePhysicalPageCount } from './page-geometry'

describe('computePhysicalPageCount', () => {
  const A4 = 297

  it('无内容时至少 1 页', () => {
    expect(computePhysicalPageCount(0, A4)).toBe(1)
    expect(computePhysicalPageCount(-50, A4)).toBe(1)
  })

  it('内容落在第 1 页内 → 1 页', () => {
    expect(computePhysicalPageCount(100, A4)).toBe(1)
    expect(computePhysicalPageCount(296, A4)).toBe(1)
  })

  it('内容越过第 1 页底部 → 第 2 页', () => {
    expect(computePhysicalPageCount(298, A4)).toBe(2)
    expect(computePhysicalPageCount(400, A4)).toBe(2)
  })

  it('内容延伸到第 3 页', () => {
    expect(computePhysicalPageCount(594, A4)).toBe(3)
    expect(computePhysicalPageCount(800, A4)).toBe(3)
  })

  it('页高为 0 时安全返回 1', () => {
    expect(computePhysicalPageCount(500, 0)).toBe(1)
  })
})
