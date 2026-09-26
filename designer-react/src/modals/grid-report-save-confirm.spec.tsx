/**
 * `GridReportModal` 的 UI 层用例：**覆盖已有报表之前必须先确认**。
 *
 * ## 两道闸，查的不是同一个事实
 *
 * 服务端 `store::save` 是覆盖写。它自己的文档注释写着：
 *
 * > 保存。**覆盖写**：报表是用户的资产，静默覆盖同名文件会丢东西，
 * > **所以调用方（UI）要先经列表确认**
 *
 * 而在这之前**那句话是假的**：`saveReport` 直接 `PUT /api/reports/save`，
 * 一次确认都没有 —— UI 手上明明就有 `savedReports` 列表，也没拿它做任何判断。
 * 结果：手打一个已存在的 id → 点保存 → 那份报表**无声无息被换掉**。
 *
 * 现在有两道：
 *
 * | | 判据来源 | 挡得住 | 挡不住 |
 * | --- | --- | --- | --- |
 * | UI 预判（省一次往返） | 打开弹窗那一刻的列表**快照** | 手打一个列表里已有的 id | 之后别处新建的同名 |
 * | 服务端 `save_new` | **文件系统**（权威） | 任何调用方，含 curl | —— |
 *
 * 第二道是这次新加的。**本文件里最值钱的一条用例是「快照过期」那条**：
 * 客户端列表是空的（所以它不弹确认），而服务端有同名 → 服务端 409 →
 * UI 必须把它转成**确认框**，而不是弹一句「已存在」让用户无路可走。
 * 那正是客户端自觉永远堵不住、只有服务端能接住的那个洞。
 *
 * ## 为什么必须挂真弹窗
 *
 * 判据是**接线**：`savedReports` 有没有进 `saveReport` 的依赖数组、
 * `reportsListKnown` 有没有在拉列表失败时置回 false、409 分支有没有排在
 * 通用错误分支**之前**、确认之后有没有真的回到落盘那一步 ——
 * 纯函数测不到任何一条。本项目已经因为「接线漏了」栽过
 * （分页开关画出来了、state 也变了，参数却没进请求体）。
 *
 * ## 一半用例是**对照组**，不是凑数
 *
 * 只有「已存在 → 弹框」一条的话，把它写成「保存永远弹框」也能过 ——
 * 而那样做，用户会被训练成闭眼点确定，这个确认就白做了。所以另有一批**必须不弹**：
 * 列表里没有这个 id / 已经确认过一次 / 打开后直接存自己那份。
 * 同理，`force=1` 也必须只在**有授权**时才出现（见「不该带 force」那几条断言）——
 * 否则「永远带 force」也能让「已存在 → 弹框」过，而那道服务端闸就废了。
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
/**
 * `GET /api/reports` 要回的列表 —— 也就是**客户端看得见的那个快照**。
 * 每个用例自己摆：本文件测的就是它怎么影响判据。
 */
let savedList: Record<string, unknown>[] = []
/**
 * **服务端实际有哪些报表** —— 权威事实，与 `savedList` 分开维护。
 *
 * 分开是必须的：本文件最值钱的那条用例正是「两者不一致」——
 * 客户端快照里没有、服务端有（别处刚建的）。用一个变量就造不出那个场景，
 * 那条用例会退化成「客户端自己拦住了」的假绿。
 */
let serverHas = new Set<string>()
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

/** 非 2xx 的响应体是**纯文本**（服务端 `(StatusCode, String)`），不是 JSON */
function textRes(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => {
      throw new Error('服务端的错误响应是纯文本，不该走 json()')
    },
    text: async () => body,
    blob: async () => new Blob([body]),
  } as unknown as Response
}

/** 服务端认的 force 写法（与 Rust `SaveQuery::forced` 同一份口径） */
const FORCE_RE = /[?&]force=(1|true|yes)(&|$)/i

function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
  calls.push({ url, method, body })

  // ⚠️ 先判 save，再判列表 —— 顺序反了的话 `/api/reports` 的前缀匹配会把
  // `/api/reports/save` 也吞掉，保存请求会被当成「拉列表」回一个数组。
  if (url.includes('/api/reports/save')) {
    const id = String(body?.id ?? '').trim()
    // 与服务端 `save_new` 同一条规则：已存在 且 没带 force → 409
    if (serverHas.has(id) && !FORCE_RE.test(url)) {
      return Promise.resolve(
        textRes(409, `报表 ${id} 已存在；覆盖会换掉原内容。确认要覆盖请带 ?force=1 重发。`),
      )
    }
    serverHas.add(id)
    return Promise.resolve(jsonOk({ ...body, id }))
  }
  if (url.includes('/api/reports')) {
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

/**
 * 常规摆法：**客户端看到的列表 == 服务端实际有的东西**（也就是没发生「快照过期」）。
 * 要造不一致的场面就**别用这个**，直接分别写 `savedList` / `serverHas`。
 */
function givenReports(...items: Record<string, unknown>[]): void {
  savedList = items
  serverHas = new Set(items.map((r) => String(r.id)))
}

/* --------------------------------- 用例 --------------------------------- */

describe('GridReportModal：覆盖已有报表必须先确认', () => {
  beforeEach(() => {
    calls = []
    savedList = []
    serverHas = new Set()
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
    givenReports(summary('taken', '别人的报表'))

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

  it('点「覆盖」→ 带 force=1 重发，且 body 里的 id 就是那个 id', async () => {
    givenReports(summary('taken', '别人的报表'))

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
    // ★ 确认 = 那句「我有权覆盖」。不带 force 的话服务端还会 409 一次，
    //   用户会看到自己刚点过「覆盖」却又被问一遍。
    expect(sent[0]!.url, '确认之后必须带 force=1').toMatch(FORCE_RE)
    expect(confirmVisible(), '确认完框要关掉').toBe(false)
  })

  it('点「取消」→ 什么都不做（请求为 0），框关掉', async () => {
    givenReports(summary('taken', '别人的报表'))

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

  it('对照组：列表里**没有**这个 id → 不弹，直接存，且**不带 force**', async () => {
    givenReports(summary('other', '另一份报表'))

    await mount()
    await fillGroupForm()
    await setReportId('brand-new')
    await clickSave()

    expect(confirmVisible(), 'id 不存在就不是覆盖，不该打扰用户').toBe(false)
    const sent = saveCalls()
    expect(sent.length, '新增一份报表必须能一次点成').toBe(1)
    expect(sent[0]!.body?.id).toBe('brand-new')
    // ★ 反向对照：新增时**不能**带 force。要是无脑永远带 force=1，
    //   服务端那道闸就等于不存在了 —— 而「永远带 force」同样能让上面几条过。
    expect(sent[0]!.url, '新增不是覆盖，不该带 force').not.toMatch(FORCE_RE)
  })

  it('对照组：确认过一次之后再存同一个 id → 不弹，且**带 force**', async () => {
    givenReports(summary('taken', '别人的报表'))

    await mount()
    await fillGroupForm()
    await setReportId('taken')
    await clickSave()
    await clickTestId('report-overwrite-ok')
    expect(saveCalls().length).toBe(1)

    // 第二次：`lastSavedId` 已经是 taken 了 → 属于「存我自己这份」，不该再问
    await clickSave()

    expect(confirmVisible(), '存自己刚存过的那份还弹框，会把用户训练成闭眼点确定').toBe(false)
    const sent = saveCalls()
    expect(sent.length, '第二次保存必须直接落盘').toBe(2)
    // ★ 这次**必须带 force**：报表此刻在服务端已经存在了。
    //   不带的话服务端会 409 → 又弹一次确认框 → 「存自己那份」变成每次都要点两下。
    //   也就是说这条断言同时钉住了「不弹框」和「服务端那道闸没把正常操作卡住」。
    expect(sent[1]!.url, '存自己正在编辑的那份要带 force，否则会被服务端顶回来').toMatch(FORCE_RE)
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

  /* ------------------------- 服务端那道闸（这次新加的） ------------------------- */

  it('★ 客户端快照过期：列表里没有、服务端却有 → 服务端 409 必须转成确认框，而不是报错', async () => {
    /*
     * 这是**只有服务端能接住**的那种情况：
     * 打开弹窗时列表是空的（另一份是同名报表是之后在别处建的），
     * 所以客户端预判判定「不存在」→ 不弹确认 → 直接发请求。
     * 服务端查文件系统，发现已存在且没带 force → 409。
     */
    savedList = [] // 客户端看到的
    serverHas = new Set(['ghost']) // 服务端实际有的

    await mount()
    await fillGroupForm()
    await setReportId('ghost')
    await clickSave()

    // 1) 客户端预判确实放行了 —— 否则这条用例测的就不是服务端那道闸
    const first = saveCalls()
    expect(first.length, '客户端快照里没有它，预判应当放行、让服务端去判').toBe(1)
    expect(first[0]!.url, '预判放行时不该自带 force（那正是要服务端替我判的原因）').not.toMatch(
      FORCE_RE,
    )

    // 2) 服务端 409 → **必须弹确认框**。
    //    这里红通常意味着 409 落进了 `!res.ok → setError`：
    //    用户会看到一句「报表 ghost 已存在」，然后**没有任何办法继续保存** ——
    //    明明点一下「覆盖」就能存。这是本条用例存在的全部理由。
    expect(
      confirmVisible(),
      '409 被当成普通错误了 —— 用户会被告知「已存在」却无路可走',
    ).toBe(true)

    // 3) 确认之后必须带 force 重发 —— 不带的话服务端还会再拒一次
    await clickTestId('report-overwrite-ok')
    const sent = saveCalls()
    expect(sent.length, '确认之后要真的重发一次').toBe(2)
    expect(sent[1]!.url, '重发必须带 force=1').toMatch(FORCE_RE)
    expect(sent[1]!.body?.id).toBe('ghost')
  })

  it('★ 对照组：服务端没有同名时**不该**弹（别把 409 做成「每次都拦」）', async () => {
    savedList = []
    serverHas = new Set()

    await mount()
    await fillGroupForm()
    await setReportId('fresh')
    await clickSave()

    expect(confirmVisible(), '服务端也没有，就不该弹').toBe(false)
    const sent = saveCalls()
    expect(sent.length).toBe(1)
    expect(sent[0]!.url).not.toMatch(FORCE_RE)
  })
})
