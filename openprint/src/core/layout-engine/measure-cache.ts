/**
 * 度量缓存的 LRU 淘汰（纯函数，独立单测）
 *
 * ## 为什么单独成模块
 * 文本度量是分页精度的关键：DomMeasurer 每格一次 `getBoundingClientRect()`
 * （强制同步布局），命中缓存才能避免回流风暴。
 * 旧实现 `if (cache.size > 5000) cache.clear()` 在大表（500 行 × 20 列 = 1 万唯一 key）
 * 越过阈值时整体清空 → 命中率归零、反复回流。
 * 这里改成：命中刷新 LRU 顺序 + 超限只淘汰最旧 25%。
 *
 * 抽成纯函数的原因与 `page-gap.ts` / `ruler-geometry.ts` / `touch-gesture.ts` 一致：
 * 引擎内部的缓存策略必须可单测，不能只靠「跑起来没崩」。
 */
/** 缓存上限（条目数） */
export const MEASURE_CACHE_LIMIT = 20000
/** 超限时淘汰的比例（最旧的 25%） */
export const MEASURE_CACHE_EVICT_RATIO = 0.25

/**
 * 读取缓存并刷新 LRU 位置（命中即移到队尾）。
 * 未命中返回 undefined。
 */
export function recallMeasureCache<V>(
  cache: Map<string, V>,
  key: string,
): V | undefined {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

/**
 * 写入缓存并维护容量：命中上限时淘汰**最旧的 25%** 而非全清，
 * 保证热数据（同一列的相同文本）持续命中。
 */
export function rememberMeasureCache<V>(
  cache: Map<string, V>,
  key: string,
  value: V,
  limit: number = MEASURE_CACHE_LIMIT,
  evictRatio: number = MEASURE_CACHE_EVICT_RATIO,
): void {
  cache.set(key, value)
  if (cache.size <= limit) return
  const drop = Math.max(1, Math.floor(limit * evictRatio))
  let n = 0
  for (const k of cache.keys()) {
    cache.delete(k)
    if (++n >= drop) break
  }
}
