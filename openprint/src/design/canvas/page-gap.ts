/**
 * 画布页间留白几何纯函数（设计态专用）。
 *
 * Word 式布局模型（与渲染端 `.op-content` / layoutStaticOnly 完全一致）：
 * - 正文控件 top 是**相对内容区起点**的 mm（内容区起点 = 页顶 + 上边距，页眉/页脚在上下边距内）
 * - 分页步长 stepMm = 页高 - 上边距（含下边距区）：top ∈ [0, stepMm) 属当前页
 * - 正文 top 越过 stepMm 才落入下一页（渲染端按 floor(top/stepMm) 分页，边距只作辅助不跨页）
 *
 * 画布视觉 = 页序堆叠：页 i 内容区起点 = i×(页高 + 间距) + 上边距 + 页内偏移
 * 页间距只叠加在画布 px 坐标上，模型 mm 保持 flush（与渲染/导出一致）。
 */
import { MM_TO_PX } from '@/utils/constants'

/** 模型 top(mm, 相对内容区) 所在页索引；首页恒为 0 */
function pageIndexOf(topMm: number, stepMm: number): number {
  if (topMm <= 0 || stepMm <= 0) return 0
  return Math.floor(topMm / stepMm)
}

/** 模型 top(mm) 所在页之前的累计页间距(px)；首页恒为 0 */
export function pageGapPx(topMm: number, stepMm: number, gapPx: number): number {
  const i = pageIndexOf(topMm, stepMm)
  return i > 0 ? i * gapPx : 0
}

/**
 * 模型 top(mm, 相对内容区) → 画布绝对 y(px)。
 * 页 i 的内容区起点 = i×(页高+间距) + 上边距；与渲染端 `.op-content`(上边距) 一致。
 */
export function modelTopToCanvasY(
  topMm: number,
  marginTopPx: number,
  stepMm: number,
  pageHeightPx: number,
  gapPx: number,
): number {
  if (stepMm <= 0) return marginTopPx + topMm * MM_TO_PX
  const i = pageIndexOf(topMm, stepMm)
  const local = topMm - i * stepMm
  return i * (pageHeightPx + gapPx) + marginTopPx + local * MM_TO_PX
}

/**
 * 画布绝对 y(px) → 模型 top(mm, 相对内容区)。
 * - 落在内容区内：精确反解
 * - 落在上边距/页眉：吸附到本页内容区起点
 * - 落在下边距/页脚/页间距：归入下一页内容区起点
 */
export function canvasYToModelTop(
  y: number,
  marginTopPx: number,
  stepMm: number,
  pageHeightPx: number,
  gapPx: number,
): number {
  const stride = pageHeightPx + gapPx
  const stepHpx = stepMm * MM_TO_PX
  // 预估页索引（按页顶 stride 堆叠）
  let i = Math.max(0, Math.floor((y - marginTopPx) / stride))
  const contentTop = i * stride + marginTopPx
  const contentBottom = contentTop + stepHpx
  if (y < contentTop) return i * stepMm
  if (y > contentBottom) return i * stepMm + stepMm
  return i * stepMm + (y - contentTop) / MM_TO_PX
}
