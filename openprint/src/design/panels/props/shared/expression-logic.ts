/**
 * 表达式弹窗共享逻辑 —— Vue / React 两端同源（P4.1）。
 *
 * 从 ExpressionModal.vue 抽出的全部可测纯逻辑：
 * - 目录搜索过滤（filterCatalog）
 * - 样例求值上下文构造（buildSampleCtx）
 * - 实时预览求值（evalExpressionPreview）
 * - 光标处插入片段（insertSnippetAtCursor，返回新串 + 新光标位，DOM 操作由各端做）
 * - 预设色板与自选色 hex 规范化（PRESET_COLORS / normalizePickedHex）
 *
 * 求值引擎：@/core/layout-engine/expression（interpolate，纯 TS 两端可用）。
 */
import { interpolate } from '@/core/layout-engine/expression'
import type { EvalContext } from '@/core/layout-engine/types'
import { EXPRESSION_CATALOG } from '@/design/expression-catalog'
import type { ExprCategory } from '@/design/expression-catalog'

/* ----------------------------- 预设色板 ----------------------------- */
/** 常用色块（点一下即插入对应 hex 字面量） */
export const PRESET_COLORS: { name: string; hex: string }[] = [
  { name: '红', hex: '#D93636' },
  { name: '橙', hex: '#F08C00' },
  { name: '黄', hex: '#F0C800' },
  { name: '绿', hex: '#0D8B3C' },
  { name: '蓝', hex: '#1677FF' },
  { name: '紫', hex: '#6B5CFF' },
  { name: '灰', hex: '#86909C' },
  { name: '黑', hex: '#1F2329' },
]

/**
 * 规范化取色器返回的 hex：#D93636 或 #D93636FF（去 alpha 后两位），统一大写。
 * 空值原样返回（调用方自行判空）。
 */
export function normalizePickedHex(hex: string): string {
  if (!hex) return hex
  return (hex.length === 9 ? hex.slice(0, 7) : hex).toUpperCase()
}

/* ----------------------------- 目录搜索过滤 ----------------------------- */
/**
 * 按关键字过滤函数目录（匹配 label / description / snippet，大小写不敏感）。
 * 空关键字返回原目录；命中的分类保留、无命中项的分类剔除。
 */
export function filterCatalog(keyword: string, catalog: ExprCategory[] = EXPRESSION_CATALOG): ExprCategory[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return catalog
  return catalog
    .map((cat) => ({
      ...cat,
      items: cat.items.filter(
        (it) =>
          it.label.toLowerCase().includes(kw) ||
          it.description.toLowerCase().includes(kw) ||
          it.snippet.toLowerCase().includes(kw),
      ),
    }))
    .filter((cat) => cat.items.length > 0)
}

/* ----------------------------- 样例求值上下文 ----------------------------- */
/**
 * 用预览数据构造样例 EvalContext（与 Vue 版弹窗行为一致）：
 * items 取数据根下数组字段 items 的首行作为 row。
 */
export function buildSampleCtx(previewData: unknown): EvalContext {
  const data = (previewData ?? {}) as Record<string, unknown>
  const items = Array.isArray(data['items']) ? (data['items'] as unknown[]) : []
  const row = items.length ? (items[0] as Record<string, unknown>) : undefined
  return { data, row, rowIndex: 0, page: 1, pages: 3 }
}

/* ----------------------------- 实时预览求值 ----------------------------- */
/** 预览结果：求值文本或错误列表（求值抛异常也归一为 errors） */
export interface ExprPreviewResult {
  text: string
  errors: string[]
}

/** 对表达式源码求值（空串直接返回空结果） */
export function evalExpressionPreview(src: string, ctx: EvalContext): ExprPreviewResult {
  if (!src.trim()) return { text: '', errors: [] }
  try {
    const r = interpolate(src, ctx)
    return { text: r.text, errors: r.errors }
  } catch (e) {
    return { text: '', errors: [e instanceof Error ? e.message : String(e)] }
  }
}

/* ----------------------------- 光标处插入片段 ----------------------------- */
export interface SnippetInsertResult {
  /** 插入后的完整表达式 */
  next: string
  /** 插入片段之后的光标位置（选区起点 = 终点） */
  caret: number
}

/**
 * 在 [start, end) 选区处插入片段（无选区时 start === end）。
 * 纯字符串计算，不触碰 DOM —— 各端拿到结果后自行 setSelectionRange / focus。
 * start/end 缺省时视为追加到末尾。
 */
export function insertSnippetAtCursor(
  current: string,
  snippet: string,
  start?: number,
  end?: number,
): SnippetInsertResult {
  const s = start ?? current.length
  const e = end ?? current.length
  const next = current.slice(0, s) + snippet + current.slice(e)
  return { next, caret: s + snippet.length }
}
