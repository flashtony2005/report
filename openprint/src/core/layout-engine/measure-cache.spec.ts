/**
 * 度量缓存 LRU 单测
 * 回归：旧行为 size>5000 全清 → 大表（500×20 = 1万 key）命中率归零、反复回流
 */
import { describe, expect, it } from 'vitest'
import {
  MEASURE_CACHE_LIMIT,
  recallMeasureCache,
  rememberMeasureCache,
} from './measure-cache'

describe('度量缓存 LRU', () => {
  it('命中会刷新 LRU 顺序（命中项移到队尾，不被优先淘汰）', () => {
    const cache = new Map<string, number>()
    // limit=2：b、a 排满；命中 a 后 a 变最新、b 变最旧；再写 c 超限 → 淘汰 b
    rememberMeasureCache(cache, 'a', 1, 2)
    rememberMeasureCache(cache, 'b', 2, 2)
    expect(recallMeasureCache(cache, 'a')).toBe(1)
    rememberMeasureCache(cache, 'c', 3, 2)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('c')).toBe(true)
  })

  it('超限时只淘汰最旧的 25%，而不是全清', () => {
    const cache = new Map<string, number>()
    const limit = 100
    for (let i = 0; i < limit; i++) rememberMeasureCache(cache, `k${i}`, i, limit)
    rememberMeasureCache(cache, 'new', -1, limit)
    expect(cache.size).toBe(76) // 100 + 1 - 25
    expect(cache.has('new')).toBe(true)
    expect(cache.has('k0')).toBe(false) // 最旧的被淘汰
    expect(cache.has('k99')).toBe(true) // 最新的保留
  })

  it('未命中返回 undefined 且不写入', () => {
    const cache = new Map<string, number>()
    expect(recallMeasureCache(cache, 'nope')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('默认上限 20000，足以容纳 500 行 × 20 列的大表', () => {
    expect(MEASURE_CACHE_LIMIT).toBeGreaterThanOrEqual(10_000)
  })
})
