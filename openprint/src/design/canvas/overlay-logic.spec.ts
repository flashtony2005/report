/**
 * overlay-logic 单测 —— 画布覆盖层（方案 A）的框架无关几何/内容组装
 *
 * 纯函数、不依赖 DOM / fabric：用结构化桩对象造「画布 + Fabric 对象」，
 * 验证 Vue 与 React 两端共用的定位与内容选择规则。
 */
import { describe, expect, it } from 'vitest'
import {
  collectOverlayItems,
  overlayItemStyle,
  type CollectOverlayOptions,
  type FabricOverlayObject,
  type OverlayCanvas,
  type OverlayStoreLike,
} from './overlay-logic'
import { MM_TO_PX } from '@/utils/constants'
import type { AnyControl } from '@/types/control'

/** 造一个 Fabric 覆盖对象桩 */
function mkObj(id: string, over: Partial<FabricOverlayObject> = {}): FabricOverlayObject {
  return {
    controlId: id,
    visible: true,
    left: 0,
    top: 0,
    angle: 0,
    // 40mm × 20mm（像素 = mm × MM_TO_PX）
    getScaledWidth: () => 40 * MM_TO_PX,
    getScaledHeight: () => 20 * MM_TO_PX,
    toControl: () => ({ id, type: 'table' }) as unknown as AnyControl,
    ...over,
  }
}

/** 造一个画布桩；默认视口为恒等变换 */
function mkCanvas(objs: unknown[], vt: number[] = [1, 0, 0, 1, 0, 0]): OverlayCanvas {
  return { viewportTransform: vt, getObjects: () => objs }
}

const isTableObj = (o: unknown): o is FabricOverlayObject =>
  typeof o === 'object' && o !== null && (o as FabricOverlayObject).controlId.startsWith('t')

const EMPTY_STORE: OverlayStoreLike = { controls: [], zones: [] }

function collect(
  canvas: OverlayCanvas | null | undefined,
  store: OverlayStoreLike = EMPTY_STORE,
  over: Partial<CollectOverlayOptions<FabricOverlayObject>> = {},
) {
  return collectOverlayItems<FabricOverlayObject>({
    canvas,
    store,
    isTarget: isTableObj,
    type: 'table',
    render: (c) => `<html:${c.id}>`,
    ...over,
  })
}

describe('collectOverlayItems', () => {
  it('画布未挂载（null / undefined）→ 空数组，不抛错', () => {
    expect(collect(null)).toEqual([])
    expect(collect(undefined)).toEqual([])
  })

  it('残缺 canvas 桩（缺 getObjects）→ 空数组，不抛错', () => {
    // 真实场景：React 测试里 mock 的 CanvasDesignerStub 只有 { requestRenderAll }
    const stub = { viewportTransform: [1, 0, 0, 1, 0, 0] } as unknown as OverlayCanvas
    expect(collect(stub)).toEqual([])
  })

  it('getObjects 返回非数组 → 空数组，不抛错', () => {
    const stub = {
      viewportTransform: [1, 0, 0, 1, 0, 0],
      getObjects: () => undefined,
    } as unknown as OverlayCanvas
    expect(collect(stub)).toEqual([])
  })

  it('只收集目标类型的对象，其余跳过', () => {
    const canvas = mkCanvas([mkObj('t1'), mkObj('x1'), mkObj('t2')])
    expect(collect(canvas).map((i) => i.id)).toEqual(['t1', 't2'])
  })

  it('visible === false 的对象不渲染', () => {
    const canvas = mkCanvas([mkObj('t1'), mkObj('t2', { visible: false })])
    expect(collect(canvas).map((i) => i.id)).toEqual(['t1'])
  })

  it('恒等视口：屏幕坐标 = 节点 left/top，尺寸按 mm 还原', () => {
    const canvas = mkCanvas([mkObj('t1', { left: 100, top: 50, angle: 30 })])
    const [it] = collect(canvas)
    expect(it).toMatchObject({ x: 100, y: 50, zoom: 1, angle: 30, widthMm: 40, heightMm: 20 })
  })

  it('视口变换生效：x = left × zoom + offsetX（与 CanvasDesigner 一致）', () => {
    const canvas = mkCanvas([mkObj('t1', { left: 100, top: 50 })], [2, 0, 0, 2, 30, 15])
    const [it] = collect(canvas)
    expect(it).toMatchObject({ x: 100 * 2 + 30, y: 50 * 2 + 15, zoom: 2 })
    // 尺寸不随视口缩放变化（缩放由 CSS transform 的 scale 承担）
    expect(it).toMatchObject({ widthMm: 40, heightMm: 20 })
  })

  it('viewportTransform 缺项时回落默认值（zoom 1 / 偏移 0）', () => {
    const canvas: OverlayCanvas = { viewportTransform: [], getObjects: () => [mkObj('t1', { left: 7, top: 9 })] }
    const [it] = collect(canvas)
    expect(it).toMatchObject({ x: 7, y: 9, zoom: 1 })
  })

  it('内容优先取 store 模型（真相源），而非 Fabric 对象自身的 toControl', () => {
    const canvas = mkCanvas([mkObj('t1')])
    const store: OverlayStoreLike = { controls: [{ id: 't1', type: 'table' } as AnyControl], zones: [] }
    const [it] = collect(canvas, store, { render: (c) => `from-store:${c.id}` })
    expect(it!.html).toBe('from-store:t1')
  })

  it('store 里有同名控件但类型不符 → 回落 obj.toControl()', () => {
    const canvas = mkCanvas([mkObj('t1')])
    const store: OverlayStoreLike = { controls: [{ id: 't1', type: 'text' } as AnyControl], zones: [] }
    const [it] = collect(canvas, store, { render: (c) => `type=${c.type}` })
    // 回落到 toControl（其 type 为 'table'）
    expect(it!.html).toBe('type=table')
  })

  it('zone 子控件也能作为内容真相源被命中', () => {
    const canvas = mkCanvas([mkObj('t1')])
    const store: OverlayStoreLike = {
      controls: [],
      zones: [{ children: [{ id: 't1', type: 'table' } as AnyControl] }],
    }
    const [it] = collect(canvas, store, { render: (c) => `zone:${c.id}` })
    expect(it!.html).toBe('zone:t1')
  })

  it('htmlOverride 返回字符串时优先采用（表格编辑期冻结 HTML）', () => {
    const canvas = mkCanvas([mkObj('t1'), mkObj('t2')])
    const items = collect(canvas, EMPTY_STORE, {
      htmlOverride: (id) => (id === 't1' ? '<frozen/>' : undefined),
    })
    expect(items.map((i) => i.html)).toEqual(['<frozen/>', '<html:t2>'])
  })

  it('htmlOverride 返回空串时也视为「有覆盖」（不回落 render）', () => {
    // 空串在 `??` 下会被采用 —— 冻结 HTML 理论不会为空，此处钉住该语义
    const canvas = mkCanvas([mkObj('t1')])
    const items = collect(canvas, EMPTY_STORE, { htmlOverride: () => '' })
    expect(items[0]!.html).toBe('')
  })
})

describe('overlayItemStyle', () => {
  it('transform 顺序为 translate → rotate → scale（与 Fabric 矩阵合成一致）', () => {
    const style = overlayItemStyle({ id: 't1', x: 12, y: 34, zoom: 1.5, angle: 45, widthMm: 40, heightMm: 20, html: '' })
    expect(style.transform).toBe('translate(12px, 34px) rotate(45deg) scale(1.5)')
    expect(style.width).toBe('40mm')
    expect(style.height).toBe('20mm')
  })
})
