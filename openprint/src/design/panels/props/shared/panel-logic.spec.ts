/**
 * panel-logic —— 属性面板共享业务逻辑（跨框架）
 *
 * 背景：Vue 版属性面板的「业务决策」全部写在 .vue 的 script 里（如 TextProps 的
 * contentMode 判别/切换、style 合并、格式补丁语义）。重写 React 面板时若逐行翻译，
 * 这些决策逻辑必然漂移。抽成纯函数后两端 import 同一份，测试只写一次。
 *
 * 契约：所有函数都是纯函数 —— 输入控件对象（或字段），输出 patch（Partial）或值，
 * **不触碰任何 store**。调用方（Vue 组件 / React 组件）负责把 patch 交给 updateControl。
 */
import { describe, expect, it } from 'vitest'
import type { TextControl } from '@/types/control'
import {
  contentModePatch,
  formatHint,
  formatKindFirstPatch,
  formatPatch,
  isPresetDatePattern,
  mergeStyle,
  resolveContentMode,
} from './panel-logic'

/** 构造最小文本控件 */
function textCtl(partial: Partial<TextControl> = {}): TextControl {
  return {
    id: 'c1',
    type: 'text',
    left: 10,
    top: 10,
    width: 50,
    height: 10,
    printable: true,
    value: '',
    style: { fontSize: 12 },
    ...partial,
  } as TextControl
}

describe('resolveContentMode —— 内容类型判别', () => {
  it('显式 contentType 优先', () => {
    expect(resolveContentMode(textCtl({ contentType: 'fixed', binding: 'a.b' }))).toBe('fixed')
    expect(resolveContentMode(textCtl({ contentType: 'variable' }))).toBe('variable')
    expect(resolveContentMode(textCtl({ contentType: 'expression' }))).toBe('expression')
  })

  it('无 contentType 时按老模板回退：expression > binding > fixed', () => {
    expect(resolveContentMode(textCtl({ expression: '{{a}}', binding: 'a.b' }))).toBe('expression')
    expect(resolveContentMode(textCtl({ binding: 'a.b' }))).toBe('variable')
    expect(resolveContentMode(textCtl())).toBe('fixed')
  })
})

describe('contentModePatch —— 模式切换写回', () => {
  it('切到 fixed：写 contentType 并清空 binding/expression', () => {
    const p = contentModePatch('fixed')
    expect(p).toEqual({ contentType: 'fixed', binding: undefined, expression: undefined })
  })

  it('切到 variable：写 contentType，仅清 expression（保留 binding 待用户选）', () => {
    expect(contentModePatch('variable')).toEqual({ contentType: 'variable', expression: undefined })
  })

  it('切到 expression：写 contentType，仅清 binding', () => {
    expect(contentModePatch('expression')).toEqual({ contentType: 'expression', binding: undefined })
  })
})

describe('mergeStyle —— 样式合并（浅合并，不改原对象）', () => {
  it('合并进已有 style 并返回新控件对象', () => {
    const c = textCtl({ style: { fontSize: 12, fill: '#000000' } })
    const merged = mergeStyle(c, { fontSize: 18 })
    expect(merged.style).toEqual({ fontSize: 18, fill: '#000000' })
    expect(c.style!.fontSize).toBe(12) // 原对象不被修改
  })

  it('无 style 的控件也能合并（初始化空 style）', () => {
    const c = { ...textCtl(), style: undefined } as unknown as TextControl
    expect(mergeStyle(c, { textAlign: 'center' }).style).toEqual({ textAlign: 'center' })
  })
})

describe('formatPatch —— 数据格式补丁语义', () => {
  it('kind=none 时输出 undefined（清除格式字段，而非留半成品对象）', () => {
    expect(formatPatch({ kind: 'none' })).toBeUndefined()
  })

  it('有格式时原样透传', () => {
    const fmt = { kind: 'date', pattern: 'YYYY-MM-DD' } as const
    expect(formatPatch(fmt)).toEqual(fmt)
  })
})

describe('formatKindFirstPatch —— 首次选择格式类型套默认值', () => {
  it('从 none 选 date → 直接给该类型默认格式（避免半成品）', () => {
    const p = formatKindFirstPatch(undefined, 'date')
    expect(p!.kind).toBe('date')
    expect(p!.pattern).toBeTruthy()
  })

  it('同类型重复选择 → 保留用户已改的格式（不重置）', () => {
    const cur = { kind: 'date' as const, pattern: '自定义' }
    expect(formatKindFirstPatch(cur, 'date')).toBe(cur)
  })

  it('换类型 → 重置为新类型默认格式', () => {
    const cur = { kind: 'date' as const, pattern: 'YYYY' }
    const p = formatKindFirstPatch(cur, 'currency')
    expect(p!.kind).toBe('currency')
    expect(p).not.toBe(cur)
  })
})

describe('isPresetDatePattern —— 预设日期模板判别', () => {
  it('预设列表中的值 → true；自定义/空 → false', () => {
    expect(isPresetDatePattern('YYYY-MM-DD')).toBe(true)
    expect(isPresetDatePattern('不是预设')).toBe(false)
    expect(isPresetDatePattern(undefined)).toBe(false)
  })
})

describe('formatHint —— 绑定字段类型建议', () => {
  it('日期/数值字段给出建议文案，其它为空', () => {
    expect(formatHint('date')).toContain('日期')
    expect(formatHint('number')).toContain('数值')
    expect(formatHint('string')).toBe('')
    expect(formatHint(undefined)).toBe('')
  })
})
