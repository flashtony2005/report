/**
 * 图片格面板的 UI 层用例：`CellModelEditor` → `model.image`。
 *
 * 断言一律看 `onChange` 收到的 **model**，不断言「没报错」——
 * 本文件关心的恰恰是「UI 动了但 model 没变」这类静默失效。
 *
 * 四条容易静默的点，各自钉住：
 * 1. 选了「固定图片」必须真的往 `model.image` 里写，不能只换个下拉框的显示；
 * 2. 填的 data URI 要落到 `image.src`，**不是**顺手把 cell.value 改了；
 * 3. 切回「不出图」时整个 `image` 要摘掉，不能留个 `{from:'literal',src:''}`
 *    ——留着会被服务端当成「配了图但配错了」，出一格 `[图片: ...]`；
 * 4. 非法 src（文件路径 / webp）要给提示 —— Univer 网格画不了图片，
 *    没有提示的话作者设了在网格里看不到任何变化。
 *
 * **故意没有「缩略图渲染成功」的断言**：jsdom 不解码图片，`<img>` 的
 * naturalWidth 永远是 0。能验的只是「缩略图这个元素出不出现」。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CellModelEditor } from './GridReportModal'
import type { CellTpl } from '@/report/grid-report'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
        columns: ['region', 'city', 'photo'],
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
  // 「切过去之后 src 输入框消失」这类**渲染层**断言就永远是假的
  await sync()
}

function imageOf() {
  return latest?.model?.image ?? undefined
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

describe('图片格面板', () => {
  it('选「固定图片」写进 model.image，src 先留空', async () => {
    await mount({ value: '华东' })
    await pickOption('free-cell-image-from', '固定图片')
    expect(imageOf()?.from).toBe('literal')
    expect(imageOf()?.src).toBe('')
  })

  it('src 输入框落到 image.src（不动 cell.value）', async () => {
    await mount({ value: '华东', model: { image: { from: 'literal', src: '' } } })
    await typeIntoTestid('free-cell-image-src', PNG)
    expect(imageOf()?.src).toBe(PNG)
    expect(latest?.value, '填图片不该顺手改格子内容').toBe('华东')
  })

  it('合法 src 出缩略图', async () => {
    await mount({ value: '华东', model: { image: { from: 'literal', src: PNG } } })
    expect(hasTestid('free-cell-image-thumb'), '合法 data URI 应当有缩略图').toBe(true)
  })

  /// Univer 网格画不了图片，所以面板里的提示是唯一的「设了有反应」
  it('文件路径 / webp 给提示，且不出缩略图', async () => {
    for (const bad of ['/Users/me/logo.png', 'data:image/webp;base64,aGVsbG8=']) {
      await mount({ value: '华东', model: { image: { from: 'literal', src: bad } } })
      expect(hasTestid('free-cell-image-thumb'), `${bad} 不该出缩略图`).toBe(false)
      const warn = host.textContent ?? ''
      expect(warn.includes('data:image/png;base64'), `${bad} 应当给出提示，实际：${warn}`).toBe(
        true,
      )
    }
  })

  it('空 src 也给提示（否则服务端会出一格 [图片: ...]）', async () => {
    await mount({ value: '华东', model: { image: { from: 'literal', src: '' } } })
    expect((host.textContent ?? '').includes('data:image/png;base64')).toBe(true)
  })

  /// 留个 `{from:'literal',src:''}` 会被服务端当成「配了图但配错了」
  it('切回「不出图」时整个 image 被摘掉', async () => {
    await mount({ value: '华东', model: { image: { from: 'literal', src: PNG } } })
    await pickOption('free-cell-image-from', '不出图')
    expect(
      latest?.model?.image,
      `不该留空 image: ${JSON.stringify(latest?.model)}`,
    ).toBeUndefined()
  })

  it('切到「取本格的值」保留 from=value，并隐藏 src 输入框', async () => {
    await mount({ value: '华东', model: { image: { from: 'literal', src: PNG } } })
    await pickOption('free-cell-image-from', '取本格的值')
    expect(imageOf()?.from).toBe('value')
    // 取本格的值时 src 由数据决定，手填的输入框没有意义
    expect(hasTestid('free-cell-image-src')).toBe(false)
  })

  it('没设图片的格子不显示 src 输入框', async () => {
    await mount({ value: '华东' })
    expect(hasTestid('free-cell-image-src')).toBe(false)
    expect(hasTestid('free-cell-image-thumb')).toBe(false)
  })

  it('动图片不该顺手动到 model 的其它字段', async () => {
    await mount({
      value: '华东',
      model: { ds: 'ds1', field: 'region', style: { bold: true } },
    })
    await pickOption('free-cell-image-from', '固定图片')
    expect(latest?.model?.ds).toBe('ds1')
    expect(latest?.model?.field).toBe('region')
    expect(latest?.model?.style?.bold).toBe(true)
  })
})
