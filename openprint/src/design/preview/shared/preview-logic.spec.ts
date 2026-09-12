import { describe, expect, it } from 'vitest'
import {
  WARNING_LABEL,
  SCALE_MIN,
  SCALE_MAX,
  SCALE_STEP,
  clampScale,
} from './preview-logic'

describe('preview-logic（预览/导出共享逻辑）', () => {
  it('WARNING_LABEL 覆盖全部渲染告警码', () => {
    const codes = Object.keys(WARNING_LABEL)
    expect(codes.length).toBeGreaterThanOrEqual(14)
    expect(WARNING_LABEL.BINDING_MISSING).toBe('字段缺失')
    expect(WARNING_LABEL.DATASOURCE_EMPTY).toBe('数据为空')
    expect(WARNING_LABEL.CONTENT_OVERFLOW).toBe('内容溢出')
    expect(WARNING_LABEL.PAGE_LIMIT_REACHED).toBe('触达页数上限')
  })

  it('缩放常量：范围 0.2–2、步长 25%', () => {
    expect(SCALE_MIN).toBe(0.2)
    expect(SCALE_MAX).toBe(2)
    expect(SCALE_STEP).toBe(0.25)
  })

  it('clampScale 钳制到 [0.2, 2] 并保留两位小数', () => {
    expect(clampScale(0.1)).toBe(0.2)
    expect(clampScale(5)).toBe(2)
    expect(clampScale(1.234)).toBe(1.23)
    expect(clampScale(0.75)).toBe(0.75)
  })
})
