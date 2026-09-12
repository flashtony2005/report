/**
 * LabelGridProps 共享逻辑（P4.2）—— Vue / React 两端同源。
 *
 * 从 LabelGridProps.vue 抽出的几何计算纯函数：列数上限、可见行数、
 * 「改布局后容器宽高跟随重算」（所见即所得）、行数 → 高度、卡片贴合内容。
 * 底层几何来自 @/core/layout-engine/label-grid（纯 TS 两端可用）。
 */
import type { LabelGridControl } from '@/types/control'
import { resolveGridGeometry, labelCardBounds } from '@/core/layout-engine/label-grid'

/** 空几何兜底（无控件时展示用） */
export function emptyGridGeo(): ReturnType<typeof resolveGridGeometry> {
  return { columns: 3, gapX: 2, gapY: 2, cardWidth: 0, cardHeight: 0 }
}

/** 按当前卡片宽 + 间距，内容区最多能放几列 */
export function maxColumnsOf(contentWidth: number, geo: { gapX: number; cardWidth: number }): number {
  return Math.max(1, Math.floor((contentWidth + geo.gapX) / (geo.cardWidth + geo.gapX)))
}

/** 网格容器可见行数（渲染期数据更多时会自动继续跨页） */
export function visibleRowsOf(c: LabelGridControl | null | undefined, geo: { cardHeight: number; gapY: number }): number {
  const step = geo.cardHeight + geo.gapY
  if (!c || step <= 0) return 1
  return Math.max(1, Math.floor((c.height + geo.gapY) / step))
}

/** 页面内容区宽度（列数上限提示用） */
export function contentWidthOf(pageSetup: { width: number; margin: { left: number; right: number } }): number {
  return Math.max(1, pageSetup.width - pageSetup.margin.left - pageSetup.margin.right)
}

/** 改列数/卡片宽/间距后，容器宽度跟着重算，保证包围盒 = 实际铺满范围（所见即所得）。
 *  返回完整 patch（含重算的 width/height），调用方直接 updateControl。 */
export function geometryPatch(
  c: LabelGridControl,
  p: Partial<LabelGridControl>,
  visibleRows: number,
): Partial<LabelGridControl> {
  const next = { ...c, ...p }
  const g = resolveGridGeometry(next)
  return {
    ...p,
    width: Math.round((g.cardWidth * g.columns + g.gapX * (g.columns - 1)) * 10) / 10,
    height: Math.round((g.cardHeight * visibleRows + g.gapY * (visibleRows - 1)) * 10) / 10,
  }
}

/** 行数直接决定容器高度 */
export function rowsHeightPatch(
  geo: { cardHeight: number; gapY: number },
  rows: number,
): Partial<LabelGridControl> {
  return { height: Math.round((geo.cardHeight * rows + geo.gapY * (rows - 1)) * 10) / 10 }
}

/** 卡片尺寸按模板内容包围盒收紧（返回 geometryPatch 形式的 patch） */
export function fitCardPatch(c: LabelGridControl, visibleRows: number): Partial<LabelGridControl> {
  const b = labelCardBounds(c.children)
  return geometryPatch(
    c,
    {
      cardWidth: Math.max(1, Math.round(b.width * 10) / 10),
      cardHeight: Math.max(1, Math.round(b.height * 10) / 10),
    },
    visibleRows,
  )
}
