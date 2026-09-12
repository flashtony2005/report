/**
 * control-scan —— 布局结果的控件扫描小工具
 *
 * 用途：让渲染端能按「模板里到底有没有用到某类控件」来决定要不要带上对应资源，
 * 避免为用不到的功能付出固定成本。目前用于 KaTeX CSS 的按需注入 ——
 * 模板里没有公式控件时，每份文档可省掉约 24 kB 的样式。
 */
import type { LayoutResult, PlacedNode } from './types'
import type { AnyControl } from '@/types/control'

/** 被放置的节点是否为指定类型的控件 */
function isControlType(node: PlacedNode, type: AnyControl['type']): boolean {
  return node.kind === 'control' && node.control?.type === type
}

/**
 * 布局结果中是否包含指定类型的**顶层**控件（含页眉 / 页脚）。
 *
 * 只扫顶层是有意为之：表格单元格目前不支持公式 / 图表这类控件
 * （见 table-cells.ts 的 cell 类型白名单），递归进去没有意义还白耗性能。
 */
export function layoutHasControlType(result: LayoutResult, type: AnyControl['type']): boolean {
  return result.pages.some(
    (page) =>
      page.header?.some((c) => c.control?.type === type) ||
      page.footer?.some((c) => c.control?.type === type) ||
      page.body?.some((n) => isControlType(n, type)),
  )
}

/** 布局结果中是否包含公式控件（KaTeX 渲染产物） */
export function layoutHasMath(result: LayoutResult): boolean {
  return layoutHasControlType(result, 'math')
}
