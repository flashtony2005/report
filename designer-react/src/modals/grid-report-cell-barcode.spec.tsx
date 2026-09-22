/**
 * 条码格面板的 UI 层用例：`CellModelEditor` → `model.barcode`。
 *
 * 断言一律看 `onChange` 收到的 **model**，不断言「没报错」——
 * 本文件关心的恰恰是「UI 动了但 model 没变」这类静默失效。
 *
 * 几条容易静默的点，各自钉住：
 * 1. 选「固定内容」必须真的往 `model.barcode` 里写，不能只换个下拉框的显示；
 * 2. 填的内容要落到 `barcode.value`，**不是**顺手把 cell.value 改了
 *    （两者是两回事：cell.value 是格子里显示的文本）；
 * 3. 切回「不出码」时整个 `barcode` 要摘掉 —— 留着 `{value:''}` 会被服务端
 *    当成「配了码但配错了」，出一格 `[条码: 条码内容为空]`；
 * 4. `gs1` 只对 Code128 有意义：二维码时**不能显示**这个开关（设了没反应），
 *    切到二维码时还要把已有的 gs1 **摘掉**（否则它静默留在模板里）；
 * 5. 超容量 / 非 ASCII 要在**设计期**就说 —— 服务端只在导出时才报，
 *    作者填完得等一次请求才知道填错了；
 * 6. 与图片 / 图表同时设时要说清优先级（服务端只出一个，被盖住的连编都不编）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CellModelEditor } from './GridReportModal'
import type { CellBarcode, CellTpl } from '@/report/grid-report'

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
        pos: 'A3',
        cell: current,
        columns: ['region', 'city', 'order_no'],
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
  // 必须把结果喂回去：组件是受控的，不回灌的话界面还停在切换前的状态，
  // 「切过去之后输入框消失」这类**渲染层**断言就永远是假的
  await sync()
}

async function toggleSwitch(testid: string): Promise<void> {
  await act(async () => {
    byTestid(testid).click()
  })
  await flush()
  await sync()
}

function barcodeOf() {
  return latest?.model?.barcode ?? undefined
}

function text(): string {
  return host.textContent ?? ''
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

describe('条码格面板', () => {
  it('选「固定内容」写进 model.barcode，内容先留空、码制缺省二维码', async () => {
    await mount({ value: '华东' })
    await pickOption('free-cell-barcode-from', '固定内容')
    expect(barcodeOf()?.from).toBe('literal')
    expect(barcodeOf()?.value).toBe('')
    expect(barcodeOf()?.symbology, '缺省应当是二维码').toBe('qr')
  })

  it('内容输入框落到 barcode.value（不动 cell.value）', async () => {
    await mount({ value: '华东', model: { barcode: { from: 'literal', value: '' } } })
    await typeIntoTestid('free-cell-barcode-value', 'SO-2026-0001')
    expect(barcodeOf()?.value).toBe('SO-2026-0001')
    expect(latest?.value, '填条码内容不该顺手改格子文本').toBe('华东')
  })

  it('切到「取本格的值」保留 from=value，并隐藏内容输入框', async () => {
    await mount({
      value: '华东',
      model: { barcode: { from: 'literal', value: 'SO-1' } },
    })
    await pickOption('free-cell-barcode-from', '取本格的值')
    expect(barcodeOf()?.from).toBe('value')
    // 内容由数据决定，手填的输入框没有意义
    expect(hasTestid('free-cell-barcode-value')).toBe(false)
    expect(text(), '要说清内容是跟着数据走的').toContain('每行一个条码')
  })

  /// 留个 `{value:''}` 会被服务端当成「配了码但配错了」
  it('切回「不出码」时整个 barcode 被摘掉', async () => {
    await mount({ value: '华东', model: { barcode: { from: 'literal', value: 'SO-1' } } })
    await pickOption('free-cell-barcode-from', '不出码')
    expect(
      latest?.model?.barcode,
      `不该留空 barcode: ${JSON.stringify(latest?.model)}`,
    ).toBeUndefined()
  })

  it('没设条码的格子不显示内容输入框', async () => {
    await mount({ value: '华东' })
    expect(hasTestid('free-cell-barcode-value')).toBe(false)
    expect(hasTestid('free-cell-barcode-sym')).toBe(false)
  })

  /// gs1 对二维码没有意义 —— 显示了就是一个「设了没反应」的开关
  it('GS1 开关只在 Code128 时出现', async () => {
    await mount({ value: '华东', model: { barcode: { from: 'literal', value: 'SO-1' } } })
    expect(hasTestid('free-cell-barcode-gs1'), '二维码时不该有 GS1 开关').toBe(false)
    await pickOption('free-cell-barcode-sym', 'Code128')
    expect(hasTestid('free-cell-barcode-gs1'), 'Code128 时应当有 GS1 开关').toBe(true)
  })

  /// 切回二维码时若把 gs1 留着，它会静默躺在模板里，没人看得出来
  it('从 Code128 切回二维码会把 gs1 摘掉', async () => {
    await mount({
      value: '华东',
      model: { barcode: { from: 'literal', value: 'SO-1', symbology: 'code128', gs1: true } },
    })
    expect(hasTestid('free-cell-barcode-gs1')).toBe(true)
    await pickOption('free-cell-barcode-sym', '二维码')
    expect(barcodeOf()?.symbology).toBe('qr')
    expect(barcodeOf()?.gs1, '二维码留着 gs1 就是设了没反应').toBeUndefined()
  })

  it('GS1 开关真的写进 model', async () => {
    await mount({
      value: '华东',
      model: { barcode: { from: 'literal', value: 'SO-1', symbology: 'code128' } },
    })
    await toggleSwitch('free-cell-barcode-gs1')
    expect(barcodeOf()?.gs1).toBe(true)
  })

  it('二维码超 213 字节在设计期就提示', async () => {
    await mount({
      value: '华东',
      model: { barcode: { from: 'literal', value: 'A'.repeat(214) } },
    })
    expect(hasTestid('free-cell-barcode-problem')).toBe(true)
    expect(text(), '要说清上限是 213').toContain('213')
  })

  it('214 字节的二维码提示，213 字节不提示（边界）', async () => {
    await mount({
      value: '华东',
      model: { barcode: { from: 'literal', value: 'A'.repeat(213) } },
    })
    expect(hasTestid('free-cell-barcode-problem'), '213 应当刚好放得下').toBe(false)
  })

  it('Code128 遇到中文要提示并指向二维码', async () => {
    await mount({
      value: '华东',
      model: { barcode: { from: 'literal', value: '销售单', symbology: 'code128' } },
    })
    expect(hasTestid('free-cell-barcode-problem')).toBe(true)
    expect(text()).toContain('ASCII')
    expect(text(), '要指向二维码').toContain('二维码')
  })

  it('内容为空要提示', async () => {
    await mount({ value: '华东', model: { barcode: { from: 'literal', value: '' } } })
    expect(text()).toContain('条码内容为空')
  })

  /// 213 是按 UTF-8 **字节**算的，一个汉字 3 字节 —— 常显才不容易踩
  it('常显 UTF-8 字节数与上限', async () => {
    await mount({
      value: '华东',
      model: { barcode: { from: 'literal', value: '销售单' } },
    })
    expect(text(), '「销售单」是 9 字节不是 3 个字符').toContain('9 / 213')
  })

  /// 故意塞一个**契约外**的码制：模板是手写 JSON 也能存的，
  /// 服务端认不出只坏这一格，设计器得在打开时就点名，别等导出。
  it('认不出的码制要点名', async () => {
    await mount({
      value: '华东',
      model: {
        barcode: {
          from: 'literal',
          value: 'SO-1',
          symbology: 'code39' as unknown as CellBarcode['symbology'],
        },
      },
    })
    expect(text()).toContain('code39')
    expect(text()).toContain('code128')
  })

  it('取本格的值时不做容量 / 字符集判断（内容设计期不知道）', async () => {
    await mount({
      value: '华东',
      // `value` 是必填字段，但 `from: 'value'` 时它的值被忽略 ——
      // 内容运行期才从数据里来，所以这里就是空串。
      model: { barcode: { from: 'value', value: '', symbology: 'code128' } },
    })
    expect(hasTestid('free-cell-barcode-problem'), '内容还不知道，不该乱报').toBe(false)
  })

  /// 服务端只出一个（被盖住的连编都不编），界面上必须说清
  it('同时设了图片和条码时提示优先级', async () => {
    await mount({
      value: '华东',
      model: {
        image: { from: 'literal', src: 'data:image/png;base64,aGVsbG8=' },
        barcode: { from: 'literal', value: 'SO-1' },
      },
    })
    expect(hasTestid('free-cell-graphic-conflict')).toBe(true)
    expect(text()).toContain('图片')
    expect(text()).toContain('条码')
  })

  it('只设条码时不提示优先级', async () => {
    await mount({ value: '华东', model: { barcode: { from: 'literal', value: 'SO-1' } } })
    expect(hasTestid('free-cell-graphic-conflict')).toBe(false)
  })

  it('动条码不该顺手动到 model 的其它字段', async () => {
    await mount({
      value: '华东',
      model: { ds: 'ds1', field: 'region', style: { bold: true } },
    })
    await pickOption('free-cell-barcode-from', '固定内容')
    expect(latest?.model?.ds).toBe('ds1')
    expect(latest?.model?.field).toBe('region')
    expect(latest?.model?.style?.bold).toBe(true)
  })
})
