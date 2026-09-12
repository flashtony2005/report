import { describe, expect, it } from 'vitest'
import { resolvePrintOrientation } from './orientation'

describe('resolvePrintOrientation —— 打印方向偏好解析', () => {
  it('auto + 模板横向 → landscape', () => {
    expect(resolvePrintOrientation('auto', 'landscape')).toBe('landscape')
  })

  it('auto + 模板纵向 / 未设置 → portrait', () => {
    expect(resolvePrintOrientation('auto', 'portrait')).toBe('portrait')
    expect(resolvePrintOrientation('auto', undefined)).toBe('portrait')
  })

  it('手动覆盖优先于模板（部分打印机反直觉时的兜底）', () => {
    expect(resolvePrintOrientation('portrait', 'landscape')).toBe('portrait')
    expect(resolvePrintOrientation('landscape', 'portrait')).toBe('landscape')
    expect(resolvePrintOrientation('portrait', undefined)).toBe('portrait')
  })
})
