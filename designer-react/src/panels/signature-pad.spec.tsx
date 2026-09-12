/**
 * P5.3 测试：SignaturePadModal 手写签名面板（React 版）
 * happy-dom 无 2D 上下文，用最小 ctx stub 驱动绘制链路。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useDesignerStore, resetDesignerStores } from '../stores/designer'

const body = () => document.body

/** happy-dom 最小 2D 上下文 stub（只实现组件用到的方法） */
function stubCanvas2d(): void {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    scale: vi.fn(),
    lineCap: '',
    lineJoin: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    drawImage: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,AAAA',
  )
}

async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

function renderIn(root: Root, el: ReactElement): void {
  act(() => {
    root.render(el)
  })
}

/** 在画板上落一笔：down (x1,y1) → move (x2,y2) → up */
async function drawStroke(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  const canvas = body().querySelector<HTMLCanvasElement>('[data-testid="signature-canvas"]')!
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 480,
    height: 220,
    right: 480,
    bottom: 220,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  await act(async () => {
    canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x1, clientY: y1 }))
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x2, clientY: y2 }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: x2, clientY: y2 }))
  })
}

/** 点击弹窗内指定文字按钮 */
async function clickModalButton(text: string): Promise<void> {
  const btn = [...body().querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
    (el) => el.textContent?.replace(/\s/g, '') === text,
  )
  expect(btn, `弹窗按钮「${text}」应存在`).toBeTruthy()
  await act(async () => {
    btn!.click()
    await new Promise((r) => setTimeout(r, 100))
  })
}

describe('SignaturePadModal（P5.3）', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    stubCanvas2d()
    resetDesignerStores()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const { default: SignaturePadModal } = await import('./SignaturePadModal')
    renderIn(root, createElement(SignaturePadModal))
  })

  it('store 打开 → 弹窗与画板出现；关闭后复位', async () => {
    await act(async () => {
      useDesignerStore.getState().openSignaturePad()
    })
    await waitFor(() => body().textContent!.includes('手写签名'))
    expect(body().querySelector('[data-testid="signature-canvas"]')).toBeTruthy()
    // 插入按钮初始禁用（无笔迹）
    const insert = [...body().querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
      (b) => b.textContent?.replace(/\s/g, '') === '插入',
    )!
    expect(insert.disabled).toBe(true)
    await act(async () => {
      useDesignerStore.getState().closeSignaturePad()
    })
    expect(useDesignerStore.getState().signatureModalOpen).toBe(false)
  })

  it('落笔累计笔画：撤销/清空启用、插入解禁；清空后回禁用', async () => {
    await act(async () => {
      useDesignerStore.getState().openSignaturePad()
    })
    await waitFor(() => !!body().querySelector('[data-testid="signature-canvas"]'))
    await drawStroke(100, 50, 200, 80)
    const btnBy = (text: string): HTMLButtonElement =>
      [...body().querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
        (b) => b.textContent?.replace(/\s/g, '') === text,
      )!
    await waitFor(() => !btnBy('插入').disabled)
    expect(btnBy('撤销').disabled).toBe(false)
    expect(btnBy('清空').disabled).toBe(false)

    await act(async () => {
      btnBy('清空').click()
    })
    expect(btnBy('插入').disabled).toBe(true)
    expect(btnBy('撤销').disabled).toBe(true)
  })

  it('插入：签名控件落画布（包围盒 mm 宽高 + PNG src），挂起落点清空、弹窗关闭', async () => {
    useDesignerStore.setState({ pendingSignatureDrop: { leftMm: 33, topMm: 44 } })
    const addSpy = vi.spyOn(useDesignerStore.getState(), 'addControlOfType')
    await act(async () => {
      useDesignerStore.getState().openSignaturePad()
    })
    await waitFor(() => !!body().querySelector('[data-testid="signature-canvas"]'))
    await drawStroke(100, 50, 200, 80)
    await clickModalButton('插入')
    expect(addSpy).toHaveBeenCalledTimes(1)
    const [type, at, init] = addSpy.mock.calls[0]!
    expect(type).toBe('signature')
    expect(at).toEqual({ leftMm: 33, topMm: 44 })
    const sig = init as { src: string; width: number; height: number }
    expect(sig.src.startsWith('data:image/png')).toBe(true)
    // 480px = 60mm → 1px = 0.125mm；包围盒约 101×31 px → 约 12.6×3.9mm，不小于下限
    expect(sig.width).toBeGreaterThanOrEqual(8)
    expect(sig.height).toBeGreaterThanOrEqual(6)
    expect(useDesignerStore.getState().pendingSignatureDrop).toBeNull()
    expect(useDesignerStore.getState().signatureModalOpen).toBe(false)
    // 画布上真的落了一个 signature 控件
    const s = useDesignerStore.getState()
    expect(s.controls.filter((c) => c.type === 'signature')).toHaveLength(1)
  })

  it('无挂起落点时回落内容区默认 (60mm, 60mm)', async () => {
    const addSpy = vi.spyOn(useDesignerStore.getState(), 'addControlOfType')
    await act(async () => {
      useDesignerStore.getState().openSignaturePad()
    })
    await waitFor(() => !!body().querySelector('[data-testid="signature-canvas"]'))
    await drawStroke(100, 50, 200, 80)
    await clickModalButton('插入')
    const [, at] = addSpy.mock.calls[0]!
    expect(at).toEqual({ leftMm: 60, topMm: 60 })
  })

  it('撤销一笔试笔画栈', async () => {
    await act(async () => {
      useDesignerStore.getState().openSignaturePad()
    })
    await waitFor(() => !!body().querySelector('[data-testid="signature-canvas"]'))
    await drawStroke(100, 50, 200, 80)
    await drawStroke(150, 100, 180, 130)
    const btnBy = (text: string): HTMLButtonElement =>
      [...body().querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
        (b) => b.textContent?.replace(/\s/g, '') === text,
      )!
    await waitFor(() => !btnBy('插入').disabled)
    await act(async () => {
      btnBy('撤销').click()
    })
    // 仍剩一笔 → 插入仍可用；再撤销一笔 → 禁用
    expect(btnBy('插入').disabled).toBe(false)
    await act(async () => {
      btnBy('撤销').click()
    })
    expect(btnBy('插入').disabled).toBe(true)
  })
})
