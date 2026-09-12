/**
 * P6.2 测试：移动端适配
 * ≤900px：左右面板抽屉化 + 画布浮动唤起按钮；桌面布局不受影响。
 * matchMedia 由 window 桩控制（hook 只在挂载时读一次初始值）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { resetDesignerStores } from './stores/designer'
import { useUiStore } from './stores/ui'
import { stubCanvas2d } from './canvas/test-utils'
import App from './App'

vi.mock('@/design/canvas/CanvasDesigner', () => {
  class CanvasDesignerStub {
    canvas = { requestRenderAll: () => {} }
    constructor() {
      return new Proxy(this, {
        get(t, prop) {
          if (prop in t) return Reflect.get(t, prop)
          return () => {}
        },
      })
    }
    dispose(): void {}
  }
  return { CanvasDesigner: CanvasDesignerStub }
})
vi.mock('@/core/fonts/loader', () => ({
  loadBuiltinFonts: () => Promise.resolve(),
}))

const body = () => document.body

/** 桩掉 window.matchMedia：narrow 控制宽度断点；coarse 控制主输入指针（默认跟随 narrow） */
let narrowMatches = false
let coarseMatches = false
let changeListeners: Array<(e: { matches: boolean }) => void> = []
function stubMatchMedia(matches: boolean, coarse?: boolean): void {
  narrowMatches = matches
  coarseMatches = coarse ?? matches
  changeListeners = []
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('max-width') ? narrowMatches : query.includes('pointer') ? coarseMatches : !matches,
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          changeListeners.push(cb)
        },
        removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
          changeListeners = changeListeners.filter((f) => f !== cb)
        },
        addListener: (cb: (e: { matches: boolean }) => void) => {
          changeListeners.push(cb)
        },
        removeListener: (cb: (e: { matches: boolean }) => void) => {
          changeListeners = changeListeners.filter((f) => f !== cb)
        },
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

async function waitFor(pred: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

describe('P6.2 移动端适配', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    localStorage.clear()
    stubCanvas2d()
    resetDesignerStores()
    useUiStore.getState().$reset()
    vi.spyOn(window, 'matchMedia').mockRestore?.()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
      await new Promise((r) => setTimeout(r, 60))
    })
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(createElement(App))
    })
    await waitFor(() => !!body().querySelector('.toolbar-root'))
  }

  it('桌面（默认）：左右面板常驻，无浮动唤起按钮', async () => {
    await mount()
    expect(body().querySelector('.app-left .left-panel')).toBeTruthy()
    expect(body().querySelector('.app-right')).toBeTruthy()
    expect(body().querySelector('[data-testid="fab-left"]')).toBeNull()
    expect(body().querySelector('[data-testid="fab-right"]')).toBeNull()
    expect(body().querySelector('.app-shell')!.className).not.toContain('is-narrow')
  })

  it('窄屏：面板收进抽屉，画布两侧出现唤起按钮，壳挂 is-narrow', async () => {
    stubMatchMedia(true)
    await mount()
    expect(body().querySelector('.app-left')).toBeNull()
    expect(body().querySelector('.app-right')).toBeNull()
    expect(body().querySelector('[data-testid="fab-left"]')).toBeTruthy()
    expect(body().querySelector('[data-testid="fab-right"]')).toBeTruthy()
    expect(body().querySelector('.app-shell')!.className).toContain('is-narrow')
  })

  it('回归修复：窄屏但主输入为鼠标（pointer:coarse=false）→ 保持桌面布局可编辑', async () => {
    // 用户报障场景：小窗口/内嵌预览 + 鼠标 —— 不得进入移动端模式，
    // 否则点控件就弹属性抽屉 + 遮罩盖住画布（「不能操作」）
    stubMatchMedia(true, false)
    await mount()
    expect(body().querySelector('.app-left .left-panel')).toBeTruthy()
    expect(body().querySelector('.app-right')).toBeTruthy()
    expect(body().querySelector('[data-testid="fab-left"]')).toBeNull()
    expect(body().querySelector('[data-testid="fab-right"]')).toBeNull()
    expect(body().querySelector('.app-shell')!.className).not.toContain('is-narrow')
  })

  it('窄屏点唤起按钮 → 对应抽屉打开并渲染面板内容', async () => {
    stubMatchMedia(true)
    await mount()
    // 左抽屉：组件面板
    await act(async () => {
      body().querySelector('[data-testid="fab-left"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => !!body().querySelector('.ant-drawer.app-left-drawer.ant-drawer-open'))
    expect(body().querySelector('.app-left-drawer .left-panel')).toBeTruthy()
    // 右抽屉：属性面板
    await act(async () => {
      body().querySelector('[data-testid="fab-right"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => !!body().querySelector('.ant-drawer.app-right-drawer.ant-drawer-open'))
    // 无选中控件时属性面板为空态占位；有内容即算渲染成功
    await waitFor(() => (body().querySelector('.app-right-drawer .ant-drawer-body')?.textContent ?? '').includes('选中画布中的控件'))
  })

  it('窄屏下顶栏次要按钮带 data-narrow-hide 标记（CSS 层负责隐藏）', async () => {
    stubMatchMedia(true)
    await mount()
    const marked = body().querySelectorAll('[data-narrow-hide]')
    expect(marked.length).toBeGreaterThanOrEqual(3)
    // 关键操作按钮必须保留（无标记、带 aria-label 的）：打印/AI/设置
    const kept = ['打印', 'AI 设计助手', '设置']
    for (const label of kept) {
      expect(body().querySelector(`[aria-label="${label}"]`)).toBeTruthy()
    }
  })
})
