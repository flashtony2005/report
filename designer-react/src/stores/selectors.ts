/**
 * selectors —— designer store 的派生值（等价 Vue 版 computed）
 *
 * React 端组件用 `useDesignerStore(selectXxx)` 消费；zustand 会按引用浅比较，
 * 因此 selector 返回对象/数组时调用方须用单个字段订阅（见各函数注释）。
 */
import type { AnyControl, LabelGridControl, ZoneControl } from '@/types/control'
import { useDesignerStore, type DesignerStore } from './designer'

/** 单控件查找：body → 标签网格子控件 → zone 及其子控件（与 store 内 findControl 同语义） */
export function findControlIn(s: Pick<DesignerStore, 'controls' | 'zones'>, id: string): AnyControl | undefined {
  const inBody = s.controls.find((c) => c.id === id)
  if (inBody) return inBody
  for (const g of s.controls) {
    if (g.type === 'labelgrid') {
      const child = (g as LabelGridControl).children.find((c) => c.id === id)
      if (child) return child
    }
  }
  for (const z of s.zones as ZoneControl[]) {
    if (z.id === id) return z
    const child = z.children.find((c) => c.id === id)
    if (child) return child
  }
  return undefined
}

/**
 * 当前选中控件（多选时取第一个 —— 与 Vue 版 selectedControl 语义一致）。
 * 返回引用来自 state，选中不变则引用稳定，可安全用于组件订阅。
 */
export function selectSelectedControl(s: DesignerStore): AnyControl | null {
  const id = s.selectedIds[0]
  if (!id) return null
  return findControlIn(s, id) ?? null
}

/** 便捷 hook：当前选中控件（属性面板主消费点） */
export function useSelectedControl(): AnyControl | null {
  return useDesignerStore(selectSelectedControl)
}
