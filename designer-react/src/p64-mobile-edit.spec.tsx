/**
 * P6.4 测试：移动端属性编辑体验 + 触屏长按菜单
 * 1) 窄屏选中控件 → 属性抽屉自动弹出；取消选中 → 自动收起
 * 2) LongPressMenu：菜单项渲染 / 复制 / 删除 / 遮罩关闭
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useDesignerStore, resetDesignerStores } from './stores/designer'
import { useUiStore } from './stores/ui'
import { stubCanvas2d } from './canvas/test-utils'
import App from './App'
import { LongPressMenu } from './canvas/LongPressMenu'

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

function stubMatchMedia(matches: boolean, coarse?: boolean): void {
  const coarseMatches = coarse ?? matches
  vi.spyOn(window, 'matchMedia').mockImplementation(((q: string) => ({
    matches: q.includes('max-width') ? matches : q.includes('pointer') ? coarseMatches : !matches,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as never)
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

describe('P6.4 移动端属性编辑 + 长按菜单', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    localStorage.clear()
    stubCanvas2d()
    resetDesignerStores()
    useUiStore.getState().$reset()
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

  it('窄屏：选中控件 → 属性抽屉自动弹出；取消选中 → 自动收起', async () => {
    stubMatchMedia(true)
    await act(async () => {
      root.render(createElement(App))
    })
    await waitFor(() => !!body().querySelector('.toolbar-root'))
    // 初始无选中：抽屉关闭
    expect(body().querySelector('.ant-drawer.app-right-drawer.ant-drawer-open')).toBeNull()
    // 选中一个控件（store 直连；控件渲染走 mock host）
    await act(async () => {
      const s = useDesignerStore.getState()
      s.addControlOfType('text', { leftMm: 20, topMm: 20 })
      const after = useDesignerStore.getState()
      after.selectControl(after.controls[0]!.id)
    })
    await waitFor(() => !!body().querySelector('.ant-drawer.app-right-drawer.ant-drawer-open'))
    // 取消选中 → 自动收起
    await act(async () => {
      useDesignerStore.getState().selectControl(null)
    })
    await waitFor(() => !body().querySelector('.ant-drawer.app-right-drawer.ant-drawer-open'))
  })

  it('桌面：选中控件不弹抽屉（面板常驻）', async () => {
    stubMatchMedia(false)
    await act(async () => {
      root.render(createElement(App))
    })
    await waitFor(() => !!body().querySelector('.app-right'))
    await act(async () => {
      const s = useDesignerStore.getState()
      s.addControlOfType('text', { leftMm: 20, topMm: 20 })
      const after = useDesignerStore.getState()
      after.selectControl(after.controls[0]!.id)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(body().querySelector('.ant-drawer.app-right-drawer')).toBeNull()
  })

  it('LongPressMenu：四项菜单 + 复制新增控件 + 删除移除 + 遮罩关闭', async () => {
    await act(async () => {
      const s = useDesignerStore.getState()
      s.addControlOfType('text', { leftMm: 10, topMm: 10 })
    })
    const id = useDesignerStore.getState().controls[0]!.id
    const onClose = vi.fn()
    await act(async () => {
      root.render(createElement(LongPressMenu, { state: { controlId: id, x: 200, y: 200 }, onClose }))
    })
    const menu = body().querySelector('[data-testid="long-press-menu"]')!
    expect(menu.textContent).toContain('复制')
    expect(menu.textContent).toContain('删除')
    expect(menu.textContent).toContain('上移一层')
    expect(menu.textContent).toContain('下移一层')
    // 复制：controls 1 → 2
    await act(async () => {
      ;([...menu.querySelectorAll('button')].find((b) => b.textContent === '复制')!).click()
    })
    expect(useDesignerStore.getState().controls.length).toBe(2)
    expect(onClose).toHaveBeenCalled()
    // 副本必须是新 id（回归：曾把整个控件当 init 传入，init.id 覆盖新 id → 两个同 id 控件）
    const afterCopy = useDesignerStore.getState()
    const cloneId = afterCopy.controls[1]!.id
    expect(cloneId).not.toBe(id)
    // 复制后选中副本
    expect(afterCopy.selectedIds).toEqual([cloneId])

    // 删除副本：controls 2 → 1（原控件仍在）
    await act(async () => {
      root.render(createElement(LongPressMenu, { state: { controlId: cloneId, x: 200, y: 200 }, onClose }))
    })
    await act(async () => {
      ;(body().querySelector('[data-testid="long-press-menu"]')!.querySelectorAll('button')[3] as HTMLButtonElement).click()
    })
    const remaining = useDesignerStore.getState().controls
    expect(remaining.length).toBe(1)
    expect(remaining[0]!.id).toBe(id)
  })

  it('LongPressMenu：点遮罩关闭', async () => {
    await act(async () => {
      const s = useDesignerStore.getState()
      s.addControlOfType('text', { leftMm: 10, topMm: 10 })
    })
    const id = useDesignerStore.getState().controls[0]!.id
    const onClose = vi.fn()
    await act(async () => {
      root.render(createElement(LongPressMenu, { state: { controlId: id, x: 100, y: 100 }, onClose }))
    })
    await act(async () => {
      body().querySelector('[data-testid="long-press-mask"]')!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      )
    })
    expect(onClose).toHaveBeenCalled()
  })
})
