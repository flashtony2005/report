/**
 * P6.1 —— 主流程打磨一期：ZoomBar（画布缩放工具栏）+ StatusBar（底部状态栏）测试
 *
 * ZoomBar：档位/加减/100% 重置经 canvasHost 调内核方法（假 host 计数验证）、
 *          显示值与 store viewport 同源；下拉档位来自共享 zoom.ts。
 * StatusBar：模板名/未保存标记/选中数/页数渲染；网格与边距线开关只改视图状态不标 dirty。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { createRoot, type Root } from 'react-dom/client'
import {
  attachCanvasHost,
  detachCanvasHost,
  resetDesignerStores,
  useDesignerStore,
  type CanvasHost,
} from '../stores/designer'
import { resetPreviewDataCache } from '../stores/dataSource'
import { useUiStore } from '../stores/ui'
import ZoomBar from '../canvas/ZoomBar'
import StatusBar from './StatusBar'

function body(): HTMLElement {
  return document.body
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...body().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  )
}

/** 假画布内核：只记录缩放方法调用 */
function makeFakeHost() {
  const calls = { zoomIn: 0, zoomOut: 0, setZoom: [] as number[], fitToHost: 0 }
  const host = {
    zoomIn: () => calls.zoomIn++,
    zoomOut: () => calls.zoomOut++,
    setZoom: (z: number) => calls.setZoom.push(z),
    fitToHost: () => calls.fitToHost++,
  } as unknown as CanvasHost
  return { host, calls }
}

let host: HTMLDivElement
let root: Root

async function mount(el: () => React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(el())
    await new Promise((r) => setTimeout(r, 40))
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetDesignerStores()
  resetPreviewDataCache()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await new Promise((r) => setTimeout(r, 40))
  })
  detachCanvasHost()
  document.body.innerHTML = ''
})

/* ------------------------------ ZoomBar ------------------------------ */

describe('ZoomBar', () => {
  it('默认 100%；−/＋/100% 分别调 zoomOut/zoomIn/setZoom(1)', async () => {
    const { host: fake, calls } = makeFakeHost()
    attachCanvasHost(fake)
    await mount(() => createElement(ZoomBar))
    expect(body().querySelector('[data-testid="zoom-label"]')!.textContent).toBe('100%')
    await act(async () => {
      findButton('＋')!.click()
      findButton('−')!.click()
      // reset 按钮与 zoom-label 文本同为 100%，按 class 定位
      ;(body().querySelector('.zoom-bar-reset') as HTMLButtonElement).click()
    })
    expect(calls.zoomIn).toBe(1)
    expect(calls.zoomOut).toBe(1)
    expect(calls.setZoom).toEqual([1])
  })

  it('显示值来自 store viewport（滚轮缩放同步）；下拉含档位与「适应页面」', async () => {
    const { host: fake, calls } = makeFakeHost()
    attachCanvasHost(fake)
    await mount(() => createElement(ZoomBar))
    await act(async () => {
      useDesignerStore.setState({ viewport: { zoom: 1.5, offsetX: 0, offsetY: 0 } })
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(body().querySelector('[data-testid="zoom-label"]')!.textContent).toBe('150%')
    // 打开档位下拉（antd Dropdown click 触发）
    await act(async () => {
      ;(body().querySelector('[data-testid="zoom-label"]') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 60))
    })
    const menuText = body().querySelector('.ant-dropdown-menu')?.textContent ?? ''
    expect(menuText).toContain('25%')
    expect(menuText).toContain('400%')
    expect(menuText).toContain('适应页面')
    // 点「适应页面」→ fitToHost
    const fit = [...body().querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')].find((el) =>
      el.textContent!.includes('适应页面'),
    )!
    await act(async () => {
      fit.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(calls.fitToHost).toBe(1)
  })
})

/* ------------------------------ StatusBar ------------------------------ */

describe('StatusBar', () => {
  it('默认渲染：demo 模板名 / 无 dirty / 1 页 / 网格关 / 边距线开 / 100%', async () => {
    await mount(() => createElement(StatusBar))
    const bar = body().querySelector('[data-testid="status-bar"]')!
    // resetDesignerStores 载入 demo 模板
    expect(bar.textContent).toContain('销售出库单')
    expect(body().querySelector('[data-testid="status-dirty"]')).toBeNull()
    expect(body().querySelector('[data-testid="status-page"]')!.textContent).toContain('1 页')
    expect(body().querySelector('[data-testid="status-grid"]')!.textContent).toContain('网格关')
    expect(body().querySelector('[data-testid="status-margin"]')!.textContent).toContain('边距线开')
    expect(body().querySelector('[data-testid="status-zoom"]')!.textContent).toBe('100%')
  })

  it('模板名 / dirty / 选中数 / 页数跟随 store 渲染', async () => {
    await mount(() => createElement(StatusBar))
    await act(async () => {
      useDesignerStore.setState({
        templateName: '工资条标签',
        dirty: true,
        pageCount: 3,
        selectedIds: ['a', 'b'],
      })
      await new Promise((r) => setTimeout(r, 20))
    })
    const bar = body().querySelector('[data-testid="status-bar"]')!
    expect(bar.textContent).toContain('工资条标签')
    expect(body().querySelector('[data-testid="status-dirty"]')).toBeTruthy()
    expect(body().querySelector('[data-testid="status-selection"]')!.textContent).toContain('已选 2 项')
    expect(body().querySelector('[data-testid="status-page"]')!.textContent).toContain('3 页')
  })

  it('网格/边距线开关：翻转 store 视图状态，不标 dirty', async () => {
    await mount(() => createElement(StatusBar))
    await act(async () => {
      ;(body().querySelector('[data-testid="status-grid"]') as HTMLButtonElement).click()
      ;(body().querySelector('[data-testid="status-margin"]') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(useDesignerStore.getState().gridConfig.visible).toBe(true)
    expect(body().querySelector('[data-testid="status-grid"]')!.textContent).toContain('网格开')
    expect(useUiStore.getState().showMarginGuides).toBe(false)
    expect(body().querySelector('[data-testid="status-margin"]')!.textContent).toContain('边距线关')
    expect(useDesignerStore.getState().dirty).toBe(false)
    // setGrid 钳制非法间距
    act(() => {
      useDesignerStore.getState().setGrid({ sizeMm: -1 })
    })
    expect(useDesignerStore.getState().gridConfig.sizeMm).toBeGreaterThan(0)
  })
})
