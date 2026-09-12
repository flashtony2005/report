/**
 * overlay-layers —— React 端画布覆盖层（图表 / 公式）的渲染契约
 *
 * 几何与内容选择规则已由共享 `overlay-logic.spec.ts` 覆盖（纯函数层）。
 * 本测试只钉住 React 组件这一层：
 * 1. 能否从 Fabric 画布对象收集 → 渲染出带正确定位的覆盖元素
 * 2. 「非目标类型 / 不可见对象」的过滤是否真的生效（跨类型串扰是 overlay 的典型 bug）
 * 3. 未挂载画布时不崩、渲染空层
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { createRoot, type Root } from 'react-dom/client'
import ChartViewLayer from './ChartViewLayer'
import MathViewLayer from './MathViewLayer'
import { PrintChart } from '@/design/canvas/controls/PrintChart'
import { PrintMath } from '@/design/canvas/controls/PrintMath'
import {
  attachCanvasHost,
  detachCanvasHost,
  resetDesignerStores,
  useDesignerStore,
  type CanvasHost,
} from '../stores/designer'
import { stubCanvas2d } from './test-utils'
import type { ChartControl, MathControl } from '@/types/control'

/* ------------------------------ 桩 ------------------------------ */

/** 假画布宿主：只实现 overlay 真正需要的 canvas 投影 */
function fakeHost(objects: unknown[]): CanvasHost {
  return {
    canvas: { viewportTransform: [2, 0, 0, 2, 10, 20], getObjects: () => objects },
  } as unknown as CanvasHost
}

function chartControl(id: string, over: Partial<ChartControl> = {}): ChartControl {
  return {
    id,
    type: 'chart',
    left: 10,
    top: 20,
    width: 60,
    height: 40,
    kind: 'bar',
    categories: ['A', 'B'],
    series: [{ name: 's1', data: [1, 2] }],
    ...over,
  } as unknown as ChartControl
}

function mathControl(id: string): MathControl {
  return {
    id,
    type: 'math',
    left: 5,
    top: 6,
    width: 30,
    height: 10,
    latex: 'a^2+b^2',
    displayMode: true,
    fontSize: 16,
    color: '#000000',
  } as unknown as MathControl
}

/** 挂载组件、渲染一帧、返回容器 */
async function mount(el: ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(el)
  })
  return { host, root }
}

async function unmount(root: Root, host: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount()
  })
  host.remove()
}

/* ------------------------------ 测试 ------------------------------ */

describe('ChartViewLayer', () => {
  let roots: Array<[Root, HTMLElement]> = []

  beforeEach(() => {
    stubCanvas2d()
    resetDesignerStores()
    roots = []
  })

  afterEach(async () => {
    for (const [root, host] of roots) await unmount(root, host)
    detachCanvasHost()
    resetDesignerStores()
  })

  it('未挂载画布（无 host）→ 渲染空层，不抛错', async () => {
    const m = await mount(createElement(ChartViewLayer))
    roots.push([m.root, m.host])
    expect(m.host.querySelector('[data-testid="chart-overlay"]')).toBeTruthy()
    expect(m.host.querySelectorAll('[data-chart-id]').length).toBe(0)
  })

  it('收集 PrintChart 对象 → 渲染出带定位的 SVG 覆盖项', async () => {
    const obj = new PrintChart(chartControl('c1'))
    attachCanvasHost(fakeHost([obj]))

    const m = await mount(createElement(ChartViewLayer))
    roots.push([m.root, m.host])

    const item = m.host.querySelector<HTMLElement>('[data-chart-id="c1"]')
    expect(item).toBeTruthy()
    // 视口 zoom=2 → transform 里应有 scale(2)；SVG 由 chartkit 生成
    expect(item!.style.transform).toContain('scale(2)')
    expect(item!.innerHTML).toContain('<svg')
  })

  it('公式对象不会串到图表层（跨类型过滤）', async () => {
    const chart = new PrintChart(chartControl('c1'))
    const math = new PrintMath(mathControl('m1'))
    attachCanvasHost(fakeHost([chart, math]))

    const m = await mount(createElement(ChartViewLayer))
    roots.push([m.root, m.host])

    expect(m.host.querySelector('[data-chart-id="c1"]')).toBeTruthy()
    expect(m.host.querySelector('[data-math-id="m1"]')).toBeFalsy()
  })

  it('visible=false 的图表不渲染（隐藏层不应留残影）', async () => {
    const shown = new PrintChart(chartControl('c1'))
    const hidden = new PrintChart(chartControl('c2'))
    hidden.set('visible', false)
    attachCanvasHost(fakeHost([shown, hidden]))

    const m = await mount(createElement(ChartViewLayer))
    roots.push([m.root, m.host])

    expect(m.host.querySelector('[data-chart-id="c1"]')).toBeTruthy()
    expect(m.host.querySelector('[data-chart-id="c2"]')).toBeFalsy()
  })

  it('canvasTick 自增触发重算（Fabric 非响应式的补偿机制）', async () => {
    const obj = new PrintChart(chartControl('c1'))
    attachCanvasHost(fakeHost([obj]))

    const m = await mount(createElement(ChartViewLayer))
    roots.push([m.root, m.host])
    expect(m.host.querySelectorAll('[data-chart-id]').length).toBe(1)

    // 模拟画布上新增一个图表（Fabric 侧直接加对象，再打 tick）
    const obj2 = new PrintChart(chartControl('c2'))
    attachCanvasHost(fakeHost([obj, obj2]))
    await act(async () => {
      useDesignerStore.getState().bumpCanvasTick()
    })

    expect(m.host.querySelectorAll('[data-chart-id]').length).toBe(2)
  })
})

describe('MathViewLayer', () => {
  let roots: Array<[Root, HTMLElement]> = []

  beforeEach(() => {
    stubCanvas2d()
    resetDesignerStores()
    roots = []
  })

  afterEach(async () => {
    for (const [root, host] of roots) await unmount(root, host)
    detachCanvasHost()
    resetDesignerStores()
  })

  it('收集 PrintMath 对象 → 渲染出 KaTeX HTML 覆盖项', async () => {
    const obj = new PrintMath(mathControl('m1'))
    attachCanvasHost(fakeHost([obj]))

    const m = await mount(createElement(MathViewLayer))
    roots.push([m.root, m.host])

    const item = m.host.querySelector<HTMLElement>('[data-math-id="m1"]')
    expect(item).toBeTruthy()
    expect(item!.style.transform).toContain('scale(2)')
    expect(item!.innerHTML.length).toBeGreaterThan(0)
  })

  it('图表对象不会串到公式层（跨类型过滤）', async () => {
    const chart = new PrintChart(chartControl('c1'))
    const math = new PrintMath(mathControl('m1'))
    attachCanvasHost(fakeHost([chart, math]))

    const m = await mount(createElement(MathViewLayer))
    roots.push([m.root, m.host])

    expect(m.host.querySelector('[data-math-id="m1"]')).toBeTruthy()
    expect(m.host.querySelector('[data-chart-id="c1"]')).toBeFalsy()
  })
})
