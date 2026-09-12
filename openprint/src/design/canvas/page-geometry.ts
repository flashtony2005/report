/**
 * 画布多页几何纯函数（与渲染端 layoutStaticOnly 的落页口径一致）。
 *
 * 正文控件按「上边距 + 页眉高 + top」绝对定位（top 为相对正文区 mm，见 page-gap.ts），
 * 越过正文可用高（bodyHeight）即落入下一页。
 * 物理页数 = floor(maxBottomMm / stepMm) + 1（stepMm = 正文可用高，即分页步长）。
 */
export function computePhysicalPageCount(maxBottomMm: number, stepMm: number): number {
  if (stepMm <= 0) return 1
  if (maxBottomMm <= 0) return 1
  return Math.max(1, Math.floor(maxBottomMm / stepMm) + 1)
}
