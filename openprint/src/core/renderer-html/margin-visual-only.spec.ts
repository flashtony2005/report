import { describe, expect, it } from 'vitest'

import { layout } from '@/core/layout-engine/pagination-engine'
import { renderHtml } from '@/core/renderer-html'
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'

/**
 * 回归：边距仅作可视化参考线，不参与渲染/导出偏移。
 * 正文控件在模型里的 top:0 / left:0 必须渲染到物理页 (0,0)，
 * 不能被 margin.top / margin.left 再叠加一次偏移（否则顶部/左侧出现空白）。
 */
function visualMarginTemplate(): TemplateData<AnyControl> {
  const ctrl: AnyControl = {
    id: 'bd',
    type: 'text',
    left: 0,
    top: 0,
    width: 50,
    height: 10,
    value: 'X',
  } as AnyControl
  return {
    version: '1',
    document: {
      type: 'report',
      page: {
        width: 210,
        height: 297,
        unit: 'mm',
        orientation: 'portrait',
        // 非对称边距：若被错误叠加，顶部/左侧会出现 10/15mm 空白
        margin: { top: 10, right: 10, bottom: 10, left: 15 },
      },
      sections: [{ type: 'body', components: [ctrl] }],
    },
  }
}

describe('边距仅可视化，不参与渲染偏移（#277/#278）', () => {
  it('正文 top:0 渲染到物理页顶 top:0mm（无 margin.top 偏移）', async () => {
    const result = await layout(visualMarginTemplate(), {})
    const html = renderHtml(result, { screen: false })
    const style = html.replace(/<style[\s\S]*?<\/style>/g, '')

    // .op-content 必须贴在物理页 (0,0)，而非 margin 偏移
    expect(style).toContain('class="op-content"')
    const node = style.match(/op-node op-text"[^>]*style="([^"]*)"/)
    expect(node, '应渲染出正文文本节点').toBeTruthy()
    expect(node![1]).toContain('top:0mm')
    expect(node![1]).toContain('left:0mm')
    // 关键：绝不能出现「被 margin 叠加」后的 10mm/15mm 偏移
    expect(node![1]).not.toContain('top:10mm')
    expect(node![1]).not.toContain('left:15mm')
  })

  it('生成的 .op-content 样式 left/top 均为 0mm', async () => {
    const result = await layout(visualMarginTemplate(), {})
    const html = renderHtml(result, { screen: false })
    const css = (html.match(/<style[\s\S]*?<\/style>/g) ?? []).join('')
    const contentBlock = css.match(/\.op-content\s*\{([^}]*)\}/)
    expect(contentBlock, '应生成 .op-content 样式块').toBeTruthy()
    expect(contentBlock![1]).toContain('left: 0mm')
    expect(contentBlock![1]).toContain('top: 0mm')
    // 宽度应为整页宽（210mm），而非 pageWidth - margins
    expect(contentBlock![1]).toContain('width: 210mm')
    expect(contentBlock![1]).toContain('height: 297mm')
  })
})
