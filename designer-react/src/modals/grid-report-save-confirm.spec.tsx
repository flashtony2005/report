/**
 * `GridReportModal` 的 UI 层用例：**保存到「已经存在的 id」之前必须先确认**。
 *
 * ## 为什么这是一条静默失败，而不是「体验问题」
 *
 * 服务端 `store::save` 是**覆盖写**，它自己的文档注释写着：
 *
 * > 保存。**覆盖写**：报表是用户的资产，静默覆盖同名文件会丢东西，
 * > **所以调用方（UI）要先经列表确认**
 *
 * 而在这之前**那句话是假的**：`saveReport` 直接 `PUT /api/reports/save`，
 * 一次确认都没有 —— UI 手上明明就有 `savedReports` 列表，也没拿它做任何判断。
 * 结果：手打一个已存在的 id → 点保存 → 那份报表**无声无息被换掉**，
 * 界面上只多出一句「已保存模板」。
 *
 * 这就是本项目最怕的那一类：**声明与实现漂移，而症状是「看着一切正常」**。
 * 所以本文件测的不是「弹了个框」，而是**「有没有把请求发出去」**。
 *
 * ## 为什么必须挂真弹窗
 *
 * 判据（`id !== lastSavedId && (!reportsListKnown || 列表里有)`）是**接线**：
 * `savedReports` 有没有进 `saveReport` 的依赖数组、`reportsListKnown` 有没有
 * 在拉列表失败时被置回 false、确认之后有没有真的回到落盘那一步 ——
 * 纯函数测不到任何一条。本项目已经因为「接线漏了」栽过
 * （分页开关画出来了、state 也变了，参数却没进请求体）。
 *
 * ## 三个用例是**对照组**，不是凑数
 *
 * 只有「已存在 → 弹框」一条的话，把它写成「保存永远弹框」也能过 ——
 * 而那样做，用户会被训练成闭眼点确定，这个确认就白做了。所以另外钉三条**必须不弹**：
 * 列表里没有这个 id / 已经确认过一次 / 打开后直接存自己那份。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Univer 是被测对象之外的东西：真拉起来会拖进整套 canvas / worker，jsdom 里又慢又不稳 */
vi.mock('../report/univerFormulaFree', () => ({
  createFormulaFreeUniver: () => ({
    univerAPI: { createWorkbook: () => ({}), dispose: () => {} },
  }),
}))

import GridReportModal from './GridReportModal'
import { useDataSourceStore } from '../stores/dataSource'

/* ------------------------------- 假服务端 ------------------------------- */

interface Captured {
  url: string
  method: string
  body: Record<string, unknown> | null
}

let calls: Captured[] = []
/** `GET /api/reports` 要回的列表。**每个用例自己摆** —— 本文件测的就是它怎么影响判据。 */
let savedList: Record<string, unknown>[] = []
/** 让 `GET /api/reports` 失败（模拟「列表读不到」） */
let listFails = false

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
  const method = init?.method ?? 'GET'
  calls.push({
    url,
    method,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  })
  // 列表：可配成失败 —— 「读不到列表」和「没有同名报表」在数据上都是空数组，
  // 必须能分开造，否则那条边界根本测不到。
  if (url.includes('/api/reports') && !url.includes('/api/reports/save')) {
    if (listFails) return Promise.reject(new Error('列表拉不到'))
    return Promise.resolve(jsonOk(savedList))
  }
  if (url.includes('/api/report/render')) {
    return Promise.resolve(
      jsonOk({ sheets: [{ name: 'Sheet1', rows: [{ cells: [{ value: 'city' }] }] }], pages: [], html: '' }),
    )
  }
  return Promise.resolve(jsonOk({}))
}

const saveCalls = (): Captured[] => calls.filter((c) => c.url.includes('/api/reports/save'))

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
  // 让 refreshReports 落地 —— 列表没读完就点保存，测的就不是判据了
  await flush(80)
}

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

/** 把表单填到「能构建出请求」：库 + 表 + 分组字段 + 数值字段 */
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

/**
 * 往「文件 id」里打字。
 *
 * ⚠️ React 的受控 `input` 会劫持 `value` 的 setter，**直接赋值不会触发 onChange**。
 * 必须拿原型上的原生 setter 写进去，再派发 `input` 事件 —— 这是测受控组件的固定套路，
 * 少一步就会「值看着设上了、其实 state 没变」，而那正是本项目最怕的那种假绿。
 */
async function setReportId(id: string): Promise<void> {
  const el = await waitFor(
    () => document.querySelector<HTMLInputElement>('[data-testid="report-file-id"]'),
    '文件 id 输入框',
  )
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, id)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function clickTestId(testid: string): Promise<void> {
  const el = await waitFor(
    () => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`),
    testid,
  )
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush(120)
}

const clickSave = (): Promise<void> => clickTestId('report-file-save')

/**
 * 确认框**现在开着吗**？
 *
 * ⚠️ 不能用「DOM 里有没有那个按钮」判 —— 这是踩出来的：
 * jsdom 里 rc-motion 的**离场动画永远不会结束**（没有真实 `transitionend`），
 * 于是 `destroyOnHidden` 永远等不到 `afterClose`，**关掉的框照样留在 DOM 里**，
 * 只是 `.ant-modal` 上多了 `ant-zoom-leave ant-zoom-leave-active`。
 * 拿存在性当判据会得到一个「永远开着」的假象，然后：
 * - 「取消后框关掉了」那条断言**恒假**（实测 3 条用例同时红在这里）；
 * - 反过来，「该弹框」那条断言**恒真**，等于没测。
 *
 * 所以看 rc-motion 的状态类：离场中/已关闭带 `-leave`，进场中是 `-enter`，
 * 停稳后什么都没有。只有**不带 `-leave`** 才算开着。
 * （依赖 antd/rc-motion 的类名约定 —— 升级 antd 时这条要一起看。）
 */
function confirmVisible(): boolean {
  const ok = document.querySelector('[data-testid="report-overwrite-ok"]')
  if (!ok) return false
  const dialog = ok.closest('.ant-modal') as HTMLElement | null
  if (!dialog) return false
  return !/-leave/.test(dialog.className)
}

/** 一条列表项的最小骨架（字段名是 camelCase，服务端 `ReportSummary` 上是 `rename_all`） */
function summary(id: string, name: string): Record<string, unknown> {
  return { id, name, description: '', updatedAt: null, sheets: [], sourceCount: 0, bytes: 1 }
}

/* --------------------------------- 用例 --------------------------------- */

describe('GridReportModal：覆盖已有报表必须先确认', () => {
  beforeEach(() => {
    calls = []
    savedList = []
    listFails = false
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

  it('目标 id 已存在且不是我在编辑的那份 → 弹确认，且**一个 save 请求都没发出去**', async () => {
    savedList = [summary('taken', '别人的报表')]

    await mount()
    await fillGroupForm()
    await setReportId('taken')
    await clickSave()

    // ⚠️ 顺序是有意的：**先断言契约（一个字节都没发出去），再断言机制（弹了框）**。
    // 反过来写的话，一旦有人拆掉确认逻辑，用例会先红在「有没有弹框」上、
    // 直接短路 —— 于是「请求到底拦没拦住」那条**永远验不到**。
    // 刻意**不写行号** —— 一改上下文就漂，而这种注释漂了不会有人发现。
    expect(
      saveCalls().length,
      '目标 id 已存在却直接把覆盖请求发出去了 —— 这是本文件要防的最坏情况',
    ).toBe(0)
    expect(confirmVisible(), '必须弹确认框，让用户知道要换掉的是哪一份').toBe(true)
    expect(
      document.body.textContent,
      '确认框要说清「要换掉的是哪一份」——只说「已存在」等于没说',
    ).toContain('别人的报表')
  })

  it('点「覆盖」→ 请求真的发出去，且 body 里的 id 就是那个 id', async () => {
    savedList = [summary('taken', '别人的报表')]

    await mount()
    await fillGroupForm()
    await setReportId('taken')
    await clickSave()
    expect(confirmVisible()).toBe(true)

    await clickTestId('report-overwrite-ok')

    const sent = saveCalls()
    expect(sent.length, '确认之后必须真的存下去 —— 否则这个确认框就成了「什么都存不了」').toBe(1)
    expect(sent[0]!.method, '保存走 PUT').toBe('PUT')
    expect(sent[0]!.body?.id).toBe('taken')
    expect(confirmVisible(), '确认完框要关掉').toBe(false)
  })

  it('点「取消」→ 什么都不做（请求为 0），框关掉', async () => {
    savedList = [summary('taken', '别人的报表')]

    await mount()
    await fillGroupForm()
    await setReportId('taken')
    await clickSave()

    await clickTestId('report-overwrite-cancel')

    expect(saveCalls().length, '取消了还发请求 = 用户以为没覆盖，其实覆盖了').toBe(0)
    expect(confirmVisible(), '取消之后框要收起来').toBe(false)

    // ★ 再点一次保存：必须**重新问**，而不是因为上一次取消就把目标 id 记成「我的」了。
    // 少了这一条，「取消」这个动作到底有没有生效就只能靠「请求数为 0」推 ——
    // 而那个数在「取消根本没触发」时**同样是 0**（假绿）。
    await clickSave()
    expect(saveCalls().length, '取消之后又点保存，仍然不该有请求发出去').toBe(0)
    expect(confirmVisible(), '取消不该改变判据：目标 id 依然是别人的，要重新问').toBe(true)
  })

  it('对照组：列表里**没有**这个 id → 不弹，直接存（否则就是「每次都拦」）', async () => {
    savedList = [summary('other', '另一份报表')]

    await mount()
    await fillGroupForm()
    await setReportId('brand-new')
    await clickSave()

    expect(confirmVisible(), 'id 不存在就不是覆盖，不该打扰用户').toBe(false)
    const sent = saveCalls()
    expect(sent.length, '新增一份报表必须能一次点成').toBe(1)
    expect(sent[0]!.body?.id).toBe('brand-new')
  })

  it('对照组：确认过一次之后再存同一个 id → 不再弹（打开/存过的那份就是「我的」）', async () => {
    savedList = [summary('taken', '别人的报表')]

    await mount()
    await fillGroupForm()
    await setReportId('taken')
    await clickSave()
    await clickTestId('report-overwrite-ok')
    expect(saveCalls().length).toBe(1)

    // 第二次：`lastSavedId` 已经是 taken 了 → 属于「存我自己这份」，不该再问
    await clickSave()

    expect(confirmVisible(), '存自己刚存过的那份还弹框，会把用户训练成闭眼点确定').toBe(false)
    expect(saveCalls().length, '第二次保存必须直接落盘').toBe(2)
  })

  it('列表**读不到**时不算「没有同名」→ 仍然弹（不确定就问，别猜）', async () => {
    // 「拉列表失败」和「一份报表都没有」在数据上都是空数组 —— 只按数组判会静默放行
    listFails = true

    await mount()
    await fillGroupForm()
    await setReportId('maybe-taken')
    await clickSave()

    expect(
      confirmVisible(),
      '列表读不到时无法排除同名，必须当成不确定来问 —— 静默放行就等于赌',
    ).toBe(true)
    expect(saveCalls().length, '没确认之前不能发').toBe(0)
  })
})
