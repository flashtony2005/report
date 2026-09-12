/**
 * dataSource shim —— 让 Vue 项目的 `table-design-render` 在 React 端可用（零改动原文件）
 *
 * 背景：`src/design/canvas/table-design-render.ts` 为了给「设计期动态配色」取样例数据，
 * 直接 `useDataSourceStore()`（Pinia）。React 项目没有 pinia，直接 import 会解析失败。
 *
 * 解决：vite alias 把 `@/design/stores/dataSource` 指向本文件，导出同名的
 * `useDataSourceStore()`，内部委托 React 端 zustand store 的 `selectPreviewData`
 * （P3.3 已把 previewData 提升进真正的 store，本 shim 只保留探针计数器）。
 *
 * 注意：调用方 `table-design-render.buildSampleCtx()` 已有 try/catch 兜底，
 * 因此本 shim 抛错也不会让画布崩，只会退化成空上下文。
 */
import {
  selectPreviewData,
  useDataSourceStore as useReactDataSourceStore,
} from '../../stores/dataSource'

export function useDataSourceStore(): { previewData: unknown } {
  computeCount++
  return { previewData: selectPreviewData(useReactDataSourceStore.getState()) }
}

/**
 * 被本 shim 服务的次数。
 *
 * 存在的意义：如果 vite alias 被误删，`table-design-render` 会回退到 Vue 项目的 Pinia store，
 * 在无 active pinia 时抛错并被 `buildSampleCtx` 的 try/catch 默默兜底 —— 功能退化成
 * 「设计期动态配色失效」，但不报错、测试也可能全绿。
 * 断言本计数 > 0 即可证明**样例数据确实来自本 shim**，把这个静默失效变成红灯。
 */
let computeCount = 0
export function getPreviewComputeCount(): number {
  return computeCount
}

/** 测试用：清空计数 */
export function resetPreviewCache(): void {
  computeCount = 0
}

