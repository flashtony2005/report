/**
 * Headless 无头模式入口 —— 汇总导出
 *
 * 用法：
 * ```ts
 * import { createHeadless } from '@/core/headless'
 * const headless = createHeadless({ repository, dataSource, fonts })
 * const { blobs, filenames } = await headless.exportPdf({ template, data }, { scale: 2 })
 * blobs.forEach((b, i) => downloadBlob(b, filenames[i]))
 * headless.dispose()
 * ```
 */
export { createHeadless } from './createHeadless'
export type {
  HeadlessOptions,
  HeadlessRequest,
  HeadlessInstance,
  HeadlessExportOptions,
} from './createHeadless'
export { loadFonts, embedFontsInSvg, embedFontsInHtml } from './loader'
export type { FontFaceDef } from '@/core/export-engine/fonts'
