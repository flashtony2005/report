/**
 * P5.1c —— 字段树拖拽落画布（useDragDrop 字段分支集成测试）
 *
 * jsdom/happy-dom 不实现 DataTransfer，这里合成 dragover/drop 事件并注入伪造的
 * dataTransfer，走真实链路：useDragDrop → hitFieldDropTarget → store.bindField。
 * 同时保留一条「控件库拖拽」回归用例，确认两条链路互不干扰。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useRef, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AnyControl, TableControl, TextControl } from '@/types/control'
import { MM_TO_PX } from '@/utils/constants'
import { DRAG_TYPE_KEY } from '@/design/hooks/control-drag'
import { FIELD_DRAG_KEY } from '@/design/hooks/field-drag'
import { useDragDrop } from './canvas/useDragDrop'
import {
  attachCanvasHost,
  detachCanvasHost,
  resetDesignerStores,
  useDesignerStore,
  type CanvasHost,
} from './stores/designer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 最小可用画布内核：只要 contentOriginPx / getZones，其余方法一律 no-op */
function makeHost(): CanvasHost {
  const base: Record<string, unknown> = {
    contentOriginPx: { x: 0, y: 0 },
    getZones: () => [],
  }
  return new Proxy(base, {
    get: (t, prop) => (prop in t ? t[prop as string] : () => {}),
  }) as unknown as CanvasHost
}

function Harness(): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  useDragDrop(ref)
  return createElement('div', { ref, className: 'stage' })
}

/** 伪造 dataTransfer（happy-dom 不实现） */
function fakeDT(types: string[], data: Record<string, string>): Record<string, unknown> {
  return {
    types,
    getData: (k: string) => data[k] ?? '',
    setData: () => {},
    dropEffect: '',
    effectAllowed: '',
  }
}

function fireDrag(el: Element, type: 'dragover' | 'drop', dt: unknown, clientX: number, clientY: number): void {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY })
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  el.dispatchEvent(ev)
}

const controls = (): AnyControl[] => useDesignerStore.getState().controls
const last = <T,>(arr: T[]): T => arr[arr.length - 1]!

describe('P5.1c · 字段拖拽落绑定（画布 drop 链路）', () => {
  let host: HTMLElement
  let root: Root
  let stage: HTMLElement

  beforeEach(() => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    resetDesignerStores()
    attachCanvasHost(makeHost())
    act(() => root.render(createElement(Harness)))
    stage = host.querySelector('.stage') as HTMLElement
    expect(stage).toBeTruthy()
  })

  afterEach(() => {
    detachCanvasHost()
  })

  it('拖到单值控件上 → 写 binding 并改写为 items[0].（取首条记录）', () => {
    useDesignerStore.setState({
      controls: [{ id: 't1', type: 'text', left: 10, top: 0, width: 40, height: 8 } as AnyControl],
    })
    const dt = fakeDT([FIELD_DRAG_KEY], { [FIELD_DRAG_KEY]: 'items[].phone' })
    act(() => {
      fireDrag(stage, 'dragover', dt, 0, 0)
      // 落点 (20, 4) mm —— 在 t1 的包围盒内
      fireDrag(stage, 'drop', dt, 20 * MM_TO_PX, 4 * MM_TO_PX)
    })
    const c = controls().find((x) => x.id === 't1') as TextControl
    expect(c.contentType).toBe('variable')
    expect(c.binding).toBe('items[0].phone')
  })

  it('拖到表格列上 → 只改该列 field，保持 items[]. 明细前缀', () => {
    useDesignerStore.setState({
      controls: [
        {
          id: 'tb',
          type: 'table',
          left: 10,
          top: 0,
          width: 100,
          height: 30,
          columns: [
            { title: '甲', field: 'items[].a', width: 30 },
            { title: '乙', field: 'items[].b', width: 30 },
            { title: '丙', field: 'items[].c', width: 40 },
          ],
        } as TableControl,
      ],
    })
    const dt = fakeDT([FIELD_DRAG_KEY], { [FIELD_DRAG_KEY]: 'items[].phone' })
    act(() => {
      // 落点 (50, 5) mm → 第 1 列（40~70）
      fireDrag(stage, 'drop', dt, 50 * MM_TO_PX, 5 * MM_TO_PX)
    })
    const t = controls().find((x) => x.id === 'tb') as TableControl
    expect(t.columns[1]!.field).toBe('items[].phone')
    expect(t.columns[0]!.field).toBe('items[].a')
    expect(t.columns[2]!.field).toBe('items[].c')
  })

  it('落到空白处 → 新建一个绑定该字段的文本控件', () => {
    const before = controls().length
    const dt = fakeDT([FIELD_DRAG_KEY], { [FIELD_DRAG_KEY]: 'items[].phone' })
    act(() => {
      fireDrag(stage, 'drop', dt, 60 * MM_TO_PX, 80 * MM_TO_PX)
    })
    expect(controls().length).toBe(before + 1)
    const c = last(controls()) as TextControl
    expect(c.type).toBe('text')
    expect(c.binding).toBe('items[0].phone')
    expect(c.left).toBeCloseTo(60, 1)
  })

  it('回归：控件库拖拽不受影响（仍能落控件）', () => {
    const before = controls().length
    const dt = fakeDT([DRAG_TYPE_KEY], { [DRAG_TYPE_KEY]: 'text' })
    act(() => {
      fireDrag(stage, 'dragover', dt, 0, 0)
      fireDrag(stage, 'drop', dt, 40 * MM_TO_PX, 40 * MM_TO_PX)
    })
    expect(controls().length).toBe(before + 1)
  })
})
