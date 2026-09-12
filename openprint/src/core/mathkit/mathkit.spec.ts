import { describe, expect, it } from 'vitest'
import { renderMathControl, renderMathHtml } from './index'
import type { MathControl } from '@/types/control'

function math(partial: Partial<MathControl>): MathControl {
  return {
    id: 'm1',
    type: 'math',
    left: 0,
    top: 0,
    width: 80,
    height: 25,
    latex: 'c = \\sqrt{a^2 + b^2}',
    displayMode: true,
    fontSize: 16,
    color: '#000000',
    ...partial,
  }
}

describe('mathkit —— KaTeX 渲染', () => {
  it('renderMathHtml 输出 KaTeX HTML 结构', () => {
    const html = renderMathHtml('a^2 + b^2', true, 16, '#000000')
    expect(html).toContain('katex')
    // 字号 / 颜色以内联样式下发
    expect(html).toContain('font-size:16pt')
    expect(html).toContain('color:#000000')
  })

  it('行内模式 text-align 为 left', () => {
    const html = renderMathHtml('a^2', false, 12, '#ff0000')
    expect(html).toContain('text-align:left')
    expect(html).toContain('font-size:12pt')
    expect(html).toContain('color:#ff0000')
  })

  it('空公式给出占位提示而非崩溃', () => {
    const html = renderMathHtml('', true, 16, '#000000')
    expect(html).toContain('公式预览')
  })

  it('语法错误时不抛异常（throwOnError:false）', () => {
    const html = renderMathHtml('\\frac{1}{', true, 16, '#000000')
    expect(html).toContain('katex')
  })

  it('renderMathControl 从 MathControl 协议出 HTML', () => {
    const html = renderMathControl(math({ latex: 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}' }))
    expect(html).toContain('katex')
    expect(html).toContain('font-size:16pt')
  })

  it('renderMathControl 行内模式字号/颜色', () => {
    const html = renderMathControl(math({ displayMode: false, fontSize: 14, color: '#3366ff' }))
    expect(html).toContain('text-align:left')
    expect(html).toContain('font-size:14pt')
    expect(html).toContain('color:#3366ff')
  })
})
