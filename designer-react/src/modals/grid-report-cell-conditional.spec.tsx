/**
 * 条件格式面板的 UI 层用例：`CellModelEditor` → `model.conditional`。
 *
 * 断言一律看 `onChange` 收到的 **model**，不断言「没报错」——
 * 本文件关心的恰恰是「UI 动了但 model 没变」这类静默失效。
 *
 * 几条容易静默的点，各自钉住：
 * 1. **顺序是语义**（服务端是「自上而下，第一条命中的生效」）—— 上下移动必须真的
 *    改数组顺序，否则界面上看着挪了、导出结果没变；
 * 2. 规则删光时 `conditional` 要**整个摘掉**，不留 `[]`（留着在 JSON 里看着像配了）；
 * 3. 新规则必须带一份能立刻看见的默认样式 —— 配一条「命中了但没样式」的规则
 *    服务端会告警，而且会把后面命中的规则挡住；
 * 4. `value2` 只在 between / not_between 时出现（别的写法多一个框会让人以为在按区间比）；
 * 5. 填的内容落到 `conditional[0]`，**不是**顺手把 cell.value / model.style 改了
 *    （那三个是三个不同的东西）；
 * 6. 设计期判据（`conditionalProblem`）要与 Rust `compile_conditionals` 同口径 ——
 *    那部分是纯函数，直接在下面单测，不绕 UI。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CellModelEditor } from './GridReportModal'
import {
  CONDITION_OPS,
  CONDITION_OP_LABEL,
  conditionalProblem,
  normaliseConditionOp,
  conditionOpNeedsSecond,
  type CellConditional,
  type CellTpl,
} from '@/report/grid-report'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let host: HTMLElement
let root: Root
let latest: CellTpl | null = null
let current: CellTpl = { value: '华东' }

function render(): Promise<void> {
  return act(async () => {
    root.render(
      createElement(CellModelEditor, {
        pos: 'B3',
        cell: current,
        columns: ['region', 'amount'],
        merge: null,
        mergeError: '',
        onMerge: () => {},
        onUnmerge: () => {},
        onChange: (next: CellTpl) => {
          latest = next
        },
      }),
    )
  })
}

/** 把 onChange 的结果喂回组件，模拟真实父组件（组件是受控的） */
async function sync(): Promise<void> {
  if (latest) current = latest
  await render()
}

async function mount(cell: CellTpl): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  latest = null
  current = cell
  await render()
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function byTestid(testid: string): HTMLElement {
  const el = host.querySelector(`[data-testid="${testid}"]`)
  if (!el) throw new Error(`找不到 ${testid}`)
  return el as HTMLElement
}

function hasTestid(testid: string): boolean {
  return !!host.querySelector(`[data-testid="${testid}"]`)
}

/** 用原生 setter 触发，绕过 React 的 valueTracker（受控输入必须这么改） */
async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sync()
}

async function typeIntoTestid(testid: string, value: string): Promise<void> {
  const el = byTestid(testid)
  const input = el.matches('input') ? el : el.querySelector('input')
  if (!input) throw new Error(`${testid} 里没有 input`)
  await typeInto(input as HTMLInputElement, value)
}

/**
 * antd Select：触发器是 `.ant-select-content`（v6），
 * 而且**上一个下拉不会从 DOM 摘掉**（只加 `-hidden` 类），
 * 只能在「最后一个还开着的」里找选项。
 */
async function pickOption(testid: string, label: string): Promise<void> {
  const wrap = byTestid(testid)
  const trigger = wrap.querySelector<HTMLElement>('.ant-select-content') ?? wrap
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await flush()
  const open = [...document.querySelectorAll<HTMLElement>('.ant-select-dropdown')].filter(
    (d) => !d.classList.contains('ant-select-dropdown-hidden'),
  )
  const dd = open[open.length - 1]
  if (!dd) throw new Error(`Select ${testid} 的下拉没打开`)
  const opts = [...dd.querySelectorAll<HTMLElement>('.ant-select-item-option')]
  const opt = opts.find((o) => o.textContent?.trim() === label)
  if (!opt) {
    throw new Error(
      `Select ${testid} 里没有「${label}」，只有 ${JSON.stringify(opts.map((o) => o.textContent))}`,
    )
  }
  await act(async () => {
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
  await sync()
}

async function clickTestid(testid: string): Promise<void> {
  await act(async () => {
    byTestid(testid).click()
  })
  await flush()
  await sync()
}

async function toggleSwitch(testid: string): Promise<void> {
  await clickTestid(testid)
}

function rulesOf(): CellConditional[] {
  return latest?.model?.conditional ?? []
}

function text(): string {
  return host.textContent ?? ''
}

/** 两条规则的现成夹具（第一条红、第二条黄） */
function twoRules(): CellConditional[] {
  return [
    { when: 'gt', value: 1000, style: { color: '#FF0000' } },
    { when: 'gt', value: 100, style: { color: '#FFFF00' } },
  ]
}

beforeEach(() => {
  latest = null
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
})

describe('条件格式面板', () => {
  it('没配规则时不渲染任何规则行，只有「加规则」入口', async () => {
    await mount({ value: '华东' })
    expect(hasTestid('free-cell-cond-add')).toBe(true)
    expect(hasTestid('free-cell-cond-when-0')).toBe(false)
    expect(hasTestid('free-cell-cond-problem')).toBe(false)
  })

  it('点「加规则」写进 model.conditional，且带一份能立刻生效的默认样式', async () => {
    await mount({ value: '华东' })
    await clickTestid('free-cell-cond-add')
    const rs = rulesOf()
    expect(rs).toHaveLength(1)
    expect(rs[0]?.when).toBe('gt')
    expect(rs[0]?.value).toBe(1000)
    // 配一条「命中了但没样式」的规则是纯坑：服务端会告警，还会把后面的规则挡住
    expect(
      rs[0]?.style?.color,
      `新规则必须有样式，实际 ${JSON.stringify(rs[0])}`,
    ).toBe('#FF0000')
  })

  it('改比较方式写进 conditional[0].when，且不动格子文本', async () => {
    await mount({ value: '华东', model: { conditional: [{ when: 'gt', value: 1, style: { color: '#FF0000' } }] } })
    await pickOption('free-cell-cond-when-0', '小于等于')
    expect(rulesOf()[0]?.when).toBe('le')
    expect(latest?.value, '改条件格式不该顺手改格子文本').toBe('华东')
  })

  it('填比较值落到 conditional[0].value', async () => {
    await mount({ value: '华东', model: { conditional: [{ when: 'gt', value: 1, style: { color: '#FF0000' } }] } })
    await typeIntoTestid('free-cell-cond-value-0', '500')
    expect(rulesOf()[0]?.value).toBe(500)
  })

  it('填字色 / 底色落到 conditional[0].style，不污染 model.style', async () => {
    await mount({
      value: '华东',
      model: { style: { bold: true }, conditional: [{ when: 'gt', value: 1, style: {} }] },
    })
    await typeIntoTestid('free-cell-cond-color-0', '#FF0000')
    await typeIntoTestid('free-cell-cond-bg-0', '#FFF1B8')
    expect(rulesOf()[0]?.style?.color).toBe('#FF0000')
    expect(rulesOf()[0]?.style?.bg).toBe('#FFF1B8')
    expect(latest?.model?.style, '作者样式不该被条件格式的输入框改掉').toEqual({ bold: true })
  })

  it('加粗开关落到 conditional[0].style.bold（关掉时不留 true）', async () => {
    await mount({
      value: '华东',
      model: { conditional: [{ when: 'gt', value: 1, style: { color: '#FF0000' } }] },
    })
    await toggleSwitch('free-cell-cond-bold-0')
    expect(rulesOf()[0]?.style?.bold).toBe(true)
    await toggleSwitch('free-cell-cond-bold-0')
    expect(rulesOf()[0]?.style?.bold).toBeUndefined()
    // 关掉加粗不该顺手把字色清掉
    expect(rulesOf()[0]?.style?.color).toBe('#FF0000')
  })

  /**
   * **顺序是语义**：服务端是「自上而下，第一条命中的生效」。
   * 移动按钮只改界面不动数组的话，「大于1000标红」永远赢不了排在它前面的规则，
   * 而界面上看着已经调过顺序了。
   */
  it('上移 / 下移真的改数组顺序（第一条命中的生效）', async () => {
    await mount({ value: '华东', model: { conditional: twoRules() } })
    await clickTestid('free-cell-cond-down-0')
    expect(
      rulesOf().map((r) => r.value),
      '下移第一条之后顺序应当是 [100, 1000]',
    ).toEqual([100, 1000])
    await clickTestid('free-cell-cond-up-1')
    expect(rulesOf().map((r) => r.value)).toEqual([1000, 100])
  })

  it('首条的 ↑ 与末条的 ↓ 是禁用的（越界不该静默乱序）', async () => {
    await mount({ value: '华东', model: { conditional: twoRules() } })
    expect((byTestid('free-cell-cond-up-0') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestid('free-cell-cond-down-1') as HTMLButtonElement).disabled).toBe(true)
    await clickTestid('free-cell-cond-up-0')
    // 点了禁用的按钮不该有任何 onChange —— 所以这里读**挂载时那份 cell**
    //（`latest` 会一直是 null，读它就分不出「没变化」和「组件没接上」）
    expect(
      current.model?.conditional?.map((r) => r.value),
      '点了禁用的按钮顺序不该变',
    ).toEqual([1000, 100])
    expect(latest, '越界点击不该触发 onChange').toBeNull()
  })

  it('删掉一条后剩下那条的序号与 testid 跟着重排', async () => {
    await mount({ value: '华东', model: { conditional: twoRules() } })
    await clickTestid('free-cell-cond-del-0')
    expect(rulesOf().map((r) => r.value)).toEqual([100])
    expect(hasTestid('free-cell-cond-when-0')).toBe(true)
    expect(hasTestid('free-cell-cond-when-1'), '删完只该剩一行').toBe(false)
  })

  it('规则删光时 conditional 字段被整个摘掉（不留空数组）', async () => {
    await mount({ value: '华东', model: { conditional: twoRules() } })
    await clickTestid('free-cell-cond-del-0')
    await clickTestid('free-cell-cond-del-0')
    expect(
      latest?.model?.conditional,
      `不该留空数组: ${JSON.stringify(latest?.model)}`,
    ).toBeUndefined()
  })

  it('value2 只在 between / not_between 时出现', async () => {
    await mount({ value: '华东', model: { conditional: [{ when: 'gt', value: 1, style: { color: '#FF0000' } }] } })
    expect(hasTestid('free-cell-cond-value2-0')).toBe(false)
    await pickOption('free-cell-cond-when-0', '介于')
    expect(rulesOf()[0]?.when).toBe('between')
    expect(hasTestid('free-cell-cond-value2-0'), '介于需要上界输入框').toBe(true)
    await typeIntoTestid('free-cell-cond-value2-0', '200')
    expect(rulesOf()[0]?.value2).toBe(200)
    // 切回单值比较方式：上界框要消失（留着会让人以为还在按区间比）
    await pickOption('free-cell-cond-when-0', '大于')
    expect(hasTestid('free-cell-cond-value2-0')).toBe(false)
  })

  it('不合法时显示提示（设计期就说，别等服务端告警）', async () => {
    // 没有样式 → 命中也不会改变外观，而且会挡住后面的规则
    await mount({ value: '华东', model: { conditional: [{ when: 'gt', value: 1, style: {} }] } })
    expect(text()).toContain('没有样式')
    // 认不出来的比较方式
    await mount({ value: '华东', model: { conditional: [{ when: 'bigger', value: 1, style: { color: '#FF0000' } }] } })
    expect(text()).toContain('bigger')
    // 合法时不该有提示
    await mount({ value: '华东', model: { conditional: twoRules() } })
    expect(hasTestid('free-cell-cond-problem')).toBe(false)
  })

  it('面板里说清「非数值不命中」（否则作者以为规则没生效）', async () => {
    await mount({ value: '华东', model: { conditional: twoRules() } })
    expect(text()).toContain('一条规则都不命中')
  })
})

/**
 * 设计期判据是**纯函数**，直接单测 —— 不必绕 UI。
 *
 * 判据必须与 Rust `engine::compile_conditionals` 同口径：
 * 这里更宽 → 设计器放行、导出时才告警；更严 → 服务端明明能跑的被拦下。
 */
describe('conditionalProblem（与 Rust compile_conditionals 同口径）', () => {
  it('没配 / 空数组都算没问题', () => {
    expect(conditionalProblem(null)).toBeNull()
    expect(conditionalProblem(undefined)).toBeNull()
    expect(conditionalProblem([])).toBeNull()
  })

  it('合法的规则返回 null', () => {
    expect(conditionalProblem(twoRules())).toBeNull()
    expect(
      conditionalProblem([{ when: 'between', value: 100, value2: 200, style: { bg: '#FFF1B8' } }]),
    ).toBeNull()
  })

  it('认不出比较方式要点名原值并列出支持清单', () => {
    const msg = conditionalProblem([{ when: 'bigger', value: 1, style: { color: '#FF0000' } }])
    expect(msg).toContain('bigger')
    for (const op of CONDITION_OPS) expect(msg).toContain(op)
  })

  it('缺 value / between 缺 value2 各自点名', () => {
    expect(conditionalProblem([{ when: 'gt', style: { color: '#FF0000' } }])).toContain('value')
    const m = conditionalProblem([{ when: 'between', value: 1, style: { color: '#FF0000' } }])
    expect(m).toContain('value2')
  })

  it('value2 用在单值比较方式上要提示（服务端会忽略它）', () => {
    const m = conditionalProblem([{ when: 'gt', value: 1, value2: 9, style: { color: '#FF0000' } }])
    expect(m).toContain('value2')
    expect(m).toContain('忽略')
  })

  it('空样式要提示，并说清它会挡住后面的规则', () => {
    const m = conditionalProblem([{ when: 'gt', value: 1, style: {} }])
    expect(m).toContain('没有样式')
    expect(m).toContain('挡住')
  })

  it('提示带规则序号，且只报第一条（对得上界面那一行）', () => {
    const m = conditionalProblem([
      { when: 'gt', value: 1, style: { color: '#FF0000' } },
      { when: 'nope', value: 1, style: { color: '#FF0000' } },
    ])
    expect(m).toContain('第 2 条')
  })

  it('符号写法认得出（手写 JSON 的作者十有八九写符号）', () => {
    expect(normaliseConditionOp(' > ')).toBe('gt')
    expect(normaliseConditionOp('>=')).toBe('ge')
    expect(normaliseConditionOp('<>')).toBe('ne')
    expect(normaliseConditionOp('BETWEEN')).toBe('between')
    expect(normaliseConditionOp('nope')).toBeNull()
    expect(conditionalProblem([{ when: '>=', value: 1, style: { color: '#FF0000' } }])).toBeNull()
  })

  it('下拉名单与 needs_second 判据', () => {
    // 下拉项 == 规范名清单（引擎加了新方式这里会编译不过，而不是静默少一项）
    expect(CONDITION_OPS).toHaveLength(8)
    for (const op of CONDITION_OPS) expect(CONDITION_OP_LABEL[op]).toBeTruthy()
    expect(conditionOpNeedsSecond('between')).toBe(true)
    expect(conditionOpNeedsSecond('not_between')).toBe(true)
    expect(conditionOpNeedsSecond('gt')).toBe(false)
  })
})
