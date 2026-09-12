/**
 * 模板占位符扫描器 —— 从模板里提取所有 `{{xxx}}` 占位符的可映射字段名。
 *
 * ## 用途
 * 流水标签批量打印：用户在设计器里给标签控件绑了 `{{no}}`、`{{name}}` 等，
 * 上传 Excel 后需要把占位符 ↔ Excel 列做映射。这里负责「扫模板、提字段」。
 *
 * ## 规则
 * - 走 JSON.stringify 深扫（body / 页眉页脚 / labelgrid children / 表格列表达式全覆盖）
 * - 提取 `{{ expr | filter }}` 里的表达式部分，剥离引号串后找标识符
 * - 跳过特殊变量（data / row / rowIndex / page / pages 等），它们不是数据列
 * - 返回去重排序后的字段名列表
 */
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'
import type { ImportColumn } from '@/types/data-import'

/** 表达式引擎里的特殊根变量，不是可映射的数据列 */
const SPECIAL_VARS = new Set([
  'data',
  'row',
  'rowIndex',
  'page',
  'pages',
  'pageNo',
  'pageNumber',
  'pageCount',
  'totalPages',
])

const MUSTACHE_RE = /\{\{([\s\S]*?)\}\}/g

/**
 * 从模板里提取所有可映射的占位符字段名（去重 + 排序）。
 * 模板里的 `{{no}}`、`{{order.no}}`（根 order）、`{{name | upper}}` 都能扫到 `no` / `order` / `name`。
 */
export function scanTemplatePlaceholders(template: TemplateData<AnyControl>): string[] {
  const json = JSON.stringify(template)
  const fields = new Set<string>()

  for (const m of json.matchAll(MUSTACHE_RE)) {
    const body = (m[1] ?? '').trim()
    if (!body) continue
    // 取管道前的表达式部分（过滤器参数里的 'CNY' 之类不是数据列）
    const expr = body.split('|')[0] ?? ''
    // 剥离引号串，避免把字符串字面量里的单词当字段
    const cleaned = expr.replace(/'[^']*'|"[^"]*"/g, '')
    for (const id of cleaned.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) ?? []) {
      if (!SPECIAL_VARS.has(id)) fields.add(id)
    }
  }

  return [...fields].sort()
}

/**
 * 占位符 ↔ Excel 列自动匹配（大小写不敏感 + 去空格）。
 * 返回 `placeholder → column.key | null`（null = 未匹配，需手动选）。
 */
export function autoMapFields(
  placeholders: string[],
  columns: ImportColumn[],
): Record<string, string | null> {
  const lowerKeys = new Map<string, string>()
  for (const c of columns) {
    lowerKeys.set(c.key.trim().toLowerCase(), c.key)
  }
  const out: Record<string, string | null> = {}
  for (const ph of placeholders) {
    out[ph] = lowerKeys.get(ph.trim().toLowerCase()) ?? null
  }
  return out
}
