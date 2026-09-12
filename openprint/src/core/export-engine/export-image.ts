/**
 * 位图导出（JPG）—— 基于 rasterize 的单页位图
 */
import type { LayoutResult } from '@/core/layout-engine/types'
import { pageToImageBlob, type PageImageOptions } from './rasterize'

export function pageToJpg(
  result: LayoutResult,
  index: number,
  opts: PageImageOptions = {},
): Promise<Blob> {
  return pageToImageBlob(result, index, { type: 'image/jpeg', ...opts })
}
