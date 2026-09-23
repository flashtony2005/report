/**
 * `GridReportModal` 的 UI 层用例：**数据来源切换（数据库 / 文件·接口）→ 请求体**。
 *
 * ## 为什么必须挂真弹窗来测
 *
 * `grid-report-request.spec.ts` 测的是纯函数「给了 `dataSourceKind: 'inline'`
 * 和 `inlineRows`，请求体会不会变成 `datasets`」。它**测不到中间那段接线**：
 * 那个 Segmented 的 state 有没有真的传进 `buildRenderRequest`、
 * 有没有进 `useCallback` 的依赖数组、选文件之后行有没有落到那个 state 上。
 *
 * 这个项目已经因为「接线漏了」栽过一次：分页开关画出来了、state 也变了，
 * 但**参数没走到请求体** —— 屏幕上「界面没反应」和「请求没带参数」一模一样。
 * 所以这里**一律断言发出去的 body**，不断言「没报错」。
 *
 * ## 第二条主线：失败**不能退化成空表**
 *
 * 取数失败（跨域被挡 / 文件格式不对）如果只是「没有数据」，
 * 那它和「接口真的返回了 0 行」在界面上长得一模一样。所以这里专门断言
 * **错误文案出现在界面上**，而且**不会**发出一个带空 `datasets` 的请求。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Univer 是被测对象之外的东西：本文件只关心「发出去的请求体」，画布长什么样无所谓。 */
const univerMock = vi.hoisted(() => ({ created: 0 }))
vi.mock('../report/univerFormulaFree', () => ({
  createFormulaFreeUniver: () => {
    univerMock.created += 1
    return {
      univerAPI: {
        createWorkbook: () => ({}),
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
  body: Record<string, unknown>
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

function textResponse(body: string, contentType: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: '',
    headers: new Headers({ 'content-type': contentType }),
    text: async () => body,
    blob: async () => new Blob([body]),
  } as unknown as Response
}

const RENDER_OK = {
  sheets: [{ name: 'Sheet1', rows: [{ cells: [{ value: 'city' }] }] }],
  pages: [],
  html: '<table></table>',
}

/** 假接口：正常返回 CSV / 跨域直接抛（浏览器在 CORS 被挡时就是这个样子） */
const DATA_URL = 'http://data.example/sales.csv'
const BLOCKED_URL = 'http://blocked.example/sales.csv'

function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (init?.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
  }
  if (url.startsWith(DATA_URL)) return Promise.resolve(textResponse(CSV_TEXT, 'text/csv'))
  if (url.startsWith(BLOCKED_URL)) return Promise.reject(new TypeError('Failed to fetch'))
  if (url.includes('/api/report/render')) return Promise.resolve(jsonResponse(RENDER_OK))
  if (url.includes('/api/reports')) return Promise.resolve(jsonResponse([]))
  return Promise.resolve(jsonResponse(RENDER_OK))
}

const CSV_TEXT = 'city,amount\n上海,1234.5\n北京,100\n'

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

/** 等到第 n 个 POST 出现（预览有 400ms 去抖，超时给宽一点） */
async function awaitPost(n: number): Promise<CapturedPost> {
  const deadline = Date.now() + 8000
  while (posts.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`等第 ${n} 个 POST 超时（目前 ${posts.length} 个）`)
    }
    await flush(30)
  }
  return posts[n - 1]!
}

/* ------------------------------- 交互帮手 ------------------------------- */

/**
 * 按文字点击。
 *
 * ⚠️ 必须**去掉所有空白再比**：antd 的 `Button` 对**两个汉字**会自动插一个空格
 * （`保存` → 渲染成 `保 存`，`取数` → `取 数`），严格相等匹配永远找不到它们。
 * 这条是实测出来的 —— 一开始只比 `trim()`，四个用 Button 的用例全报「找不到元素」。
 */
const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '')

function clickByText(text: string): void {
  const want = squash(text)
  const el = [...document.querySelectorAll<HTMLElement>('*')].find(
    (e) => e.children.length === 0 && squash(e.textContent) === want,
  )
  if (!el) throw new Error(`找不到文字为「${text}」的元素`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** 点 antd Segmented 的某一项（它是 radio，得点 input 才触发 onChange） */
async function pickSegmented(testid: string, label: string): Promise<void> {
  const wrap = await waitFor(
    () => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`),
    `Segmented ${testid}`,
  )
  const items = [...wrap.querySelectorAll<HTMLElement>('.ant-segmented-item')]
  const item = items.find((it) => it.textContent?.trim() === label)
  if (!item) {
    throw new Error(
      `Segmented ${testid} 里没有「${label}」，只有 ${JSON.stringify(items.map((x) => x.textContent?.trim()))}`,
    )
  }
  const radio = item.querySelector<HTMLInputElement>('input')
  await act(async () => {
    ;(radio ?? item).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

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
  // ⚠️ 上一个下拉不会从 DOM 里摘掉，只是加了 `-hidden` —— 必须只在最后一个还开着的里找
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

/** 把文件塞进隐藏的 `<input type="file">`（jsdom 里 `files` 是只读的，得 defineProperty） */
async function pickFile(file: File): Promise<void> {
  const input = await waitFor(
    () => document.querySelector<HTMLInputElement>('[data-testid="grid-report-inline-file"]'),
    '内联文件输入框',
  )
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

/** 填地址并点「取数」 */
async function fetchUrl(url: string): Promise<void> {
  const input = await waitFor(
    () => document.querySelector<HTMLInputElement>('[data-testid="grid-report-inline-url"]'),
    '接口地址输入框',
  )
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(input, url)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  clickByText('取数')
  await flush(150)
}

function textOf(testid: string): string | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.textContent ?? null
}

/** 把表单填到「能发出请求」：分组字段 + 数值字段（沿用分页那份用例的做法） */
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

/** 切到文件·接口，并（可选）喂一份 CSV */
async function useInlineWith(csv: string | null): Promise<void> {
  await pickSegmented('grid-report-data-source', '文件 · 接口')
  if (csv !== null) await pickFile(new File([csv], 'sales.csv', { type: 'text/csv' }))
}

/* --------------------------------- 用例 --------------------------------- */

describe('GridReportModal：数据来源切换必须真的进请求体', () => {
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

  it('默认走数据库：发 `sources`，**不带** `datasets`', async () => {
    await mount()
    await fillGroupForm()
    const body = (await awaitPost(1)).body
    expect(Array.isArray(body.sources)).toBe(true)
    expect('datasets' in body).toBe(false)
  })

  it('切到「文件 · 接口」但没选数据 → **不发请求**（不渲染空表）', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    await pickSegmented('grid-report-data-source', '文件 · 接口')
    await flush(500) // 比去抖 400ms 长，确认它**没有**发第二个请求
    expect(posts.length).toBe(1)
    // 界面要给出下一步怎么办，而不是一片空白
    expect(document.body.textContent).toContain('CSV')
  })

  it('选了 CSV → 发 `datasets`，**不带** `sources`；并显示行数 / 列名', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    await useInlineWith(CSV_TEXT)
    const body = (await awaitPost(2)).body

    expect('sources' in body).toBe(false)
    const ds = body.datasets as Record<string, Array<Record<string, unknown>>>
    // 键必须是模板里绑的那个数据集名 —— 写错的话模板取不到数据、渲染出空表
    expect(Object.keys(ds)).toEqual(['ds1'])
    // 数值列要真的是数字（字符串数字会「合计对、导出错」）
    expect(ds.ds1).toEqual([
      { city: '上海', amount: 1234.5 },
      { city: '北京', amount: 100 },
    ])

    const summary = textOf('grid-report-inline-summary')
    expect(summary).toContain('2')
    expect(summary).toContain('city')
  })

  it('⚠️ 文件解析失败 → 显示可读错误，且**不发出**带 datasets 的请求', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    // 表头 2 列、数据 3 格 —— 列数不一致，解析器应当报错而不是静默截断
    await useInlineWith('city,amount\n上海,1,多余\n')
    await flush(500)

    expect(textOf('grid-report-inline-error')).toContain('列数不一致')
    // 数据没设上 → 不该有第二个渲染请求
    expect(posts.length).toBe(1)
  })

  it('接口取数成功 → 同样发 `datasets`', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    await pickSegmented('grid-report-data-source', '文件 · 接口')
    await fetchUrl(DATA_URL)

    const body = (await awaitPost(2)).body
    expect('sources' in body).toBe(false)
    expect(body.datasets).toEqual({ ds1: [{ city: '上海', amount: 1234.5 }, { city: '北京', amount: 100 }] })
  })

  it('⚠️ 接口跨域被挡 → 可读错误（含 CORS 与文件导入），**不退化成空表**', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    await pickSegmented('grid-report-data-source', '文件 · 接口')
    await fetchUrl(BLOCKED_URL)
    await flush(300)

    const err = textOf('grid-report-inline-error')
    expect(err).toContain('Failed to fetch')
    expect(err).toContain('CORS')
    expect(err).toContain('文件导入')
    expect(posts.length).toBe(1)
  })

  it('切回「数据库」→ 清掉内联数据，请求体回到 `sources`', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    await useInlineWith(CSV_TEXT)
    expect('sources' in (await awaitPost(2)).body).toBe(false)

    await pickSegmented('grid-report-data-source', '数据库')
    const body = (await awaitPost(3)).body
    expect(Array.isArray(body.sources)).toBe(true)
    expect('datasets' in body).toBe(false)
    // 内联那侧的展示要收掉
    expect(textOf('grid-report-inline-summary')).toBeNull()
  })

  it('⚠️ 存盘要提示「内联数据不会被保存」（否则是静默丢数据）', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)
    await useInlineWith(CSV_TEXT)
    await awaitPost(2)

    // 填 id 才能存
    const idInput = await waitFor(
      () => document.querySelector<HTMLInputElement>('[data-testid="report-file-id"]'),
      '报表 id 输入框',
    )
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      set.call(idInput, 'inline-demo')
      idInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    clickByText('保存')
    await flush(300)

    const notice = textOf('report-file-save-notice')
    expect(notice).toContain('不会被保存')
    expect(notice).toContain('数据库')
  })

  it('数据库模式下存盘**不**提示（提示只针对内联那条）', async () => {
    await mount()
    await fillGroupForm()
    await awaitPost(1)

    const idInput = await waitFor(
      () => document.querySelector<HTMLInputElement>('[data-testid="report-file-id"]'),
      '报表 id 输入框',
    )
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      set.call(idInput, 'db-demo')
      idInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    clickByText('保存')
    await flush(300)

    expect(textOf('report-file-save-notice')).toBeNull()
  })
})
