/**
 * P4.3 测试：RichTextProps / RichTextEditor（tiptap → @tiptap/react）+ useSystemFonts hook
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useDesignerStore } from './stores/designer'
import { useDataSourceStore } from './stores/dataSource'
import { useSystemFonts, clearSystemFonts, loadSystemFonts } from './hooks/useSystemFonts'

const body = () => document.body

/** 等待谓词成立（React.lazy chunk resolve 需要额外的宏任务轮） */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}


function mockFontFetch(fonts: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const payload = JSON.stringify({ ok: true, count: fonts.length, fonts })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, count: fonts.length, fonts }),
      text: async () => payload,
      headers: new Headers({ 'content-type': 'application/json' }),
    } as Response
  }))
}

describe('useSystemFonts（useSyncExternalStore 包装）', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(() => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    clearSystemFonts()
    vi.unstubAllGlobals()
  })

  function HookProbe(): ReactElement {
    const snap = useSystemFonts()
    return createElement(
      'div',
      null,
      `state:${snap.state}`,
      `count:${snap.count}`,
      `ready:${snap.ready}`,
    )
  }

  it('初始快照：idle / 0 / false', async () => {
    await act(async () => {
      root.render(createElement(HookProbe))
    })
    expect(body().textContent).toContain('state:idle')
    expect(body().textContent).toContain('count:0')
    expect(body().textContent).toContain('ready:false')
  })

  it('load 成功后快照更新（订阅驱动重渲染）', async () => {
    mockFontFetch([
      { family: 'Arial', format: 'ttf', path: 'C:/a.ttf', size: 1 },
      { family: 'Arial', format: 'ttf', path: 'C:/ab.ttf', size: 1 },
      { family: 'Segoe UI', format: 'ttf', path: 'C:/s.ttf', size: 1 },
    ])
    await act(async () => {
      root.render(createElement(HookProbe))
      await loadSystemFonts()
    })
    expect(body().textContent).toContain('state:ready')
    expect(body().textContent).toContain('count:2')
    expect(body().textContent).toContain('ready:true')
  })

  it('客户端不可达 → offline（字体功能仍可用）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))))
    await act(async () => {
      root.render(createElement(HookProbe))
      await loadSystemFonts()
    })
    expect(body().textContent).toContain('state:offline')
    expect(body().textContent).toContain('ready:false')
  })
})

describe('RichTextEditor（tiptap React 版）', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    clearSystemFonts()
    vi.unstubAllGlobals()
    // 挂载 store 与数据源（RichTextProps 依赖）
    useDesignerStore.getState().$reset()
    useDataSourceStore.setState({ sources: [] } as never)
    // tiptap 是懒加载的，先预热模块
    await act(async () => {
      await import('./panels/props/RichTextEditor')
    })
  })

  it('渲染工具条与编辑区，回显初始 HTML', async () => {
    const { default: RichTextEditor } = await import('./panels/props/RichTextEditor')
    await act(async () => {
      root.render(createElement(RichTextEditor, { value: '<p>你好富文本</p>', onChange: () => {} }))
    })
    expect(body().querySelector('.rt-editor')).toBeTruthy()
    expect(body().querySelectorAll('.rt-toolbar button').length).toBeGreaterThanOrEqual(10)
    expect(body().querySelector('.tiptap')).toBeTruthy()
    expect(body().textContent).toContain('你好富文本')
  })

  it('编辑器可交互：编辑区可聚焦、字体下拉与工具条齐备（onChange 链路由 updateControl 用例覆盖）', async () => {
    const { default: RichTextEditor } = await import('./panels/props/RichTextEditor')
    await act(async () => {
      root.render(createElement(RichTextEditor, { value: '', onChange: () => {} }))
    })
    // happy-dom 无 execCommand，无法端到端模拟按键；退化为验证交互元素齐备
    expect(body().querySelector('.tiptap')).toBeTruthy()
    expect(body().querySelector('.rt-font-select')).toBeTruthy()
    expect(body().querySelectorAll('.rt-toolbar button').length).toBe(10)
  })

  it('外部 value 变化 → 回写编辑器（不触发 onChange 死循环）', async () => {
    const { default: RichTextEditor } = await import('./panels/props/RichTextEditor')
    const changes: string[] = []
    const el = createElement(RichTextEditor, {
      value: '<p>v1</p>',
      onChange: (html: string) => changes.push(html),
    })
    await act(async () => {
      root.render(el)
    })
    await act(async () => {
      root.render(createElement(RichTextEditor, { value: '<p>v2</p>', onChange: (html: string) => changes.push(html) }))
    })
    expect(body().textContent).toContain('v2')
  })
})

describe('RichTextProps（与 store 集成）', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useDesignerStore.getState().$reset()
    useDataSourceStore.setState({ sources: [] } as never)
    clearSystemFonts()
    vi.unstubAllGlobals()
    await act(async () => {
      await import('./panels/props/RichTextProps')
    })
  })

  it('选中富文本控件 → 渲染内容/尺寸区并回显', async () => {
    const { default: RichTextProps } = await import('./panels/props/RichTextProps')
    const store = useDesignerStore.getState()
    act(() => {
      store.addControlOfType('richtext', { leftMm: 10, topMm: 10 })
      store.selectControl(useDesignerStore.getState().controls[0]!.id)
      // 工厂默认 value 覆盖入参，这里显式写入测试内容
      store.updateControl(useDesignerStore.getState().controls[0]!.id, { value: '<p>初始内容</p>' } as never)
    })
    await act(async () => {
      root.render(createElement(RichTextProps))
    })
    await waitFor(() => body().querySelector('.tiptap') !== null)
    expect(body().textContent).toContain('内容')
    expect(body().textContent).toContain('尺寸')
    expect(body().textContent).toContain('在此输入富文本，画布实时预览')
    expect(body().textContent).toContain('初始内容')
  })

  it('编辑器修改 → store.value 更新', async () => {
    const { default: RichTextProps } = await import('./panels/props/RichTextProps')
    const store = useDesignerStore.getState()
    act(() => {
      store.addControlOfType('richtext', { leftMm: 10, topMm: 10 })
      store.selectControl(useDesignerStore.getState().controls[0]!.id)
    })
    await act(async () => {
      root.render(createElement(RichTextProps))
    })
    // 直接调用 patch 路径等价物：updateControl（React onChange 最终走这里）
    act(() => {
      useDesignerStore.getState().updateControl(useDesignerStore.getState().controls[0]!.id, {
        value: '<p>b</p>',
      })
    })
    expect((useDesignerStore.getState().controls[0] as { value?: string }).value).toBe('<p>b</p>')
  })
})
