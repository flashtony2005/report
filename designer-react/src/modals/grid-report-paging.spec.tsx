/**
 * `GridReportModal` 的 UI 层用例：分页开关 → 请求体。
 *
 * 为什么在 `grid-report-request.spec.ts` 之外还要写这一份：
 * 那份测的是**纯函数**「传进来的 `page` 会不会套到模板上」，
 * 测不到中间那段接线 —— `paging` 这个 state 到底有没有算成 `page`、
 * `page` 有没有进 `buildRenderRequest` 的入参和 `useCallback` 的依赖数组。
 *
 * 分页开关失效那次的形态正是：UI 画出来了、state 也变了，但参数没走到请求体，
 * 「界面没反应」和「请求没带参数」在屏幕上长得一模一样。
 * 纯函数测不出来这种事，只能真的把弹窗挂起来、点一遍开关、看发出去的 body。
 *
 * 所以这里的用例**一律断言请求体**，不断言「没报错」。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Univer 在这里是**被测对象之外的东西**：本文件只关心「发出去的请求体」，
 * 画布上画成什么样无所谓。真的拉起 Univer 会拖进整套 canvas / worker，
 * 在 jsdom 里既慢又不稳。
 *
 * 但也不能简单 no-op：`paintSheet` 会调 `createWorkbook`，
 * 所以这个假实现要提供它被用到的全部表面。
 */
const univerMock = vi.hoisted(() => ({ created: 0, workbooks: [] as unknown[] }))
vi.mock('../report/univerFormulaFree', () => ({
  createFormulaFreeUniver: () => {
    univerMock.created += 1
    return {
      univerAPI: {
        createWorkbook: (data: unknown) => {
          univerMock.workbooks.push(data)
          return {}
        },
        dispose: () => {},
      },
    }
  },
}))

import GridReportModal from './GridReportModal'
import { useDataSourceStore } from '../stores/dataSource'

/* ------------------------------- 假服务端 ------------------------------- */

interface CapturedPost {
  url: string
  body: unknown
}

let posts: CapturedPost[] = []

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

/** 一份够用的渲染结果：非 sample 分支只需 `sheets` 非空就不会走进错误分支 */
const RENDER_OK = {
  sheets: [{ name: 'Sheet1', rows: [{ cells: [{ value: 'city' }] }] }],
  pages: [],
  html: '<table></table>',
}

function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (init?.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) })
  }
  if (url.includes('/api/report/render')) return Promise.resolve(jsonResponse(RENDER_OK))
  if (url.includes('/api/reports')) return Promise.resolve(jsonResponse([]))
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

/** 等到第 n 个 POST 出现（去抖 400ms，所以超时给宽一点） */
async function awaitPost(n: number): Promise<CapturedPost> {
  const deadline = Date.now() + 6000
  while (posts.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`等第 ${n} 个 POST 超时（目前 ${posts.length} 个）`)
    }
    await flush(30)
  }
  return posts[n - 1]!
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

/** 按文字点 Segmented / 按钮 */
function clickByText(text: string): void {
  const el = [...document.querySelectorAll<HTMLElement>('*')].find(
    (e) => e.children.length === 0 && e.textContent?.trim() === text,
  )
  if (!el) throw new Error(`找不到文字为「${text}」的元素`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * 点开 antd Select 并选中某一项。
 *
 * 两个坑：
 * 1. antd v6 的触发器是 `.ant-select-content`（不是 v5 的 `.ant-select-selector`）。
 * 2. **上一个下拉不会从 DOM 里摘掉**，只是加了 `-hidden` 类。所以不能在
 *    `document` 里搜选项 —— 那会点到上一个 Select 的项去。必须只在「最后一个
 *    还开着的」下拉里找。这条踩过：分组字段选完 city，再选数值字段时
 *    点中的还是分组字段的下拉，于是 `valueField` 一直为空、请求一直发不出去。
 */
async function pickOption(testid: string, label: string): Promise<void> {
  const wrap = await waitFor(
    () => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`),
    `Select ${testid}`,
  )
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
}

function pagingSwitch(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="grid-report-paging"]')!
}

async function togglePaging(): Promise<void> {
  const sw = await waitFor(() => pagingSwitch(), '分页开关')
  await act(async () => {
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** 用原生 setter 改受控 input（绕过 React 的 valueTracker） */
async function setNumber(testid: string, value: string): Promise<void> {
  const wrap = await waitFor(
    () => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`),
    `InputNumber ${testid}`,
  )
  // `data-testid` 落在哪一层取决于 antd 版本：可能就是 input 本身，也可能在外层 div
  const input =
    wrap.tagName === 'INPUT'
      ? (wrap as HTMLInputElement)
      : wrap.querySelector('input') ?? wrap.parentElement?.querySelector('input')
  if (!input) throw new Error(`${testid} 里没有 input（外层是 ${wrap.className}）`)
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

/** 取最近一次 /api/report/render 的 body，并做个最小形状校验 */
function lastRender(): {
  template: { sheets: Array<{ page?: { rows_per_page: number; repeat_header_rows: number; repeat_footer_rows: number } }> }
  [k: string]: unknown
} {
  const hit = [...posts].reverse().find((p) => p.url.includes('/api/report/render'))
  if (!hit) throw new Error('还没有发过 /api/report/render')
  return hit.body as ReturnType<typeof lastRender>
}

/** 把表单填到「能发出请求」：库 + 表 + 分组字段 + 数值字段 */
async function fillGroupForm(): Promise<void> {
  useDataSourceStore.setState({
    dbDatabases: [{ name: 'demo.db', label: 'demo.db', engine: 'sqlite' }],
    dbTables: [{ name: 'orders' }],
    dbColumns: [{ name: 'city' }, { name: 'amount' }],
    dbSelection: { database: 'demo.db', table: 'orders', engine: 'sqlite' },
  } as never)

  clickByText('分组汇总')
  await flush()
  await pickOption('grid-report-group-fields', 'city')
  await pickOption('grid-report-value-field', 'amount')
}

/* --------------------------------- 用例 --------------------------------- */

describe('GridReportModal：分页开关必须真的进请求体', () => {
  beforeEach(() => {
    posts = []
    univerMock.created = 0
    univerMock.workbooks = []
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

  it('不开分页 → 请求体里没有 page', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)
    expect(lastRender().template.sheets[0]!.page ?? null).toBeNull()
  })

  it('打开分页 → 模板的每张 sheet 上都带上 page', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    await togglePaging()
    await awaitPost(2)

    const sheets = lastRender().template.sheets
    expect(sheets.length).toBeGreaterThan(0)
    for (const s of sheets) {
      expect(s.page).toEqual({ rows_per_page: 20, repeat_header_rows: 1, repeat_footer_rows: 0 })
    }
  })

  it('改「每页数据行」→ 下一次请求体跟着变（防 page 漏进依赖数组）', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)
    await togglePaging()
    await awaitPost(2)

    await setNumber('grid-report-rows-per-page', '7')
    await awaitPost(3)

    expect(lastRender().template.sheets[0]!.page!.rows_per_page).toBe(7)
  })

  it('自由模板模式不显示分页开关 —— 它进不了存盘文件也进不了请求', async () => {
    await mount()
    await fillGroupForm()
    await waitFor(() => pagingSwitch(), '分页开关')
    clickByText('自由模板')
    await flush(200)
    expect(document.querySelector('[data-testid="grid-report-paging"]')).toBeNull()
  })
})
