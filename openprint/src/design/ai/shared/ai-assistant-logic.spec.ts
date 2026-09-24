/**
 * ai-assistant-logic 共享纯逻辑测试（Vue 端承载，两端同源）
 */
import { describe, expect, it } from 'vitest'
import type { AnyControl } from '@/types/control'
import {
  REVEAL_MIN_MS,
  REVEAL_TICK_MS,
  computeRevealStep,
  diffSelectedControls,
  droppedIds,
  droppedNotice,
  parseDatasourceFields,
  resolveMode,
  templateMeta,
  type DroppedLike,
} from './ai-assistant-logic'

const ctrl = (id: string): AnyControl => ({
  id,
  type: 'text',
  left: 10,
  top: 10,
  width: 30,
  height: 8,
} as unknown as AnyControl)

describe('computeRevealStep（打字动画步长）', () => {
  it('常量关系：总 tick 数 = MIN/TICK', () => {
    expect(REVEAL_MIN_MS / REVEAL_TICK_MS).toBeCloseTo(66.67, 1)
  })

  it('空缓冲返回 0', () => {
    expect(computeRevealStep(0)).toBe(0)
  })

  it('整块缓冲按总 tick 均摊，保证至少 1.6s 呈现', () => {
    const q = 2000
    const step = computeRevealStep(q)
    const ticks = Math.ceil(q / step)
    expect(ticks).toBeGreaterThanOrEqual(66)
    expect(step).toBeGreaterThanOrEqual(1)
  })

  it('小缓冲单字步进', () => {
    expect(computeRevealStep(3)).toBe(1)
  })
})

describe('parseDatasourceFields（字段串解析）', () => {
  it('中英逗号 / 换行混分 + 去空去空白', () => {
    expect(parseDatasourceFields('a.b， c.d,\ne.f , ， g')).toEqual(['a.b', 'c.d', 'e.f', 'g'])
  })

  it('空串返回空数组', () => {
    expect(parseDatasourceFields('')).toEqual([])
    expect(parseDatasourceFields('，，\n')).toEqual([])
  })
})

describe('diffSelectedControls（选区改写 diff）', () => {
  const drop = (id?: string): DroppedLike =>
    ({ kind: 'control', type: 'chart', ...(id ? { id } : {}), reason: '类型不在白名单' }) as DroppedLike

  it('原位改 / 新增 / 删除 三类齐全，摘要正确', () => {
    const d = diffSelectedControls([ctrl('a'), ctrl('a2'), ctrl('new')], ['a', 'a2', 'gone'], [])
    expect(d.inPlace.map((c) => c.id)).toEqual(['a', 'a2'])
    expect(d.added.map((c) => c.id)).toEqual(['new'])
    expect(d.removedIds).toEqual(['gone'])
    expect(d.preservedIds).toEqual([])
    expect(d.summary).toBe('改 2 / 加 1 / 删 1')
  })

  it('无变化', () => {
    const d = diffSelectedControls([], ['x'], [])
    expect(d.summary).toBe('删 1')
    const d2 = diffSelectedControls([], [], [])
    expect(d2.summary).toBe('无变化')
  })

  // ⚠️ 回归：归一化丢掉的控件曾经被当成「用户要删」→ removeControl 真删掉用户的控件
  it('归一化丢掉的 id 不算删除：进 preservedIds，不进 removedIds', () => {
    // 模型返回了 a（原位改），没返回 c —— 但 c 是「我们看不懂丢掉的」
    const d = diffSelectedControls([ctrl('a')], ['a', 'c'], [drop('c')])
    expect(d.inPlace.map((c) => c.id)).toEqual(['a'])
    expect(d.removedIds).toEqual([])
    expect(d.preservedIds).toEqual(['c'])
    expect(d.summary).toBe('改 1 / 保 1')
  })

  it('真被模型删掉的仍然要删（丢弃名单不能变成免死金牌）', () => {
    const d = diffSelectedControls([ctrl('a')], ['a', 'gone'], [])
    expect(d.unattributedDrops).toBe(0)
    expect(d.removedIds).toEqual(['gone'])
    expect(d.preservedIds).toEqual([])
  })

  it('丢弃名单里的 id 不在选区时，不污染 preservedIds', () => {
    const d = diffSelectedControls([ctrl('a')], ['a'], [drop('not-selected')])
    expect(d.preservedIds).toEqual([])
    expect(d.removedIds).toEqual([])
  })

  // ⚠️ 回归：丢掉但没带 id 时，连「是哪一个」都不知道 → 不能猜着删
  it('丢弃但认不出 id（模型没给）：一律不删 —— 保守优先于猜', () => {
    const d = diffSelectedControls([ctrl('a')], ['a', 'gone'], [drop()])
    expect(d.unattributedDrops).toBe(1)
    expect(d.removedIds).toEqual([]) // 宁可少删（看得见），不多删（看不见）
    expect(d.preservedIds).toEqual([])
  })
})

describe('droppedIds / droppedNotice（丢弃上报的共享文案，两端同源）', () => {
  const d = (o: Partial<DroppedLike>): DroppedLike =>
    ({ kind: 'control', type: 'chart', ...o }) as DroppedLike

  it('droppedIds 只取真的有 id 的', () => {
    expect(droppedIds([d({ id: 'c1' }), d({ id: 'c2' }), d({})])).toEqual(['c1', 'c2'])
  })

  it('droppedNotice 去重类型并报数量', () => {
    expect(droppedNotice([d({ id: 'c1' }), d({ id: 'c2' }), d({ type: 'math' })])).toBe(
      '有 3 个控件 AI 处理不了（类型：chart / math），已跳过。',
    )
  })

  it('空数组返回空串（不显示任何东西）', () => {
    expect(droppedNotice([])).toBe('')
  })
})

describe('resolveMode（模式回退）', () => {
  it('selected 且无选区 → create；其余透传', () => {
    expect(resolveMode('selected', false)).toBe('create')
    expect(resolveMode('selected', true)).toBe('selected')
    expect(resolveMode('modify', false)).toBe('modify')
    expect(resolveMode('create', false)).toBe('create')
  })
})

describe('templateMeta（信息卡摘要）', () => {
  it('页尺寸 × 控件数', () => {
    const tpl = {
      document: {
        page: { width: 100, height: 150, unit: 'mm' },
        sections: [{ components: [1, 2] }, { components: [3] }, {}],
      },
    } as unknown as Parameters<typeof templateMeta>[0]
    expect(templateMeta(tpl)).toBe('100×150 mm · 3 个控件')
    expect(templateMeta(undefined)).toBe('')
  })
})
