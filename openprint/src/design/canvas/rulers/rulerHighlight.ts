/**
 * rulerHighlight —— 标尺高亮带共享状态（框架无关）
 *
 * SmartGuides 在 object:moving / object:scaling / selection 事件里，
 * 把「当前选中/拖拽元素的包围盒（画布逻辑 px = 页面 px，未含缩放/平移）」
 * 写入这个模块级共享状态；RulerOverlay 读取后按 viewport 映射成标尺上的彩色高亮带
 * （顶标尺带 = 元素宽度，左标尺带 = 元素高度），随组件移动丝滑滑动。
 *
 * 历史：原先用 Vue 的 `ref()`。为了跨框架复用（React 设计器直接 import 本模块），
 * 改为「getter/setter + 显式订阅」的框架无关实现 —— 写入方（SmartGuides）的
 * `rulerBand.value = x` 语法完全不变；Vue 侧（RulerOverlay）通过 `onRulerBandChange`
 * 订阅来保持响应式，React 侧配合 useSyncExternalStore 使用。
 *
 * 仍用模块级状态而非 Pinia store，是为了避免把画布引擎模块与组件 store 耦合。
 */
export interface RulerBand {
  /** 左边缘（画布逻辑 px） */
  left: number
  /** 上边缘（画布逻辑 px） */
  top: number
  /** 宽（画布逻辑 px） */
  width: number
  /** 高（画布逻辑 px） */
  height: number
}

let current: RulerBand | null = null
const listeners = new Set<() => void>()

export const rulerBand = {
  get value(): RulerBand | null {
    return current
  },
  set value(next: RulerBand | null) {
    if (next === current) return
    current = next
    for (const fn of listeners) fn()
  },
}

/** 订阅变更，返回取消订阅函数（Vue 端 onMounted 订阅 / React 端 useSyncExternalStore） */
export function onRulerBandChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 取当前快照（useSyncExternalStore 的 getSnapshot：引用稳定，同值不触发重渲染） */
export function getRulerBand(): RulerBand | null {
  return current
}
