import { describe, it, expect } from 'vitest'
import { QUALITY_DPI, qualityToScale, resolveQualityDpi, type PrintQuality } from './quality'

describe('quality 清晰度预设', () => {
  it('三档映射到目标 DPI', () => {
    expect(QUALITY_DPI.low).toBe(96)
    expect(QUALITY_DPI.medium).toBe(192)
    expect(QUALITY_DPI.high).toBe(288)
  })

  it('quality → scale（dpi / 96）与历史 scale 档位一致', () => {
    expect(qualityToScale('low')).toBe(1)
    expect(qualityToScale('medium')).toBe(2)
    expect(qualityToScale('high')).toBe(3)
    expect(qualityToScale(undefined)).toBeUndefined()
  })

  it('resolveQualityDpi：manual > quality > fallback', () => {
    expect(resolveQualityDpi(600, 'high', 300)).toBe(600)
    expect(resolveQualityDpi(undefined, 'medium', 300)).toBe(192)
    expect(resolveQualityDpi(undefined, undefined, 300)).toBe(300)
    expect(resolveQualityDpi(0, undefined, 300)).toBe(300)
  })

  it('所有档位都是合法 PrintQuality', () => {
    const all: PrintQuality[] = ['low', 'medium', 'high']
    all.forEach((q) => expect(QUALITY_DPI[q]).toBeGreaterThan(0))
  })
})
