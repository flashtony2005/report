/**
 * `GridReportModal` 的 UI 层用例：**服务端分级诊断（`issues`）→ 界面 → 导出闸**。
 *
 * ## 为什么必须挂真弹窗来测
 *
 * `openprint` 那边已经把 `RenderIssue` 的类型和 `IssueCode` 词表镜像好了，
 * 但那只能保证「字段名对得上」。它**测不到中间那段接线**：
 * `setIssues(data.issues ?? [])` 有没有真的被调用、`blockingIssues` 有没有进
 * `doExport` 的依赖数组、`error` 级到底有没有真的把按钮禁掉。
 * 本项目已经因为「接线漏了」栽过（分页开关画出来了、state 也变了，参数却没进请求体），
 * 所以这里**一律断言界面上看得见什么 + 发出去的请求体**，不断言「没报错」。
 *
 * ## 本次改动的核心主张（就是本文件要钉死的东西）
 *
 * 改之前界面**只读 `warnings`**，而 `info` 级**按定义不进 `warnings`**
 * （Rust 侧 `IssueSink::info` 只推 `issues`）→ 那类提示在界面上**根本不存在**。
 * 所以「`info` 看得见」必须有独立用例，不能靠「`error` 那条过了」推断出来 ——
 * 两者走的是同一段 JSX，但**触发条件不同**，漏掉 `setIssues` 时表现也不同。
 *
 * ## 两道闸，只有一道能从界面走到
 *
 * 导出按钮 `disabled`（第一道）和 `doExport` 开头的 `if (blockingIssues.length > 0)`
 * （第二道）**条件是同一个**，而按钮是 `doExport` 唯一的调用点
 * （`grep doExport` 只有一处 `onClick`）→ **第二道闸当前从界面走不到**。
 * 它是留给「将来多一个调用点（菜单 / 快捷键 / 批量导出）」的保险。
 * 本文件的断言写成「点了导出 → **没有** xlsx 请求 + 界面看得见原因」，
 * 这样**两道闸谁拦住的都能过**，不把测试绑死在某一道上。
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

interface CapturedPost {
  url: string
  body: Record<string, unknown>
}

let posts: CapturedPost[] = []

/**
 * 预览要回的渲染结果。**每个用例自己摆** —— 本文件测的就是「响应里有不同级别的
 * `issues` 时界面怎么变」，所以响应体必须是变量而不是常量。
 */
let renderResponse: Record<string, unknown> = {}

function jsonOk(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob([new Uint8Array([0x50, 0x4b])]),
  } as unknown as Response
}

function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (init?.method === 'POST') {
    posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
  }
  if (url.includes('/api/report/render')) return Promise.resolve(jsonOk(renderResponse))
  // 导出成功路径要能走完：`URL.createObjectURL` 在 jsdom 里不存在，见下面 stub。
  if (url.includes('/api/report/xlsx')) return Promise.resolve(jsonOk({}))
  if (url.includes('/api/reports')) return Promise.resolve(jsonOk([]))
  return Promise.resolve(jsonOk(renderResponse))
}

/** 预览结果的最小骨架：`sheets` 空着也能过（本文件不关心画布长什么样） */
function response(extra: Record<string, unknown>): Record<string, unknown> {
  return { sheets: [{ name: 'Sheet1', rows: [{ cells: [{ value: 'city' }] }] }], pages: [], html: '', ...extra }
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

/** antd 的 `Button` 对**两个汉字**会自动插一个空格（`保存` → `保 存`），所以去空白再比 */
const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '')

function clickByText(text: string): void {
  const want = squash(text)
  const el = [...document.querySelectorAll<HTMLElement>('*')].find(
    (e) => e.children.length === 0 && squash(e.textContent) === want,
  )
  if (!el) throw new Error(`找不到文字为「${text}」的元素`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

function textOf(testid: string): string | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.textContent ?? null
}

function exportButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('[data-testid="grid-report-export"]')
  if (!el) throw new Error('找不到导出按钮')
  return el
}

/** 点导出。禁用态下 React 不会派发 onClick —— 这正是「第一道闸」在起作用 */
async function clickExport(): Promise<void> {
  await act(async () => {
    exportButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush(150)
}

const xlsxPosts = (): CapturedPost[] => posts.filter((p) => p.url.includes('/api/report/xlsx'))

/** 真服务端那条 error 级诊断长这样（`layout_collision`，点名到格） */
const COLLISION = 'B3 被两个实例同时占用，整格数据已被丢弃'
const COLLISION_ISSUE = {
  level: 'error',
  code: 'layout_collision',
  sheet: 'Sheet1',
  pos: 'B3',
  message: COLLISION,
}

/* --------------------------------- 用例 --------------------------------- */

describe('GridReportModal：分级诊断必须真的到界面，并且真的拦住导出', () => {
  beforeEach(() => {
    posts = []
    univerMock.created = 0
    renderResponse = response({})
    // jsdom 不实现 createObjectURL —— 不补的话导出成功路径会在下载那一步抛，
    // 把「该发请求」那条用例淹掉（抛的是无关错误，但 posts 断言会看着像通过）。
    ;(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:fake'
    ;(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {}
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

  it('error 级 → 按钮禁用、诊断点名到格、点导出**不发出** xlsx 请求', async () => {
    // 真服务端此时 `warnings` 里也有同一条（它是 `level >= warning` 的派生视图）
    renderResponse = response({ issues: [COLLISION_ISSUE], warnings: [`[Sheet1] ${COLLISION}`] })

    await mount()
    await fillGroupForm()
    await awaitPost(1)

    const box = await waitFor(() => textOf('grid-report-issues'), '诊断 Alert')
    expect(box, 'error 级必须显示「结果不可信」，不能只显示「告警」').toContain('结果不可信')
    expect(box, '要能定位到格 —— 只说「有冲突」等于没说').toContain('B3')
    expect(box).toContain(COLLISION)
    expect(box, '要让作者知道导出已经被拦住了').toContain('已拦住导出')

    // ⚠️ 顺序是有意的：**先断言契约（一个字节都没发出去），再断言机制（按钮禁用）**。
    // 反过来写的话，一旦有人拆掉按钮的 `disabled`，用例会先红在 `disabled` 上、
    // 直接短路 —— 于是 `doExport` 里那道闸到底拦不拦得住**永远验不到**
    // （实测：注入「只拆 disabled」时红在 262 行，后面的断言根本没执行）。
    // 契约在前，两道闸谁拦住的都能过，且拆掉任意一道都会红在对应的地方。
    await clickExport()
    expect(
      xlsxPosts().length,
      '结果不可信却把 xlsx 发出去了 —— 这是本文件要防的最坏情况',
    ).toBe(0)

    expect(
      exportButton().disabled,
      'error 级 = 结果不可信，导出按钮必须是禁用的（评审那句「错误结果不能被当成成功结果」）',
    ).toBe(true)
  })

  it('⚠️ info 级 → 看得见（改之前它在界面上根本不存在），且**不禁用**导出', async () => {
    // 关键：`warnings` 是**空的** —— `info` 按定义不进 `warnings`。
    // 所以这条用例在「界面只读 warnings」的旧实现下必然红。
    const NOTE = '表达式求值花了 3 轮才收敛'
    renderResponse = response({
      issues: [{ level: 'info', code: 'fixpoint_rounds', sheet: 'Sheet1', pos: null, message: NOTE }],
      warnings: [],
    })

    await mount()
    await fillGroupForm()
    await awaitPost(1)

    const box = await waitFor(() => textOf('grid-report-issues'), '诊断 Alert')
    expect(box, 'info 级的文案是「提示」').toContain('提示')
    expect(box).toContain(NOTE)
    expect(textOf('grid-report-warnings'), '两个 Alert 不能同时出现（会重复展示同一批信息）').toBeNull()

    expect(exportButton().disabled, 'info 只是提示，不该拦住导出').toBe(false)

    await clickExport()
    expect(
      xlsxPosts().length,
      '没有 error 时导出必须真的发出去 —— 否则这道闸就成了「什么都导不了」',
    ).toBe(1)
  })

  it('warning 级 → 列出来但不拦导出（三个级别的判据互不串味）', async () => {
    renderResponse = response({
      issues: [
        { level: 'warning', code: 'join_key_not_grouped', sheet: 'Sheet1', pos: 'B1', message: '分组键没分组' },
      ],
      warnings: ['[Sheet1] 分组键没分组'],
    })

    await mount()
    await fillGroupForm()
    await awaitPost(1)

    const box = await waitFor(() => textOf('grid-report-issues'), '诊断 Alert')
    expect(box).toContain('告警')
    expect(box, 'warning 不该说「结果不可信」').not.toContain('结果不可信')
    expect(exportButton().disabled, 'warning 只是告警，不该拦住导出').toBe(false)
  })

  it('旧服务端（只有 warnings、没有 issues）→ 平铺回退，不能什么都不显示', async () => {
    // 服务端是**独立进程**，用户自己起 —— 「新界面 + 旧服务端」是真会出现的组合
    const OLD = '[Sheet1] 老版服务端的告警'
    renderResponse = response({ warnings: [OLD] })

    await mount()
    await fillGroupForm()
    await awaitPost(1)

    const box = await waitFor(() => textOf('grid-report-warnings'), '回退告警 Alert')
    expect(box).toContain(OLD)
    expect(textOf('grid-report-issues'), '没有 issues 就不该有诊断 Alert').toBeNull()
  })
})
