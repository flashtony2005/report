/**
 * P5.1 测试：左侧三树（ControlLibrary / DataSourceTree / LayerPanel / LeftPanel 容器）
 * + 控件拖拽落画布（useDragDrop 与 control-drag 共享逻辑）
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useDesignerStore } from './stores/designer'
import { useDataSourceStore } from './stores/dataSource'
import { useUiStore } from './stores/ui'
import { computeDropMm, startControlDrag, readControlDrag, DRAG_TYPE_KEY } from '@/design/hooks/control-drag'

const body = () => document.body

/** 用原生 setter 触发受控 input 的 input 事件（绕过 React valueTracker） */
function typeInput(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}


async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
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

describe('ControlLibrary', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useDesignerStore.getState().$reset()
    await act(async () => {
      await import('./panels/ControlLibrary')
    })
  })

  it('渲染全部分类与卡片（含置灰业务组件）', async () => {
    const { default: ControlLibrary } = await import('./panels/ControlLibrary')
    renderIn(root, createElement(ControlLibrary))
    const text = body().textContent!
    for (const name of ['常用组件', '布局组件', '高级组件', '图表组件', '业务组件']) {
      expect(text).toContain(name)
    }
    expect(text).toContain('文本')
    expect(text).toContain('标签网格')
    expect(body().querySelectorAll('.control-card.is-disabled').length).toBe(3)
  })

  it('搜索过滤：输入「圆」只剩圆形卡片', async () => {
    const { default: ControlLibrary } = await import('./panels/ControlLibrary')
    renderIn(root, createElement(ControlLibrary))
    const input = body().querySelector<HTMLInputElement>('input')!
    await act(async () => {
      typeInput(input, '圆')
    })
    const text = body().textContent!
    expect(text).toContain('圆形')
    expect(text).not.toContain('矩形')
    expect(text).not.toContain('文本')
  })

  it('点击文本卡片不落控件（对齐 Vue：text/image 等仅支持拖拽，点击插入只限页眉页脚/圆形/页码等）', async () => {
    const { default: ControlLibrary } = await import('./panels/ControlLibrary')
    renderIn(root, createElement(ControlLibrary))
    const card = [...body().querySelectorAll<HTMLElement>('.control-card')].find(
      (c) => c.querySelector('.control-card-label')?.textContent === '文本',
    )!
    await act(async () => {
      card.click()
    })
    expect(useDesignerStore.getState().controls).toHaveLength(0)
  })

  it('点击圆形 → rect + shape=circle；点击页码 → text + {{page}}', async () => {
    const { default: ControlLibrary } = await import('./panels/ControlLibrary')
    renderIn(root, createElement(ControlLibrary))
    const circle = [...body().querySelectorAll<HTMLElement>('.control-card')].find(
      (c) => c.querySelector('.control-card-label')?.textContent === '圆形',
    )!
    const pageno = [...body().querySelectorAll<HTMLElement>('.control-card')].find(
      (c) => c.querySelector('.control-card-label')?.textContent === '页码',
    )!
    await act(async () => {
      circle.click()
      pageno.click()
    })
    const controls = useDesignerStore.getState().controls
    expect(controls).toHaveLength(2)
    expect(controls[0]!.type).toBe('rect')
    expect((controls[0] as { shape?: string }).shape).toBe('circle')
    expect(controls[1]!.type).toBe('text')
    expect((controls[1] as { value?: string }).value).toBe('{{page}}')
  })

  it('点击签名 → 打开手写画板（signatureModalOpen）', async () => {
    const { default: ControlLibrary } = await import('./panels/ControlLibrary')
    renderIn(root, createElement(ControlLibrary))
    const sig = [...body().querySelectorAll<HTMLElement>('.control-card')].find(
      (c) => c.querySelector('.control-card-label')?.textContent === '签名',
    )!
    await act(async () => {
      sig.click()
    })
    expect(useDesignerStore.getState().signatureModalOpen).toBe(true)
  })

  it('startControlDrag / readControlDrag 往返（stub dataTransfer，happy-dom DragEvent 不持久）', () => {
    const store: Record<string, string> = {}
    const dt = {
      setData: (k: string, v: string) => {
        store[k] = v
      },
      getData: (k: string) => store[k] ?? '',
      types: [DRAG_TYPE_KEY],
      effectAllowed: '',
    }
    const evt = { dataTransfer: dt } as unknown as DragEvent
    startControlDrag(evt, 'text', { value: 'X' })
    expect(dt.getData(DRAG_TYPE_KEY)).toBe('text')
    const { type, init } = readControlDrag(evt)
    expect(type).toBe('text')
    expect(init).toEqual({ value: 'X' })
  })
})

describe('DataSourceTree', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useDataSourceStore.getState().$reset()
    await act(async () => {
      await useDataSourceStore.getState().init()
      await import('./panels/DataSourceTree')
    })
  })

  it('渲染三选一 + 数据源选择 + 字段树（含明细表 [] 标记）', async () => {
    const { default: DataSourceTree } = await import('./panels/DataSourceTree')
    renderIn(root, createElement(DataSourceTree))
    const text = body().textContent!
    expect(text).toContain('数据源类型')
    expect(text).toContain('示例数据')
    expect(text).toContain('ERP')
    expect(text).toContain('数据库')
    expect(text).toContain('数据源')
    // mock 数据源字段（order / items 等）
    expect(body().querySelectorAll('.field-item').length).toBeGreaterThan(3)
  })

  it('搜索字段过滤', async () => {
    const { default: DataSourceTree } = await import('./panels/DataSourceTree')
    renderIn(root, createElement(DataSourceTree))
    const before = body().querySelectorAll('.field-item').length
    const input = body().querySelector<HTMLInputElement>('input[placeholder="搜索字段"]')!
    expect(input, '搜索输入框存在').toBeTruthy()
    await act(async () => {
      typeInput(input, '不存在的字段xyz')
    })
    expect(body().querySelectorAll('.field-item').length).toBe(0)
    // 搜索无结果说「没有匹配的字段」，而不是笼统的「暂无字段」（后者留给真的没字段时）
    expect(body().textContent).toContain('没有匹配的字段')
    expect(before).toBeGreaterThan(0)
  })

  it('切换到数据库 → 接入探索器（未连接客户端时提示 + 开关禁用）', async () => {
    const { default: DataSourceTree } = await import('./panels/DataSourceTree')
    renderIn(root, createElement(DataSourceTree))
    const dbRadio = [...body().querySelectorAll<HTMLInputElement>('input[type=radio]')].find(
      (r) => (r.closest('label') ?? r.parentElement)?.textContent === '数据库',
    )
    expect(dbRadio).toBeTruthy()
    await act(async () => {
      dbRadio!.click()
    })
    // P5.1b：占位已换成真实探索器（开关行始终显示）
    await waitFor(() => body().textContent!.includes('启用数据库数据源'))
    expect(body().textContent).toContain('未连接本地打印客户端')
    const sw = body().querySelector<HTMLButtonElement>('.db-explorer-switch .ant-switch')
    expect(sw, '开关存在').toBeTruthy()
    expect(sw!.disabled, '未连接客户端时开关禁用').toBe(true)
  })
})

describe('LayerPanel', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const store = useDesignerStore.getState()
    store.$reset()
    // 造 3 个正文控件
    store.addControlOfType('text', { leftMm: 1, topMm: 1 })
    store.addControlOfType('rect', { leftMm: 2, topMm: 2 })
    store.addControlOfType('image', { leftMm: 3, topMm: 3 })
    await act(async () => {
      await import('./panels/LayerPanel')
    })
  })

  it('渲染图层列表（倒序：最上层在前）', async () => {
    const { default: LayerPanel } = await import('./panels/LayerPanel')
    renderIn(root, createElement(LayerPanel))
    expect(body().textContent).toContain('图层（3 项）')
    const names = [...body().querySelectorAll('.layer-item .layer-name')].map((n) => n.textContent)
    // 最上层（最后加入的 image）在前
    expect(names[0]).toContain('图片')
    expect(names[2]).toContain('文本')
  })

  it('点击图层 → 选中；上移 → 顺序交换', async () => {
    const { default: LayerPanel } = await import('./panels/LayerPanel')
    renderIn(root, createElement(LayerPanel))
    // 最上层是 image（模型下标 2），上移按钮应禁用；点 image 选中
    const imageItem = [...body().querySelectorAll<HTMLElement>('.layer-item')][0]!
    await act(async () => {
      imageItem.click()
    })
    expect(useDesignerStore.getState().selectedIds).toContain(
      useDesignerStore.getState().controls[2]!.id,
    )
    // 点最底层（文本，模型下标 0）的上移按钮 → 应禁用；点中间层（rect，下标 1）上移
    const items = [...body().querySelectorAll<HTMLElement>('.layer-item')]
    const rectItem = items[1]!
    const upBtn = rectItem.querySelector<HTMLButtonElement>('.layer-actions button')!
    expect(upBtn.disabled).toBe(false)
    await act(async () => {
      upBtn.click()
    })
    const types = useDesignerStore.getState().controls.map((c) => c.type)
    // rect 从下标 1 上移到 2（顶层）
    expect(types).toEqual(['text', 'image', 'rect'])
  })

  it('删除图层 → 控件移除', async () => {
    const { default: LayerPanel } = await import('./panels/LayerPanel')
    renderIn(root, createElement(LayerPanel))
    const delBtns = [...body().querySelectorAll<HTMLElement>('.layer-item .layer-actions button')]
    // 每行最后一个按钮是删除
    const del = delBtns[2]!
    await act(async () => {
      del.click()
    })
    expect(useDesignerStore.getState().controls).toHaveLength(2)
  })
})

describe('LeftPanel 容器（三 tab 切换）', () => {
  it('切换 tab → ui store leftTab 更新', async () => {
    document.body.innerHTML = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    useUiStore.setState({ leftTab: 'components' })
    const { default: LeftPanel } = await import('./panels/LeftPanel')
    renderIn(root, createElement(LeftPanel))
    const tabs = [...body().querySelectorAll<HTMLElement>('.ant-tabs-tab')]
    expect(tabs.length).toBe(3)
    await act(async () => {
      tabs[2]!.click()
    })
    expect(useUiStore.getState().leftTab).toBe('layers')
    root.unmount()
  })
})

describe('computeDropMm（与 Vue 版共享的坐标换算）', () => {
  it('client px → 页面 mm / 内容区 mm', () => {
    // zoom=1, offset=0，MM_TO_PX 由 constants 提供；内容原点 = 页边距 + 页眉高
    const g = computeDropMm(
      { rect: { left: 0, top: 0 }, vp: { zoom: 1, offsetX: 0, offsetY: 0 }, canvasX: 100, canvasY: 200 },
      { x: 0, y: 0 },
    )
    // pageMm = px / MM_TO_PX，drop = page - origin(0)
    expect(g.pageMmX).toBeCloseTo(100 / 3.7795275591, 5)
    expect(g.dropLeft).toBeCloseTo(g.pageMmX, 8)
    // 有偏移时 drop 原点平移
    const g2 = computeDropMm(
      { rect: { left: 0, top: 0 }, vp: { zoom: 1, offsetX: 0, offsetY: 0 }, canvasX: 100, canvasY: 200 },
      { x: 37.795275591, y: 75.590551182 },
    )
    expect(g2.dropLeft).toBeCloseTo(g.pageMmX - 10, 5)
  })
})
