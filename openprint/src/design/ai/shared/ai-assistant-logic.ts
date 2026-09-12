/**
 * ai-assistant-logic —— AI 设计助手面板的纯逻辑（框架无关）
 *
 * 从 Vue 版 `design/ai/AiAssistantPanel.vue` 1:1 抽出，供 Vue 端与 React 端共用：
 * 数据字段解析、打字动画步长、选区改写 diff（改/加/删）、模式回退。
 * 不依赖 DOM / Vue / React。
 */
import type { AnyControl } from '@/types/control'

/* ------------------------------ 渐进呈现（打字动画） ------------------------------ */

/** 最小可见逐字动画时长：即使中转把 SSE 缓冲成一块，也保证至少这么长的逐字呈现 */
export const REVEAL_MIN_MS = 1600
/** 打字动画刷新间隔 */
export const REVEAL_TICK_MS = 24

/**
 * 单次 tick 应消费的字符数：保证整个缓冲至少花 REVEAL_MIN_MS 呈现完。
 * q 为 0 时返回 0（无事可刷）。
 */
export function computeRevealStep(queued: number): number {
  if (queued <= 0) return 0
  const totalTicks = Math.max(1, Math.round(REVEAL_MIN_MS / REVEAL_TICK_MS))
  return Math.max(1, Math.ceil(queued / totalTicks))
}

/* ------------------------------ 数据字段接地 ------------------------------ */

/** 把用户输入的字段串解析为数组：逗号（中英）/ 换行分隔，去空 */
export function parseDatasourceFields(text: string): string[] {
  return text
    .split(/[，,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/* ------------------------------ 选区改写 diff ------------------------------ */

export interface SelectedDiff {
  /** 原位替换（id 在锁定选区里）：整对象覆盖 */
  inPlace: AnyControl[]
  /** 新增控件（AI 新造的 id） */
  added: AnyControl[]
  /** 被 AI 删掉的原选中控件 id */
  removedIds: string[]
  /** 「改 n / 加 n / 删 n」，全 0 时为「无变化」 */
  summary: string
}

/**
 * C 模式（选中部分改写）结果 diff：
 * 返回的控件 id 在锁定选区 → 原位替换；不在 → 新增；锁定选区里消失的 → 删除。
 */
export function diffSelectedControls(
  controls: AnyControl[],
  lockedIds: string[],
): SelectedDiff {
  const targetIds = new Set(lockedIds)
  const returnedIds = new Set(controls.map((c) => c.id))
  const inPlace: AnyControl[] = []
  const added: AnyControl[] = []
  for (const ctrl of controls) {
    if (targetIds.has(ctrl.id)) inPlace.push(ctrl)
    else added.push(ctrl)
  }
  const removedIds = lockedIds.filter((id) => !returnedIds.has(id))
  const parts = [
    inPlace.length ? `改 ${inPlace.length}` : '',
    added.length ? `加 ${added.length}` : '',
    removedIds.length ? `删 ${removedIds.length}` : '',
  ]
    .filter(Boolean)
    .join(' / ')
  return { inPlace, added, removedIds, summary: parts || '无变化' }
}

/* ------------------------------ 模式 ------------------------------ */

export type AiMode = 'create' | 'modify' | 'selected'

/** 选区丢失时回退到「新建」，避免误生成整份模板 */
export function resolveMode(mode: AiMode, hasSelection: boolean): AiMode {
  return mode === 'selected' && !hasSelection ? 'create' : mode
}

/** 模板信息卡摘要：`210×297 mm · 12 个控件` */
export function templateMeta(
  tpl: { document: { page: { width: number; height: number; unit: string }; sections: Array<{ components?: unknown[] }> } } | undefined,
): string {
  if (!tpl) return ''
  const p = tpl.document.page
  const count = tpl.document.sections.reduce((n, s) => n + (s.components?.length ?? 0), 0)
  return `${p.width}×${p.height} ${p.unit} · ${count} 个控件`
}
