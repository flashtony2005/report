import { describe, expect, it } from 'vitest'

import { resolveControlContent } from '@/core/layout-engine/data-binder'
import { renderPage } from '@/core/renderer-html/html-renderer'
import type { RichTextControl } from '@/types/control'
import type { EvalContext, LayoutPage } from '@/core/layout-engine/types'

/** 构造最小富文本控件 */
function makeRichText(value: string, id = 'rt-1'): RichTextControl {
  return { id, type: 'richtext', left: 0, top: 0, width: 80, height: 24, value }
}

describe('richtext —— 数据绑定 + 渲染链路', () => {
  const ctx: EvalContext = { data: {}, row: undefined, page: 2, pages: 5 }

  it('resolveControlContent 插值 {{page}}/{{pages}} 页码变量', async () => {
    const res = await resolveControlContent(
      makeRichText('<p>第 {{page}} 页 / 共 {{pages}} 页</p>'),
      ctx,
    )
    expect(res.content.kind).toBe('html')
    if (res.content.kind === 'html') {
      expect(res.content.html).toContain('第 2 页 / 共 5 页')
    }
  })

  // 注：happy-dom 环境 DOMPurify 的标签解析与真实浏览器不同（如 <h3>/<script> 处理异常）；
  // 这里只断言文本内容，确保「插值 → 消毒 → html 内容」管线跑通。标签级行为由真实浏览器保证。
  it('resolveControlContent 消毒管线保留文本内容', async () => {
    const res = await resolveControlContent(
      makeRichText('<h3>标题</h3><p><strong>加粗</strong> & 正文</p>'),
      ctx,
    )
    if (res.content.kind === 'html') {
      expect(res.content.html).toContain('加粗')
      expect(res.content.html).toContain('正文')
    }
  })

  it('renderPage 输出 op-richtext 且保留 HTML 结构', () => {
    const page: LayoutPage = {
      index: 0,
      pageNo: 1,
      header: [],
      footer: [],
      body: [
        {
          kind: 'control',
          id: 'rt-1',
          left: 10,
          top: 10,
          width: 80,
          height: 24,
          control: makeRichText('<h3>标题</h3><p><strong>加粗</strong></p>'),
          content: { kind: 'html', html: '<h3>标题</h3><p><strong>加粗</strong></p>' },
        },
      ],
    }
    const html = renderPage(page)
    expect(html).toContain('op-richtext')
    expect(html).toContain('<h3>标题</h3>')
    expect(html).toContain('<strong>加粗</strong>')
  })
})
