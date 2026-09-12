/**
 * sample-value —— 字段示例值提取（框架无关，Vue / React 两端同源）
 *
 * 原先内联在 VariableModal.vue 的 script 里：resolvePath / formatSample /
 * sampleOf / TYPE_META。抽成纯函数后两端 import 同一份，行为由
 * sample-value.spec.ts 把关 —— 弹窗的「示例值」列在两端物理上不可能漂移。
 *
 * 契约：全部纯函数，不触碰任何 store；previewData 由调用方传入。
 */
import type { FieldDef } from '@/types/datasource'

/* ----------------------------- 路径解析 ----------------------------- */

/** 逐级解析 a.b.c；中途遇到非对象返回 undefined（与 Vue 版行为一致） */
export function resolveSamplePath(target: unknown, path: string): unknown {
  let cur = target
  for (const k of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/* ----------------------------- 值格式化 ----------------------------- */

export function formatSampleValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（无示例值）'
  if (Array.isArray(v)) return `数组（${v.length} 项）`
  if (typeof v === 'object') return '对象'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/**
 * 字段示例值：优先取 previewData 真实值（预览 = 弹窗示例，同一数据源），
 * 缺失回退 FieldDef.sample。数组标记 `items[].qty` 取首行叶子值。
 */
export function sampleOfField(f: FieldDef, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>
  const marker = f.path.indexOf('[]')
  if (marker >= 0) {
    // items[].qty → data.items 首行 .qty
    const arrPath = f.path.slice(0, marker)
    const leaf = f.path.slice(marker + 2).replace(/^\./, '')
    const arr = resolveSamplePath(d, arrPath)
    if (Array.isArray(arr) && arr.length > 0) {
      const row = arr[0] as Record<string, unknown>
      if (leaf) return formatSampleValue(row[leaf])
      return formatSampleValue(arr)
    }
    return formatSampleValue(f.sample)
  }
  const v = resolveSamplePath(d, f.path)
  if (v === undefined || v === null) return formatSampleValue(f.sample)
  return formatSampleValue(v)
}

/* ----------------------------- 类型元信息 ----------------------------- */

export const TYPE_META: Record<string, { label: string; color: string }> = {
  string: { label: '文本', color: '#1677ff' },
  number: { label: '数字', color: '#18a058' },
  date: { label: '日期', color: '#9c27b0' },
  boolean: { label: '布尔', color: '#f59e0b' },
  image: { label: '图片', color: '#eb2f96' },
  array: { label: '数组', color: '#13c2c2' },
  object: { label: '对象', color: '#8c8c8c' },
}

export function typeMeta(f: FieldDef): { label: string; color: string } {
  return TYPE_META[f.type] ?? { label: f.type, color: '#8c8c8c' }
}
