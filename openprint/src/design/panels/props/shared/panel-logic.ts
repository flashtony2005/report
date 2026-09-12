/**
 * panel-logic —— 属性面板共享业务逻辑（框架无关，Vue / React 两端同源）
 *
 * 这些「业务决策」原先散落在各 .vue 面板的 script 里，重写 React 面板时逐行翻译
 * 必然漂移。抽成纯函数后两端 import 同一份，行为由 panel-logic.spec.ts 把关。
 *
 * 契约：全部为纯函数 —— 输入控件对象（或字段值），输出 patch（Partial）或值，
 * **不触碰任何 store**。调用方负责把返回的 patch 交给 store.updateControl。
 */
import type { CellFormat, CellFormatKind, TextControl } from '@/types/control'
import { datePatternOptions, makeFormat, suggestKindByFieldType } from '@/design/format-options'

/** 内容类型：固定值 / 变量（字段绑定）/ 表达式（与 ContentValueEditor 的 ContentMode 一致） */
export type ContentMode = 'fixed' | 'variable' | 'expression'

/** 携带内容三态字段的结构子集 —— TextControl / BarcodeControl / QrcodeControl 等均满足
 *  （type 别名而非 interface：type 可赋值给 Record<string, unknown>，方便 patch 透传） */
export type ContentCarrier = {
  contentType?: ContentMode
  binding?: string
  expression?: string
}

/* ------------------------------ 内容模式 ------------------------------ */

/**
 * 判别控件当前的内容模式。
 * 显式 contentType 优先（新协议）；缺失时按老模板回退：expression > binding > fixed。
 */
export function resolveContentMode(c: ContentCarrier | null | undefined): ContentMode {
  if (c?.contentType) return c.contentType
  return c?.expression ? 'expression' : c?.binding ? 'variable' : 'fixed'
}

/** 模式切换的 patch 产物：写 contentType + 清空不该保留的字段 */
export function contentModePatch(mode: ContentMode): ContentCarrier {
  if (mode === 'fixed')
    return { contentType: 'fixed', binding: undefined, expression: undefined }
  if (mode === 'variable')
    return { contentType: 'variable', expression: undefined }
  return { contentType: 'expression', binding: undefined }
}

/* ------------------------------ 样式合并 ------------------------------ */

/**
 * patchStyle 语义：浅合并进已有 style，返回**新控件对象**（不改原对象）。
 * 返回值整体作为 updateControl 的 patch 使用（{ style: merged }）。
 */
export function mergeStyle(
  control: TextControl,
  p: Partial<NonNullable<TextControl['style']>>,
): TextControl {
  return { ...control, style: { ...control.style, ...p } }
}

/* ------------------------------ 数据格式 ------------------------------ */

/** patchFormat 语义：kind=none 输出 undefined（清除格式字段），否则原样透传 */
export function formatPatch(fmt: CellFormat): CellFormat | undefined {
  return fmt.kind === 'none' ? undefined : fmt
}

/**
 * 格式类型切换（下拉选了某个 kind）：
 * - 从无到有 / 换类型 → 套用该类型默认格式（避免半成品）
 * - 同类型重复选择 → 保留用户已改的格式（不重置）
 */
export function formatKindFirstPatch(
  cur: CellFormat | undefined,
  kind: CellFormatKind,
): CellFormat | undefined {
  if (kind === 'none') return undefined
  return cur && cur.kind === kind ? cur : makeFormat(kind)
}

/** 是否为预设日期模板（区别于用户自定义 pattern） */
export function isPresetDatePattern(p?: string): boolean {
  return Boolean(p && datePatternOptions.some((o) => o.value !== '__custom__' && o.value === p))
}

/** 绑定字段类型 → 建议文案（仅提示，不落库） */
export function formatHint(fieldType: string | undefined): string {
  const k = suggestKindByFieldType(fieldType)
  if (k === 'date') return '绑定的字段为「日期」类型，建议选择日期格式。'
  if (k === 'decimal') return '绑定的字段为「数值」类型，建议选择整数 / 小数 / 货币格式。'
  return ''
}
