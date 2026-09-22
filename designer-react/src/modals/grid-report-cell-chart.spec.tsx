/**
 * 图表格面板的 UI 层用例：`CellModelEditor` → `model.chart`。
 *
 * 断言一律看 `onChange` 收到的 **model**，不断言「没报错」——
 * 本文件关心的恰恰是「UI 动了但 model 没变」这类静默失效。
 *
 * 几条容易静默的点，各自钉住：
 * 1. 选「柱状图」必须真的往 `model.chart` 里写，且**带一条空序列**
 *    —— 不带的话下面没有输入行可填，作者会以为图表配好了；
 * 2. 类目输入是**逗号分隔的模板坐标**，要切成数组落进 `chart.categories`；
 * 3. 序列的「数值坐标」要落到 `series[i].from` —— 这里填的是**模板坐标**
 *    （`B3`）不是值，填成值服务端会找不到格子；
 * 4. 切回「不出图」时整个 `chart` 要摘掉，不能留个 `{kind:'bar',series:[]}`；
 * 5. 饼图配多条序列要被服务端拒绝，设计期先说；
 * 6. 坐标形状不对（填了「华东」这种值）要在设计期就说。
 *
 * **故意没有「真的画出图」的断言**：Univer 网格画不了图表（它的样式通道只有
 * 底色 + 字色），面板里能验的只是「设了有没有反应 / model 有没有变」。
 * 图到底画得对不对由服务端探针 `scripts/verify-xlsx-chart.py` 负责。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CellModelEditor } from './GridReportModal'
import type { CellTpl } from '@/report/grid-report'

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
        pos: 'D3',
        cell: current,
        columns: ['region', 'amount'],
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

async function clickTestid(testid: string): Promise<void> {
  await act(async () => {
    byTestid(testid).click()
  })
  await flush()
  await sync()
}

/** antd Select：触发器是 `.ant-select-content`（v6），上一个下拉只加 `-hidden` */
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
  await sync()
}

function chartOf() {
  return latest?.model?.chart ?? undefined
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

describe('图表格面板', () => {
  it('选「柱状图」写进 model.chart，并带一条空序列', async () => {
    await mount({ value: '华东' })
    await pickOption('free-cell-chart-kind', '柱状图')
    expect(chartOf()?.kind).toBe('bar')
    expect(chartOf()?.series?.length, '不带一条空序列就没有输入行可填').toBe(1)
    expect(chartOf()?.series?.[0]?.from).toBe('')
  })

  it('类目输入按逗号切成数组', async () => {
    await mount({ value: '华东', model: { chart: { kind: 'bar', series: [{ from: 'B3' }] } } })
    await typeIntoTestid('free-cell-chart-categories', 'A3, A4')
    expect(chartOf()?.categories).toEqual(['A3', 'A4'])
  })

  it('序列的数值坐标落到 series[0].from（不动 cell.value）', async () => {
    await mount({ value: '华东', model: { chart: { kind: 'bar', series: [{ from: '' }] } } })
    await typeIntoTestid('free-cell-chart-series-from-0', 'B3')
    expect(chartOf()?.series?.[0]?.from).toBe('B3')
    expect(latest?.value, '填图表不该顺手改格子文本').toBe('华东')
  })

  it('序列名落到 series[0].name，清空时摘掉（不留空串）', async () => {
    await mount({ value: '华东', model: { chart: { kind: 'bar', series: [{ from: 'B3' }] } } })
    await typeIntoTestid('free-cell-chart-series-name-0', '销售额')
    expect(chartOf()?.series?.[0]?.name).toBe('销售额')
    await typeIntoTestid('free-cell-chart-series-name-0', '')
    expect(chartOf()?.series?.[0]?.name).toBeUndefined()
  })

  it('加序列 / 删序列真的改数组', async () => {
    await mount({ value: '华东', model: { chart: { kind: 'bar', series: [{ from: 'B3' }] } } })
    await clickTestid('free-cell-chart-add-series')
    expect(chartOf()?.series?.length).toBe(2)
    expect(hasTestid('free-cell-chart-series-from-1')).toBe(true)
    await clickTestid('free-cell-chart-del-series-1')
    expect(chartOf()?.series?.length).toBe(1)
    expect(hasTestid('free-cell-chart-series-from-1')).toBe(false)
  })

  it('标题落到 chart.title，清空时摘掉', async () => {
    await mount({ value: '华东', model: { chart: { kind: 'bar', series: [{ from: 'B3' }] } } })
    await typeIntoTestid('free-cell-chart-title', '各地区销售额')
    expect(chartOf()?.title).toBe('各地区销售额')
    await typeIntoTestid('free-cell-chart-title', '')
    expect(chartOf()?.title).toBeUndefined()
  })

  /// 留个 `{kind:'bar',series:[]}` 会被服务端当成「配了图但配错了」
  it('切回「不出图」时整个 chart 被摘掉', async () => {
    await mount({
      value: '华东',
      model: { chart: { kind: 'bar', categories: ['A3'], series: [{ from: 'B3' }] } },
    })
    await pickOption('free-cell-chart-kind', '不出图')
    expect(latest?.model?.chart, `不该留空 chart: ${JSON.stringify(latest?.model)}`).toBeUndefined()
  })

  it('没设图表的格子不显示类目输入框', async () => {
    await mount({ value: '华东' })
    expect(hasTestid('free-cell-chart-categories')).toBe(false)
    expect(hasTestid('free-cell-chart-add-series')).toBe(false)
  })

  /// 最常填错的：把「值」当成「模板坐标」填进来
  it('类目填成值（不是模板坐标）要在设计期就说', async () => {
    await mount({
      value: '华东',
      model: { chart: { kind: 'bar', categories: ['华东'], series: [{ from: 'B3' }] } },
    })
    expect(hasTestid('free-cell-chart-problem')).toBe(true)
    expect(text()).toContain('华东')
    expect(text(), '要说清该填什么').toContain('A3')
  })

  it('数值坐标填成值也要说', async () => {
    await mount({
      value: '华东',
      model: { chart: { kind: 'bar', categories: ['A3'], series: [{ from: '1200' }] } },
    })
    expect(hasTestid('free-cell-chart-problem')).toBe(true)
    expect(text()).toContain('1200')
  })

  it('没有序列要提示', async () => {
    await mount({ value: '华东', model: { chart: { kind: 'bar', categories: ['A3'] } } })
    expect(hasTestid('free-cell-chart-problem')).toBe(true)
    expect(text()).toContain('序列')
  })

  /// 服务端会「一律报错并点名」，设计期先说省一轮往返
  it('饼图配多条序列要提示', async () => {
    await mount({
      value: '华东',
      model: {
        chart: { kind: 'pie', categories: ['A3'], series: [{ from: 'B3' }, { from: 'C3' }] },
      },
    })
    expect(hasTestid('free-cell-chart-problem')).toBe(true)
    expect(text()).toContain('饼图')
  })

  it('柱状图配多条序列不提示（合法）', async () => {
    await mount({
      value: '华东',
      model: {
        chart: { kind: 'bar', categories: ['A3'], series: [{ from: 'B3' }, { from: 'C3' }] },
      },
    })
    expect(hasTestid('free-cell-chart-problem'), '多序列柱状图是合法的').toBe(false)
  })

  it('类目留空不提示（服务端回落用序号 1、2…）', async () => {
    await mount({ value: '华东', model: { chart: { kind: 'bar', series: [{ from: 'B3' }] } } })
    expect(hasTestid('free-cell-chart-problem')).toBe(false)
  })

  it('认不出的图表类型要点名', async () => {
    await mount({
      value: '华东',
      model: { chart: { kind: 'radar', categories: ['A3'], series: [{ from: 'B3' }] } },
    })
    expect(text()).toContain('radar')
    expect(text()).toContain('bar')
  })

  /// 服务端只出一个（被盖住的连编都不编），界面上必须说清
  it('同时设了图片和图表时提示优先级', async () => {
    await mount({
      value: '华东',
      model: {
        image: { from: 'literal', src: 'data:image/png;base64,aGVsbG8=' },
        chart: { kind: 'bar', categories: ['A3'], series: [{ from: 'B3' }] },
      },
    })
    expect(hasTestid('free-cell-graphic-conflict')).toBe(true)
    expect(text()).toContain('图表')
  })

  it('动图表不该顺手动到 model 的其它字段', async () => {
    await mount({ value: '华东', model: { ds: 'ds1', field: 'amount', style: { bold: true } } })
    await pickOption('free-cell-chart-kind', '折线图')
    expect(latest?.model?.ds).toBe('ds1')
    expect(latest?.model?.field).toBe('amount')
    expect(latest?.model?.style?.bold).toBe(true)
  })
})
