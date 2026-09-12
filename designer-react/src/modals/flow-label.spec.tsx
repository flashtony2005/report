/**
 * P5.8 —— FlowLabelModal（流水标签批量打印）测试
 *
 * 覆盖：上传数据 → 字段自动映射 → 标签预览渲染 → 打印机连接/默认机选择 →
 * 批量打印循环（成功/失败统计）→ 失败重试 → 关闭守卫。
 * render / parseDataFile / print-client 全部 mock，纯逻辑已由共享 spec 覆盖。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { createRoot, type Root } from 'react-dom/client'
import { resetDesignerStores } from '../stores/designer'
import { resetPreviewDataCache } from '../stores/dataSource'
import { usePrinterProbeStore } from '../stores/printerProbe'
import { useUiStore } from '../stores/ui'
import { FlowLabelModal } from './FlowLabelModal'
import type { ParsedData } from '@/design/utils/data-import'
import type { PrinterInfo } from '@/core/print-client'

/* ------------------------------ mock：渲染 / 数据解析 / 打印客户端 ------------------------------ */

const renderMock = vi.fn(async (..._a: unknown[]) => ({ html: '<div class="page">label</div>' }))

/* 静态 message 在环境拆除后异步挂 Notification（window is not defined 噪音），mock 掉 */
vi.mock('../ui-confirm', () => ({
  antdMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/core/sdk', () => ({
  render: (...a: unknown[]) => renderMock(...(a as [])),
}))

const parseDataFileMock = vi.fn(async (): Promise<ParsedData> => ({
  sourceName: 'labels.csv',
  columns: [
    { key: 'no', title: '编号' },
    { key: 'name', title: '名称' },
  ],
  rows: [
    { no: 'A001', name: '张三' },
    { no: 'A002', name: '李四' },
  ],
}))

vi.mock('@/design/utils/data-import', () => ({
  parseDataFile: (...a: unknown[]) => parseDataFileMock(...(a as [])),
}))

const buildPrintPayloadMock = vi.fn(async () => ({
  format: 'html',
  encoding: 'utf8',
  content: '<html></html>',
  pages: 1,
  width: 40,
  height: 30,
  bytes: 512,
}))
const submitPrintJobMock = vi.fn(async () => ({ jobId: 'JOB-1' }))

vi.mock('@/core/print-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/print-client')>()
  return {
    ...actual,
    buildPrintPayload: (...a: unknown[]) => buildPrintPayloadMock(...(a as [])),
    submitPrintJob: (...a: unknown[]) => submitPrintJobMock(...(a as [])),
  }
})

/* 占位符扫描固定返回两个字段（模板内容由 designer store 决定，与弹窗无关） */
vi.mock('@/core/layout-engine/placeholder-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/layout-engine/placeholder-scan')>()
  return {
    ...actual,
    scanTemplatePlaceholders: vi.fn(() => ['no', 'name']),
  }
})

function body(): HTMLElement {
  return document.body
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...body().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  )
}

function makePrinter(over: Partial<PrinterInfo> = {}): PrinterInfo {
  return {
    name: 'Xprinter T2',
    isDefault: true,
    isOnline: true,
    status: 'idle',
    kind: 'label',
    defaultDpi: 203,
    maxDpi: 600,
    supportsColor: false,
    supportsDuplex: false,
    trays: [],
    ...over,
  } as PrinterInfo
}

let host: HTMLDivElement
let root: Root

async function openModal(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(FlowLabelModal))
    await new Promise((r) => setTimeout(r, 60))
  })
  await act(async () => {
    useUiStore.getState().setFlowLabelOpen(true)
    await new Promise((r) => setTimeout(r, 60))
  })
}

/** 模拟选择文件（parseDataFile 已 mock） */
async function uploadFile(): Promise<void> {
  const input = body().querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File(['x'], 'labels.csv', { type: 'text/csv' })
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 80))
  })
}

/** 把探测 store 直接连上（含默认打印机） */
function connectPrinter(over?: Partial<PrinterInfo>): void {
  usePrinterProbeStore.setState({
    state: 'connected',
    errorText: '',
    printers: [makePrinter(over)],
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetDesignerStores()
  resetPreviewDataCache()
  usePrinterProbeStore.getState().$reset()
  renderMock.mockClear()
  parseDataFileMock.mockClear()
  buildPrintPayloadMock.mockClear()
  submitPrintJobMock.mockClear()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    // 留出 antd 静态 message 异步挂载 Notification 的宏任务窗口（老坑）
    await new Promise((r) => setTimeout(r, 200))
  })
  document.body.innerHTML = ''
})

/* ------------------------------ 用例 ------------------------------ */

describe('FlowLabelModal', () => {
  it('打开弹窗：上传区 + 未连接提示 + 开始按钮禁用', async () => {
    await openModal()
    expect(body().textContent).toContain('流水标签批量打印')
    expect(body().textContent).toContain('上传 Excel / CSV / JSON')
    // 未连接：给出一句话提示（真实探测失败的报错文案或兜底文案）
    expect(body().querySelector('.flow-conn-hint')!.textContent).toMatch(/打印客户端|无法连接/)
    const start = findButton('▶开始批量打印')!
    expect(start).toBeTruthy()
    expect(start.disabled).toBe(true)
  })

  it('上传数据：文件条 + 映射行 + 数据表格；自动映射后预览按映射数据渲染', async () => {
    await openModal()
    await uploadFile()
    // 文件条
    expect(body().querySelector('.flow-file-name')!.textContent).toBe('labels.csv')
    expect(body().querySelector('.flow-file-bar .ant-tag')!.textContent).toContain('2 列 · 2 行')
    // 映射行：两个占位符 → 列下拉
    const phTags = [...body().querySelectorAll('.flow-ph-tag')].map((el) => el.textContent)
    expect(phTags).toEqual(['{{no}}', '{{name}}'])
    // 数据表格：表头 + 2 行
    expect(body().querySelectorAll('.flow-data-table tbody tr').length).toBe(2)
    // 自动映射生效（no→no, name→name）：防抖预览渲染收到的 data 已拍平
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320))
    })
    expect(renderMock).toHaveBeenCalled()
    const call = renderMock.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data).toEqual({ no: 'A001', name: '张三' })
    // 行指示器
    expect(body().querySelector('[data-testid="flow-preview-indicator"]')!.textContent).toContain(
      '第 1 / 2 行',
    )
  })

  it('连接打印机后：默认机自动选中（离线机禁用项由 options 控制）、开始按钮启用', async () => {
    await openModal()
    await uploadFile()
    await act(async () => {
      connectPrinter({ name: 'Xprinter T2', isDefault: true })
      await new Promise((r) => setTimeout(r, 60))
    })
    // 连接提示消失，打印机下拉出现且选中默认机
    expect(body().querySelector('.flow-conn-hint')).toBeNull()
    const sel = body().querySelector('.flow-config-row .ant-select')!
    expect(sel.textContent).toContain('Xprinter T2')
    const start = findButton('▶开始批量打印')!
    expect(start.disabled).toBe(false)
  })

  it('批量打印 2 行成功：submitPrintJob 2 次、统计区 2/2、成功数 2', async () => {
    await openModal()
    await uploadFile()
    await act(async () => {
      connectPrinter()
      await new Promise((r) => setTimeout(r, 60))
    })
    await act(async () => {
      findButton('▶开始批量打印')!.click()
      // 2 行 + 1 次间隔(300ms) + 渲染耗时
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(submitPrintJobMock).toHaveBeenCalledTimes(2)
    expect(body().querySelector('[data-testid="flow-done"]')!.textContent).toContain('2 / 2')
    const statNums = [...body().querySelectorAll('.flow-stat-num')].map((el) => el.textContent)
    // [已打印, 成功, 失败, 总时长, 均张, 剩余]
    expect(statNums[1]).toBe('2')
    expect(statNums[2]).toBe('0')
    // 无失败列表
    expect(body().querySelector('.flow-failed')).toBeNull()
  })

  it('打印失败：失败列表 + 行摘要；全部重试成功后统计翻转', async () => {
    submitPrintJobMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    submitPrintJobMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await openModal()
    await uploadFile()
    await act(async () => {
      connectPrinter()
      await new Promise((r) => setTimeout(r, 60))
    })
    await act(async () => {
      findButton('▶开始批量打印')!.click()
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(body().querySelector('[data-testid="flow-done"]')!.textContent).toContain('2 / 2')
    const statNums = [...body().querySelectorAll('.flow-stat-num')].map((el) => el.textContent)
    expect(statNums[2]).toBe('2')
    // 失败折叠面板 + 行摘要（映射列的值）
    const failed = body().querySelector('.flow-failed')!
    expect(failed.textContent).toContain('失败行（2）')
    // 展开面板
    await act(async () => {
      ;[...failed.querySelectorAll('.ant-collapse-header')][0].dispatchEvent(
        new Event('click', { bubbles: true }),
      )
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(failed.textContent).toContain('no=A001')
    expect(failed.textContent).toContain('ECONNREFUSED')
    // 全部重试：mock 改为成功
    submitPrintJobMock.mockResolvedValue({ jobId: 'JOB-2' })
    await act(async () => {
      findButton('全部重试')!.click()
      await new Promise((r) => setTimeout(r, 300))
    })
    const statNums2 = [...body().querySelectorAll('.flow-stat-num')].map((el) => el.textContent)
    expect(statNums2[1]).toBe('2')
    expect(statNums2[2]).toBe('0')
  })

  it('空闲时点关闭：弹窗收起（ui store 归位）', async () => {
    await openModal()
    expect(body().querySelector('[data-testid="flow-label-modal"]')).toBeTruthy()
    await act(async () => {
      findButton('关闭')!.click()
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(useUiStore.getState().flowLabelOpen).toBe(false)
  })
})
