/**
 * P5.3 测试：App 三栏布局壳
 * 顶栏 / 左栏（250px 三 tab）/ 中央画布 / 右栏（300px，可隐藏）装配 + 基本联动。
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

// 壳层冒烟不跑 Fabric：mock 画布内核（no-op 方法面）与内置字体加载，
// 避免 happy-dom 下 Fabric 渲染链路的未捕获异常污染整个测试进程
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

async function waitFor(pred: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

describe('AppShell（P5.3）', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    localStorage.clear()
    stubCanvas2d()
    resetDesignerStores()
    useUiStore.getState().$reset()
    // 打印探测不联网
    vi.spyOn(useDesignerStore.getState(), 'saveTemplate').mockResolvedValue({ ok: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(createElement(App))
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
  })

  it('三栏装配：顶栏 + 左栏三 tab + 中央画布 + 右栏属性面板', async () => {
    await waitFor(() => !!body().querySelector('.toolbar-root'))
    expect(body().querySelector('.app-left .left-panel')).toBeTruthy()
    expect(body().querySelector('.app-canvas')).toBeTruthy()
    expect(body().querySelector('.app-right')).toBeTruthy()
    const text = body().textContent!.replace(/\s/g, '')
    expect(text).toContain('组件')
    expect(text).toContain('数据源')
    expect(text).toContain('图层')
  })

  it('rightPanelVisible=false 时右栏隐藏', async () => {
    await waitFor(() => !!body().querySelector('.app-right'))
    await act(async () => {
      useUiStore.getState().setRightPanelVisible(false)
    })
    expect(body().querySelector('.app-right')).toBeNull()
    await act(async () => {
      useUiStore.getState().setRightPanelVisible(true)
    })
    expect(body().querySelector('.app-right')).toBeTruthy()
  })

  it('加控件并选中 → 右栏属性面板出现通用段（名称/几何）', async () => {
    await waitFor(() => !!body().querySelector('.app-right'))
    // 壳层冒烟不跑 Fabric：脱离画布内核，纯模型链路验证右栏联动
    const { detachCanvasHost } = await import('./stores/designer')
    detachCanvasHost()
    await act(async () => {
      useDesignerStore.getState().addControlOfType('text', { leftMm: 10, topMm: 10 })
      const after = useDesignerStore.getState()
      after.selectControl(after.controls[after.controls.length - 1]!.id)
    })
    await waitFor(() => body().querySelector('.app-right')!.textContent!.includes('名称'))
    const text = body().querySelector('.app-right')!.textContent!
    expect(text).toContain('X')
    expect(text).toContain('宽')
    expect(text).toContain('锁定')
  })

  it('签名弹窗可从壳层打开（拖拽签名控件的接收端）', async () => {
    await waitFor(() => !!body().querySelector('.toolbar-root'))
    await act(async () => {
      useDesignerStore.getState().openSignaturePad()
    })
    await waitFor(() => body().querySelector('.ant-modal')!.textContent!.includes('手写签名'))
    expect(body().querySelector('[data-testid="signature-canvas"]')).toBeTruthy()
    await act(async () => {
      useDesignerStore.getState().closeSignaturePad()
    })
    // antd Modal 关闭后 DOM 仍挂载（不销毁），以 store 状态为准
    expect(useDesignerStore.getState().signatureModalOpen).toBe(false)
  })
})
