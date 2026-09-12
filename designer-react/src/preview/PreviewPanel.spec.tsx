/**
 * PreviewPanel（P5.4）—— 打印预览弹窗测试
 *
 * 覆盖：打开即渲染 / 页码指示 / 告警弹层文案 / 缩放条（± 步长 25%）/ 关闭
 * 渲染引擎 '@/core/sdk' 与字体 loader 打桩（真实渲染链路由 Vue 端 sdk.spec 覆盖）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PreviewPanel } from './PreviewPanel'
import { useUiStore } from '../stores/ui'
import { resetDesignerStores } from '../stores/designer'
import { resetPreviewDataCache } from '../stores/dataSource'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderMock = vi.fn()
vi.mock('@/core/sdk', () => ({
  render: (...args: unknown[]) => renderMock(...args),
}))
vi.mock('@/core/fonts/loader', () => ({
  builtinFontFaceCss: () => '',
}))

const body = () => document.body

async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

let root: Root
let host: HTMLElement

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(PreviewPanel as unknown as () => ReactElement))
  })
}

describe('PreviewPanel（打印预览）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    resetDesignerStores()
    resetPreviewDataCache()
    useUiStore.setState({ previewOpen: false })
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      html: '<div class="op-page-wrap">p1</div><div class="op-page-wrap">p2</div>',
      warnings: [{ code: 'BINDING_MISSING', message: '字段 x 未绑定' }],
      pages: 2,
      result: { metrics: { pageWidth: 210 } },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    return async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('打开即渲染：请求带模板与页面装饰，页码指示与告警文案正确', async () => {
    useUiStore.setState({ previewOpen: true })
    await mount()
    await waitFor(() => renderMock.mock.calls.length > 0)
    const req = renderMock.mock.calls[0]![0] as {
      output: { title: string; pageDecoration: { backgroundColor: string } }
    }
    expect(req.output.title).toBe('销售出库单模板')
    expect(req.output.pageDecoration.backgroundColor).toBe('#ffffff')
    await waitFor(() => body().textContent!.includes('第 1 / 2 页'))
    expect(body().querySelector('[data-testid="preview-warnings"]')!.textContent).toContain(
      '1 条告警',
    )
  })

  it('关闭：store previewOpen 归 false', async () => {
    useUiStore.setState({ previewOpen: true })
    await mount()
    await waitFor(() => body().textContent!.includes('打印预览'))
    const closeBtn = body().querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!
    await act(async () => {
      closeBtn.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(useUiStore.getState().previewOpen).toBe(false)
  })

  it('缩放条：+ / − 步长 25%，百分比显示联动', async () => {
    useUiStore.setState({ previewOpen: true })
    await mount()
    await waitFor(() => body().textContent!.includes('打印预览'))
    const zoomValue = () =>
      body().querySelector('[data-testid="preview-zoom-value"]')!.textContent!
    expect(zoomValue()).toBe('50%')
    const zoomBtns = () => [...body().querySelectorAll<HTMLButtonElement>('.zoom-btn')]
    await act(async () => {
      zoomBtns().find((b) => b.title === '放大 25%')!.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(zoomValue()).toBe('75%')
    await act(async () => {
      zoomBtns().find((b) => b.title === '缩小 25%')!.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(zoomValue()).toBe('50%')
  })

  it('渲染失败：展示错误信息，页码回落 1 / 1', async () => {
    renderMock.mockRejectedValue(new Error('layout exploded'))
    useUiStore.setState({ previewOpen: true })
    await mount()
    await waitFor(() => body().textContent!.includes('渲染失败'))
    expect(body().textContent).toContain('layout exploded')
    expect(body().textContent).toContain('第 1 / 1 页')
  })
})
