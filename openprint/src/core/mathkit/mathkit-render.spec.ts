import { describe, expect, it } from 'vitest'
import { render } from '@/core/sdk'
import { generateCss } from '@/core/renderer-html'
import { createCjkMeasurer } from '@/core/__tests__/cjk-measurer'
import type { TemplateData } from '@/types/template'
import type { AnyControl, MathControl } from '@/types/control'

function makeMathControl(): MathControl {
  return {
    id: 'm-math-1',
    type: 'math',
    left: 10,
    top: 10,
    width: 80,
    height: 25,
    latex: 'c = \\pm\\sqrt{a^2 + b^2}',
    displayMode: true,
    fontSize: 16,
    color: '#000000',
  }
}

function makeTemplate(control: MathControl): TemplateData<AnyControl> {
  return {
    version: '1.0',
    name: '公式渲染测试',
    document: {
      page: { width: 210, height: 297, orientation: 'portrait', margin: { top: 15, bottom: 15, left: 15, right: 15 }, unit: 'mm' },
      sections: [
        { type: 'body', components: [control] },
      ],
    },
  } as unknown as TemplateData<AnyControl>
}

describe('render(公式) —— HTML 链路 + CSS 注入（Task #232 验收）', () => {
  const measurer = createCjkMeasurer()

  it('预览 HTML 含 KaTeX 产物且 CSS 注入 KaTeX 字体', async () => {
    const res = await render({
      template: makeTemplate(makeMathControl()),
      data: {},
      output: { screen: true, title: '测试' },
      layout: { measurer },
    })
    // 1) HTML 含公式渲染结果（katex 类）
    expect(res.html).toContain('katex')
    // 2) 完整文档含 <style>（generateCss 产物）
    expect(res.html).toContain('<style>')
    // 3) KaTeX 字体 @font-face 在预览 CSS 中（同源 /fonts/katex/）
    expect(res.html).toContain('KaTeX_Main')
    expect(res.html).toContain('/fonts/katex/KaTeX_Main-Regular.woff2')
    // 4) KaTeX 样式规则（不含 font-face 的那份）也已注入
    expect(res.html).toContain('.katex')
  })

  it('导出模式（screen:false）公式 HTML 已渲染，且 generateCss 含 KaTeX 样式规则但不含同源 @font-face', async () => {
    const res = await render({
      template: makeTemplate(makeMathControl()),
      data: {},
      output: { screen: false },
      layout: { measurer },
    })
    // 1) 公式 HTML 已渲染（katex 类）
    expect(res.html).toContain('katex')
    // 2) 栅格化用 CSS（generateCss,screen:false）注入 KaTeX 样式规则
    const css = generateCss(res.result.metrics, { screen: false })
    expect(css).toContain('.katex')
    // 3) 导出模式 CSS 不含同源 @font-face（字体改由 embedFontsInSvg 以 data-URI 注入）
    expect(css).not.toContain('/fonts/katex/KaTeX_Main-Regular.woff2')
  })
})
