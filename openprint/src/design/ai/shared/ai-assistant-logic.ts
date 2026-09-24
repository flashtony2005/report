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
  /** 被 AI 删掉的原选中控件 id（模型**故意**没返回的） */
  removedIds: string[]
  /** 归一化丢掉的 id：**不算删除**，调用方应保持原样不动 */
  preservedIds: string[]
  /** 丢掉、但**认不出是哪个**（模型没给 id）的条数。>0 时本函数**不执行任何删除** */
  unattributedDrops: number
  /** 「改 n / 加 n / 删 n / 保 n」，全 0 时为「无变化」 */
  summary: string
}

/**
 * C 模式（选中部分改写）结果 diff：
 * 返回的控件 id 在锁定选区 → 原位替换；不在 → 新增；锁定选区里消失的 → 删除。
 *
 * ⚠️ **`dropped` 不是可选的装饰。** 一个选中控件「没出现在返回值里」有两种原因：
 *   1. 模型故意不返回 → 用户要删它；
 *   2. 归一化看不懂它、丢掉了 → 我们该保它。
 * 这两种在 `controls` 里长得**一模一样**。少了 `dropped`，第 2 种会被当成第 1 种
 * → `removeControl` **真删掉用户的控件**，界面还报成功。
 * 所以这个参数**必填**：让「忘记区分」在类型层面就写不出来。
 *
 * 还有一层：丢掉的东西若**没带 id**，连「是哪一个」都不知道 → 此时**一律不删**
 * （见 `unattributedDrops`）。两种错法的代价不对称：
 * 少删一个控件是**看得见**的（控件还在，想删再删一次），
 * 多删一个是**看不见**的（静默丢数据）。保守优先于「猜对」。
 */
export function diffSelectedControls(
  controls: AnyControl[],
  lockedIds: string[],
  /** 归一化丢掉的东西（见 `DroppedLike` / `DroppedItem`） */
  dropped: DroppedLike[],
): SelectedDiff {
  const targetIds = new Set(lockedIds)
  const returnedIds = new Set(controls.map((c) => c.id))
  const droppedSet = new Set(droppedIds(dropped))
  const inPlace: AnyControl[] = []
  const added: AnyControl[] = []
  for (const ctrl of controls) {
    if (targetIds.has(ctrl.id)) inPlace.push(ctrl)
    else added.push(ctrl)
  }
  const preservedIds = lockedIds.filter((id) => droppedSet.has(id))
  const unattributedDrops = dropped.filter((d) => !d.id).length
  // 只有「既没返回、也不在丢弃名单里」的才算用户要删；
  // 但只要有一件丢弃认不出是哪个，就整体不删。
  const removedIds =
    unattributedDrops > 0
      ? []
      : lockedIds.filter((id) => !returnedIds.has(id) && !droppedSet.has(id))
  const parts = [
    inPlace.length ? `改 ${inPlace.length}` : '',
    added.length ? `加 ${added.length}` : '',
    removedIds.length ? `删 ${removedIds.length}` : '',
    preservedIds.length ? `保 ${preservedIds.length}` : '',
  ]
    .filter(Boolean)
    .join(' / ')
  return {
    inPlace,
    added,
    removedIds,
    preservedIds,
    unattributedDrops,
    summary: parts || '无变化',
  }
}

/* ------------------------------ 丢弃上报 ------------------------------ */

/**
 * 归一化丢掉的东西的最小形状。
 * 故意**不** import `@/ai/normalize` 的 `DroppedItem`：本文件要零依赖（Vue/React 两端共用）。
 * 结构与它保持一致即可。
 */
export interface DroppedLike {
  kind: 'control' | 'section'
  type: string
  id?: string
  reason: string
}

/** 丢掉的东西里能对应到具体控件的 id（拿它去 `diffSelectedControls` 的第 3 参） */
export function droppedIds(dropped: DroppedLike[]): string[] {
  return dropped
    .map((d) => d.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
}

/**
 * 「有 N 个控件 AI 处理不了」的统一文案。
 * 两端共用一份，免得各写一份慢慢走样（这正是本项目踩过的漂移坑）。
 */
export function droppedNotice(dropped: DroppedLike[]): string {
  if (!dropped.length) return ''
  const types = [...new Set(dropped.map((d) => d.type))].join(' / ')
  return `有 ${dropped.length} 个控件 AI 处理不了（类型：${types}），已跳过。`
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
