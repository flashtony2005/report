/**
 * 格子样式面板的 UI 层用例：`CellModelEditor` → `model.style`。
 *
 * 为什么不在 `GridReportModal` 整弹窗上测：弹窗一挂就要拉起 Univer、发预览请求，
 * 而这里要验的只是「点了开关，style 里是不是真的多了这一项」——
 * 纯受控组件的事，隔离出来又快又稳。
 *
 * 断言一律看 `onChange` 收到的 **model**，不断言「没报错」：
 * 本文件关心的恰恰是「UI 动了但 model 没变」这类静默失效。
 *
 * 三条容易静默的点，各自钉住：
 * 1. 粗体 / 斜体开关要真的写进 style（不是只画个开关在那儿）；
 * 2. 颜色输入框要落到 `style.color` / `style.bg`，且色块跟着变；
 * 3. **清掉最后一项时整个 `style` 要被摘掉**，不能留个 `{}` ——
 *    留着会让它看着「设了样式」其实一项没设，导出时也是一路空样式。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CellModelEditor } from './GridReportModal'
import type { CellStyle, CellTpl } from '@/report/grid-report'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let host: HTMLElement
let root: Root
let latest: CellTpl | null = null

/**
 * 当前喂给组件的 cell —— 组件是**受控**的，父组件不把 `onChange` 的结果喂回去，
 * 界面就永远停在初始值（色块也就不会跟着变）。
 *
 * 这一点正是本文件要模拟的：真实父组件（GridReportModal）是把新 cell 存进
 * state 再回传的，所以这里每次交互后都要 sync 一次。
 */
let current: CellTpl = { value: '华东' }

function render(): Promise<void> {
  return act(async () => {
    root.render(
      createElement(CellModelEditor, {
        pos: 'A3',
        cell: current,
        columns: ['region', 'city'],
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

/** 把 onChange 的结果喂回组件，模拟真实父组件 */
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

async function clickSwitch(testid: string): Promise<void> {
  const el = host.querySelector(`[data-testid="${testid}"]`)
  expect(el, `找不到开关 ${testid}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await sync()
}

function byTestid(testid: string): HTMLElement {
  const el = host.querySelector(`[data-testid="${testid}"]`)
  if (!el) throw new Error(`找不到 ${testid}`)
  return el as HTMLElement
}

/** InputNumber 的 testid 可能落在 input 上、也可能在外层 div */
function inputIn(testid: string): HTMLInputElement {
  const el = byTestid(testid)
  const found = el.matches('input') ? el : el.querySelector('input')
  if (!found) throw new Error(`${testid} 里没有 input`)
  return found as HTMLInputElement
}

function styleOf(): CellStyle | undefined {
  return latest?.model?.style ?? undefined
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

describe('格子样式面板', () => {
  it('粗体开关写进 style.bold', async () => {
    await mount({ value: '华东' })
    await clickSwitch('free-cell-style-bold')
    expect(styleOf()?.bold).toBe(true)
  })

  it('斜体开关写进 style.italic', async () => {
    await mount({ value: '华东' })
    await clickSwitch('free-cell-style-italic')
    expect(styleOf()?.italic).toBe(true)
  })

  it('字号输入框写进 style.font_size', async () => {
    await mount({ value: '华东' })
    await typeInto(inputIn('free-cell-style-font-size'), '14')
    expect(styleOf()?.font_size).toBe(14)
  })

  it('字色 / 底色分别落到 style.color / style.bg，色块跟着变', async () => {
    await mount({ value: '华东' })
    await typeInto(inputIn('free-cell-style-color'), '#FF0000')
    expect(styleOf()?.color).toBe('#FF0000')
    // 色块要真的上色（认不出来的值就保持透明，别假装生效）。
    // jsdom 有时原样保留 #RRGGBB、有时转成 rgb(...)，两种都算数。
    const swatch = byTestid('free-cell-style-color-swatch').style.background
    expect(
      swatch.toUpperCase().includes('#FF0000') || swatch.includes('255, 0, 0'),
      `色块没被染成红色: ${swatch}`,
    ).toBe(true)

    await typeInto(inputIn('free-cell-style-bg'), '#FFF1B8')
    expect(styleOf()?.bg).toBe('#FFF1B8')
  })

  /// 认不出来的颜色**不该**把色块染了 —— 否则作者以为设上了
  it('非法色值不染色块（但仍按原样保存，由服务端导出时报错）', async () => {
    await mount({ value: '华东' })
    await typeInto(inputIn('free-cell-style-color'), 'red')
    // 前端不擅自丢弃，交给导出时报清楚
    expect(styleOf()?.color).toBe('red')
    const bg = byTestid('free-cell-style-color-swatch').style.background
    expect(bg === '' || bg.includes('transparent'), `色块不该被染: ${bg}`).toBe(true)
  })

  /// 这条最重要：留个 `{}` 会让它看着「设了样式」其实一项没设
  it('清掉最后一项时整个 style 被摘掉，不留空对象', async () => {
    await mount({ value: '华东', model: { style: { bold: true } } })
    await clickSwitch('free-cell-style-bold') // 关掉
    expect(latest?.model?.style, `不该留空 style: ${JSON.stringify(latest?.model)}`).toBeUndefined()
  })

  it('只清其中一项时，其余项要保留', async () => {
    await mount({ value: '华东', model: { style: { bold: true, color: '#FF0000' } } })
    await clickSwitch('free-cell-style-bold') // 关掉粗体，颜色该还在
    const st = styleOf()
    expect(st?.bold).toBeUndefined()
    expect(st?.color).toBe('#FF0000')
    expect(latest?.model?.style, '还剩一项，style 不该被摘掉').toBeTruthy()
  })

  it('动样式不该顺手动到 model 的其它字段', async () => {
    await mount({ value: '华东', model: { ds: 'ds1', field: 'region', row_test_expr: 'a>0' } })
    await clickSwitch('free-cell-style-bold')
    expect(latest?.model?.ds).toBe('ds1')
    expect(latest?.model?.field).toBe('region')
    expect(latest?.model?.row_test_expr).toBe('a>0')
  })
})
