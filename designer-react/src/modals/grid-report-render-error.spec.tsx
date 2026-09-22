/**
 * 渲染 / 导出失败时，**服务端的原始错误文案必须活着到达界面**。
 *
 * 服务端的错误体是**纯文本**（axum 的 `(StatusCode, String)` 直接吐字符串），不是 JSON。
 * 而 `GridReportModal` 里那段是 `res.text()` → `JSON.parse` 失败 → `payload` 留在 `{}`，
 * 于是 `payload.message` 是 `undefined` —— 这时若不回落到原始文本，作者只会看到
 * 一句「服务端返回 400」，真正有用的
 * 「格子 C2 的 style.color「red」不是 #RRGGBB」被丢掉了。
 *
 * 这条路径在 #74 之前**很难撞到**（那时预览对坏样式不校验、照样 200，
 * 错误只在导出时以 500 出现）；#74 之后预览也会报 400，于是它成了作者最常撞的一条。
 * 服务端「报错要点名哪一格」白做了 —— 除非客户端把那句话显示出来。
 *
 * 断言一律看**界面上有没有那句话**，不断言「有没有报错」：
 * 「弹了提示但内容是空的」和「弹了提示且内容对」在 `toThrow` 面前长得一模一样。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Univer 是被测对象之外的东西：真拉起来会拖进整套 canvas / worker，jsdom 里又慢又不稳 */
const univerMock = vi.hoisted(() => ({ created: 0 }))
vi.mock('../report/univerFormulaFree', () => ({
  createFormulaFreeUniver: () => {
    univerMock.created += 1
    return {
      univerAPI: { createWorkbook: () => ({}), dispose: () => {} },
    }
  },
}))

import GridReportModal from './GridReportModal'
import { useDataSourceStore } from '../stores/dataSource'

/* ------------------------------- 假服务端 ------------------------------- */

/** 服务端真实的错误体长这样：**纯文本**，点名到格 */
const DETAIL = '格子 C2 的 style.color「red」不是 #RRGGBB'

let posts: string[] = []

/** 400 + 纯文本错误体。`ok: false` 是关键 —— 客户端就是靠它走进错误分支的 */
function textError(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => body,
    json: async () => {
      throw new SyntaxError(`Unexpected token 格 in JSON at position 0`)
    },
    blob: async () => new Blob(),
  } as unknown as Response
}

function jsonOk(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob(),
  } as unknown as Response
}

function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (init?.method === 'POST') posts.push(url)
  if (url.includes('/api/report/render') || url.includes('/api/report/xlsx')) {
    return Promise.resolve(textError(400, DETAIL))
  }
  if (url.includes('/api/reports')) return Promise.resolve(jsonOk([]))
  return Promise.resolve(jsonOk({ sheets: [], pages: [], html: '' }))
}

/* --------------------------------- 挂载 --------------------------------- */

let host: HTMLElement
let root: Root

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

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(GridReportModal, { open: true, onClose: () => {} }))
  })
}

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
 * **必须只在「最后一个还开着的」下拉里找**：上一个下拉不会从 DOM 摘掉，只是加了
 * `-hidden` 类，在 `document` 里搜会点到上一个 Select 的选项去（这条踩过）。
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

/** 界面上所有可见文字 */
function pageText(): string {
  return document.body.textContent ?? ''
}

async function waitForText(needle: string): Promise<void> {
  await waitFor(() => (pageText().includes(needle) ? true : null), `界面上出现「${needle}」`)
}

/* --------------------------------- 用例 --------------------------------- */

describe('GridReportModal：服务端错误文案不能被吞掉', () => {
  beforeEach(() => {
    posts = []
    univerMock.created = 0
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

  it('预览报 400（纯文本错误体）→ 界面显示的是服务端那句话，不是「服务端返回 400」', async () => {
    await mount()
    await fillGroupForm()
    await waitForText(DETAIL)

    expect(pageText(), '服务端的点名文案必须原样显示出来').toContain(DETAIL)
    expect(
      pageText(),
      '只剩「服务端返回 400」= 客户端把 body 丢了（这就是本条要防的回归）',
    ).not.toContain('服务端返回 400')
  })

  it('导出报 400 → 同样带上服务端那句话', async () => {
    await mount()
    await fillGroupForm()
    await waitForText(DETAIL)

    const btn = await waitFor(
      () => document.querySelector<HTMLElement>('[data-testid="grid-report-export"]'),
      '导出按钮',
    )
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitForText('导出失败：')

    expect(posts.some((u) => u.includes('/api/report/xlsx')), '应当真的请求了导出端点').toBe(true)
    expect(pageText(), '导出失败的提示里也要有点名到格的那句话').toContain(DETAIL)
  })
})
