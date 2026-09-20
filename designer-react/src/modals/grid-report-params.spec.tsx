/**
 * 报表参数（查询表单）的 UI 层用例：`GridReportModal` 点「执行」→ 弹表单 → 请求体。
 *
 * 为什么必须挂在整弹窗上测：这一条链有三段接线，纯函数一段都测不到 ——
 * 1. `runReport` 里那句 `if (def.params?.length)` —— 少一个 `?.` 就是「参数没声明也弹表单」
 *    或者「声明了却直接跑」；
 * 2. 表单里的受控输入 → `paramDraft`（字段名拼错就静默丢一个参数）；
 * 3. `confirmParams` → `executeRun(id, paramDraft)` —— 传 `{}` 进去的话
 *    服务端会全部走默认值，界面看着「执行成功」，条件却一个都没生效。
 *
 * 所以这里的用例**一律断言请求体**（或断言「这一刻还没有请求」），不断言「没报错」。
 * 每条都做过故障注入：把对应那段拆掉，用例必须变红。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Univer 是被测对象之外的东西：本文件只看发出去的请求体（同 grid-report-paging.spec.tsx） */
vi.mock('../report/univerFormulaFree', () => ({
  createFormulaFreeUniver: () => ({
    univerAPI: {
      createWorkbook: () => ({}),
      dispose: () => {},
    },
  }),
}))

import GridReportModal from './GridReportModal'
import type { ReportDef, ReportParam } from '@/report/grid-report'

/* ------------------------------- 假服务端 ------------------------------- */

interface CapturedRun {
  url: string
  values: Record<string, unknown>
}

let runs: CapturedRun[] = []
/** 当前这份「已保存的报表」；每个用例自己换 */
let currentDef: ReportDef

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob(),
  } as unknown as Response
}

/** 够用的渲染结果：只要 `sheets` 非空就不会走进错误分支 */
const RENDER_OK = {
  sheets: [{ name: 'Sheet1', rows: [{ cells: [{ value: 'city' }] }] }],
  pages: [],
  html: '<table></table>',
}

function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  if (method === 'POST' && url.includes('/run')) {
    runs.push({
      url,
      values: (JSON.parse(String(init?.body)) as { values: Record<string, unknown> }).values,
    })
    return Promise.resolve(jsonResponse(RENDER_OK))
  }
  if (url.endsWith('/api/reports')) return Promise.resolve(jsonResponse([]))
  if (/\/api\/reports\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse(currentDef))
  return Promise.resolve(jsonResponse(RENDER_OK))
}

/* --------------------------------- 挂载 --------------------------------- */

let host: HTMLElement
let root: Root

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(GridReportModal, { open: true, onClose: () => {} }))
  })
}

async function flush(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

async function waitFor<T>(probe: () => T | null | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 6000
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`等「${what}」超时`)
    await flush(30)
  }
}

/* ------------------------------- 交互帮手 ------------------------------- */

function byTestid(testid: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  if (!el) throw new Error(`找不到 ${testid}`)
  return el
}

/** 用原生 setter 改受控 input（绕过 React 的 valueTracker） */
function inputOf(testid: string): HTMLInputElement {
  const wrap = byTestid(testid)
  // `data-testid` 落哪一层随组件而异（InputNumber 可能在 input 本身也可能在外层 div）
  const input =
    wrap.tagName === 'INPUT'
      ? (wrap as HTMLInputElement)
      : wrap.querySelector('input') ?? wrap.parentElement?.querySelector('input')
  if (!input) throw new Error(`${testid} 里没有 input（外层是 ${wrap.className}）`)
  return input
}

async function typeInto(testid: string, value: string): Promise<void> {
  const input = await waitFor(() => inputOf(testid), `输入框 ${testid}`)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function clickTestid(testid: string): Promise<void> {
  const el = await waitFor(() => byTestid(testid), `按钮 ${testid}`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** 点开 antd Select 并选中某一项（触发器是 v6 的 `.ant-select-content`） */
async function pickOption(testid: string, label: string): Promise<void> {
  const wrap = await waitFor(() => byTestid(testid), `Select ${testid}`)
  const trigger = wrap.querySelector<HTMLElement>('.ant-select-content') ?? wrap
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await flush()

  // 上一个下拉不会从 DOM 摘掉（只加 -hidden 类），只能在「最后一个还开着的」里找
  const open = [...document.querySelectorAll<HTMLElement>('.ant-select-dropdown')].filter(
    (d) => !d.classList.contains('ant-select-dropdown-hidden'),
  )
  const dd = open[open.length - 1]
  if (!dd) throw new Error(`Select ${testid} 的下拉没打开`)
  const opts = [...dd.querySelectorAll<HTMLElement>('.ant-select-item-option')]
  const opt = opts.find((o) => o.textContent?.trim() === label)
  if (!opt) {
    throw new Error(`Select ${testid} 里没有「${label}」，只有 ${JSON.stringify(opts.map((o) => o.textContent))}`)
  }
  await act(async () => {
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** 填报表 id 并点「执行」——真实入口就是这两个控件 */
async function clickRun(id: string): Promise<void> {
  await typeInto('report-file-id', id)
  await clickTestid('report-file-run')
  // 执行先 GET 定义（要算表头行数），再决定弹表单还是直接跑
  await flush(120)
}

/* -------------------------------- 报表定义 -------------------------------- */

function param(p: Partial<ReportParam> & { name: string }): ReportParam {
  return p
}

function defWith(params: ReportParam[]): ReportDef {
  return {
    format: 'openprint-report',
    version: 1,
    id: 'r1',
    name: '按地区查询',
    template: { sheets: [{ name: 'Sheet1', rows: [{ cells: [{ value: '地区' }] }] }] },
    sources: [{ name: 's1', connId: 'demo', database: 'demo.db', table: 'orders' }],
    params,
  }
}

/** 表单是否已经弹出来（看有没有渲染出参数控件） */
function formOpen(name = 'region'): boolean {
  return document.querySelector(`[data-testid="report-param-${name}"]`) !== null
}

/**
 * 关闭是否**已经开始**。
 *
 * 不能断言「DOM 里没有参数控件了」—— jsdom 里 rc-motion 的离场动画永远结束不了
 * （没有 transitionend），`destroyOnHidden` 也就永远不摘 DOM：点完取消之后
 * 遮罩会一直停在 `ant-fade-leave-active`。所以这里退一步看「有没有挂上离场类」，
 * 它恰好能区分「onCancel 真跑了」和「onCancel 没接上」。
 */
function closeStarted(): boolean {
  return [...document.querySelectorAll('.ant-modal-mask, .ant-modal')].some((el) =>
    /ant-(fade|zoom)-leave/.test(el.className),
  )
}

function paramError(): string {
  return document.querySelector('[data-testid="report-param-error"]')?.textContent ?? ''
}

/* --------------------------------- 用例 --------------------------------- */

describe('GridReportModal：查询表单要真的把参数送进请求体', () => {
  beforeEach(() => {
    runs = []
    currentDef = defWith([])
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('声明了参数 → 点执行先弹表单，且这一刻还没有发执行请求', async () => {
    currentDef = defWith([param({ name: 'region', label: '地区', kind: 'text' })])
    await mount()
    await clickRun('r1')

    expect(formOpen(), '表单没弹出来，说明 params 那一段没接上').toBe(true)
    expect(runs.length, '表单还没填就跑了 —— 用户看不到条件').toBe(0)
  })

  it('没声明参数 → 不弹表单，直接执行且 values 是空对象', async () => {
    currentDef = defWith([])
    await mount()
    await clickRun('r1')

    await waitFor(() => (runs.length ? runs[0] : null), '执行请求')
    expect(formOpen(), '没参数却弹了空表单').toBe(false)
    expect(runs[0]!.values).toEqual({})
  })

  it('有默认值 → 表单预填，且执行时默认值进 values', async () => {
    currentDef = defWith([param({ name: 'region', label: '地区', default: '华东' })])
    await mount()
    await clickRun('r1')

    const input = await waitFor(() => inputOf('report-param-region'), '参数输入框')
    expect(input.value, '默认值没预填').toBe('华东')

    await clickTestid('report-param-ok')
    await waitFor(() => (runs.length ? runs[0] : null), '执行请求')
    expect(runs[0]!.values).toEqual({ region: '华东' })
  })

  it('必填为空 → 前端就拦住，不发请求，并说清是哪个字段', async () => {
    currentDef = defWith([param({ name: 'region', label: '地区', required: true })])
    await mount()
    await clickRun('r1')

    await clickTestid('report-param-ok')
    await flush(120)
    expect(runs.length, '必填没填就发请求了 —— 白等一趟服务端').toBe(0)
    expect(paramError()).toContain('地区')
  })

  it('enum 参数走下拉，选中的项进 values', async () => {
    currentDef = defWith([
      param({ name: 'region', label: '地区', kind: 'enum', options: ['华东', '华南'] }),
    ])
    await mount()
    await clickRun('r1')

    await pickOption('report-param-region', '华南')
    await clickTestid('report-param-ok')
    await waitFor(() => (runs.length ? runs[0] : null), '执行请求')
    expect(runs[0]!.values).toEqual({ region: '华南' })
  })

  it('number 参数进 values 的是数字，不是字符串', async () => {
    currentDef = defWith([param({ name: 'minAmount', label: '最低金额', kind: 'number' })])
    await mount()
    await clickRun('r1')

    await typeInto('report-param-minAmount', '1000')
    await clickTestid('report-param-ok')
    await waitFor(() => (runs.length ? runs[0] : null), '执行请求')
    expect(typeof runs[0]!.values.minAmount, `传下去的是 ${typeof runs[0]!.values.minAmount}`).toBe(
      'number',
    )
    expect(runs[0]!.values.minAmount).toBe(1000)
  })

  it('取消表单 → 不发请求；再点执行仍能重新填表并执行', async () => {
    currentDef = defWith([param({ name: 'region', label: '地区', required: true })])
    await mount()
    await clickRun('r1')

    await clickTestid('report-param-cancel')
    await waitFor(() => (closeStarted() ? true : null), '表单开始关闭')
    expect(runs.length, '点了取消反而把报表跑了').toBe(0)

    // 再点一次：`paramDefs` / `pendingRunId` 都要被清干净，表单还能正常用
    await clickTestid('report-file-run')
    await flush(120)
    await typeInto('report-param-region', '西南')
    await clickTestid('report-param-ok')
    await waitFor(() => (runs.length ? runs[0] : null), '执行请求')
    expect(runs[0]!.values).toEqual({ region: '西南' })
  })
})
