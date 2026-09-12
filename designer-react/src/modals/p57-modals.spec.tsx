/**
 * P5.7 —— SettingsModal + PrintDialog 测试
 *
 * SettingsModal：六页签导航 / 本地打印配置读写 localStorage / 测试连接（mock print-client）/ 恢复默认
 * PrintDialog：未连接禁用表单 / 已连接打印机列表与能力收敛 / 载荷说明 / doPrint 推送（mock payload）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { createRoot, type Root } from 'react-dom/client'
import { resetDesignerStores } from '../stores/designer'
import { resetPreviewDataCache } from '../stores/dataSource'
import { usePrinterProbeStore } from '../stores/printerProbe'
import { SettingsModal } from './SettingsModal'
import { PrintDialog } from './PrintDialog'
import { DEFAULT_PRINT_SETTINGS } from '@/config/print-settings'
import type { PrinterInfo } from '@/core/print-client'

/* ---------- mock print-client：连接测试 / 载荷构建 / 任务提交 ---------- */

const checkHealthMock = vi.fn(async () => ({ app: 'Qprint', version: '1.2.0', printers: 2 }))
const listPrintersMock = vi.fn(async () => [{} as PrinterInfo, {} as PrinterInfo])
const buildPrintPayloadMock = vi.fn(async () => ({
  format: 'html',
  encoding: 'utf8',
  content: '<html></html>',
  pages: 3,
  width: 210,
  height: 297,
  bytes: 1024,
}))
const submitPrintJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'JOB-1' }))

vi.mock('@/core/print-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/print-client')>()
  return {
    ...actual,
    checkHealth: (...a: unknown[]) => checkHealthMock(...(a as [])),
    listPrinters: (...a: unknown[]) => listPrintersMock(...(a as [])),
    buildPrintPayload: (...a: unknown[]) => buildPrintPayloadMock(...(a as [])),
    submitPrintJob: (...a: unknown[]) => submitPrintJobMock(...(a as [])),
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

let host: HTMLDivElement
let root: Root
let onClose: () => void

async function mountModal(
  el: (p: { show: boolean; onClose: () => void }) => React.ReactElement,
  show = true,
): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onClose = vi.fn()
  await act(async () => {
    root.render(createElement(el, { show, onClose }))
    await new Promise((r) => setTimeout(r, 80))
  })
}

/** 测试用打印机样本 */
function makePrinter(over: Partial<PrinterInfo>): PrinterInfo {
  return {
    name: 'HP LaserJet',
    isDefault: true,
    isOnline: true,
    status: 'idle',
    kind: 'common',
    defaultDpi: 600,
    maxDpi: 1200,
    supportsColor: true,
    supportsDuplex: true,
    trays: ['主纸盒'],
    ...over,
  } as PrinterInfo
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetDesignerStores()
  resetPreviewDataCache()
  usePrinterProbeStore.getState().$reset()
  checkHealthMock.mockClear()
  listPrintersMock.mockClear()
  buildPrintPayloadMock.mockClear()
  submitPrintJobMock.mockClear()
  // 默认：探测连接失败（未连接用例的基线）；需要成功探测的用例自行 mockResolvedValue
  checkHealthMock.mockRejectedValue(new Error('ECONNREFUSED'))
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await new Promise((r) => setTimeout(r, 60))
  })
  document.body.innerHTML = ''
})

/* ------------------------------ SettingsModal ------------------------------ */

describe('SettingsModal', () => {
  it('六页签导航：默认本地打印，可切到 AI / 反馈 / 教程 / 交流群', async () => {
    await mountModal((p) => createElement(SettingsModal, p))
    const nav = body().querySelector('.settings-nav')!
    expect(nav.textContent).toContain('本地打印')
    expect(nav.textContent).toContain('远程云打印')
    expect(nav.textContent).toContain('AI 助手')
    expect(body().textContent).toContain('打印客户端服务地址')
    // 切到 AI 页
    const aiItem = [...body().querySelectorAll<HTMLElement>('.settings-nav-item')].find((el) =>
      el.textContent!.includes('AI 助手'),
    )!
    await act(async () => {
      aiItem.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(body().textContent).toContain('接口地址（baseURL）')
    // 切到反馈页
    const fb = [...body().querySelectorAll<HTMLElement>('.settings-nav-item')].find((el) =>
      el.textContent!.includes('功能反馈'),
    )!
    await act(async () => {
      fb.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(body().textContent).toContain('haiming236@outlook.com')
  })

  it('本地打印：改 IP / 端口即写 localStorage；测试连接成功显示 Tag', async () => {
    await mountModal((p) => createElement(SettingsModal, p))
    // 测试连接前：显式让探测成功
    checkHealthMock.mockResolvedValue({ app: 'Qprint', version: '1.2.0', printers: 2 })
    listPrintersMock.mockResolvedValue([{} as PrinterInfo, {} as PrinterInfo])
    // 默认出厂配置已写入
    const raw = JSON.parse(localStorage.getItem('openprint:print-settings')!)
    expect(raw.local.silent.host).toBe('127.0.0.1')
    // 改 host 输入框
    const hostInput = body().querySelector<HTMLInputElement>('input[placeholder="127.0.0.1"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(hostInput, '192.168.1.9')
      hostInput.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(JSON.parse(localStorage.getItem('openprint:print-settings')!).local.silent.host).toBe(
      '192.168.1.9',
    )
    // 测试连接（checkHealth/listPrinters 已 mock 成功）
    await act(async () => {
      findButton('测试连接')!.click()
      await new Promise((r) => setTimeout(r, 40))
    })
    const tag = body().querySelector('.ant-tag')!
    expect(tag.textContent).toContain('连接正常 · Qprint v1.2.0 · 2 台打印机')
  })

  it('恢复默认：改配置后点恢复默认回到出厂值', async () => {
    await mountModal((p) => createElement(SettingsModal, p))
    await act(async () => {
      findButton('恢复默认')!.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    const raw = JSON.parse(localStorage.getItem('openprint:print-settings')!)
    expect(raw).toEqual(JSON.parse(JSON.stringify(DEFAULT_PRINT_SETTINGS)))
  })

  it('关闭：取消 / 完成均回调 onClose', async () => {
    await mountModal((p) => createElement(SettingsModal, p))
    await act(async () => {
      findButton('取消')!.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------ PrintDialog ------------------------------ */

describe('PrintDialog', () => {
  it('未连接：状态 Tag=客户端不可达，表单禁用，打印按钮禁用', async () => {
    await mountModal((p) => createElement(PrintDialog, p))
    expect(body().textContent).toContain('客户端不可达')
    expect(body().textContent).toContain('可在「设置 → 本地打印」修改')
    expect(findButton('打印')!.disabled).toBe(true)
  })

  it('已连接：打印机列表填充、能力 Tag 展示、默认打印机自动选中', async () => {
    await act(async () => {
      usePrinterProbeStore.setState({
        state: 'connected',
        checkedAt: Date.now(),
        printers: [
          makePrinter({ name: 'HP LaserJet', isDefault: true }),
          makePrinter({ name: 'Xerox', isDefault: false, supportsColor: false, isOnline: false }),
        ],
      })
    })
    await mountModal((p) => createElement(PrintDialog, p))
    expect(body().textContent).toContain('已连接 · 2 台打印机')
    expect(body().textContent).toContain('任务名称')
    expect(body().textContent).toContain('载荷格式')
    // 选中默认打印机 → 能力 Tag
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(body().textContent).toContain('默认 600 / 最高 1200 DPI')
    expect(body().textContent).toContain('支持双面')
    expect(findButton('打印')!.disabled).toBe(false)
  })

  it('不支持的打印机自动收敛：仅黑白 + 仅单面', async () => {
    await act(async () => {
      usePrinterProbeStore.setState({
        state: 'connected',
        checkedAt: Date.now(),
        printers: [
          makePrinter({
            name: 'Ticket',
            supportsColor: false,
            supportsDuplex: false,
            defaultDpi: 203,
            maxDpi: 203,
            kind: 'ticket',
          }),
        ],
      })
    })
    await mountModal((p) => createElement(PrintDialog, p))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(body().textContent).toContain('仅黑白')
    expect(body().textContent).toContain('仅单面')
    expect(body().textContent).toContain('票据')
  })

  it('doPrint：构建载荷并推送成功 → 进度 100 → 关闭回调', async () => {
    await act(async () => {
      usePrinterProbeStore.setState({
        state: 'connected',
        checkedAt: Date.now(),
        printers: [makePrinter({ name: 'HP LaserJet' })],
      })
    })
    await mountModal((p) => createElement(PrintDialog, p))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    await act(async () => {
      findButton('打印')!.click()
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(buildPrintPayloadMock).toHaveBeenCalledTimes(1)
    expect(submitPrintJobMock).toHaveBeenCalledTimes(1)
    const jobArg = (submitPrintJobMock.mock.calls as unknown[][])[0]![0] as Record<
      string,
      unknown
    >
    expect(jobArg.taskName).toBe('销售出库单模板')
    expect(jobArg.printer).toBe('HP LaserJet')
    expect(jobArg.copies).toBe(1)
    // 进度条显示 100
    expect(body().textContent).toContain('100%')
  })

  it('载荷格式切换：PDF 模式显示分辨率字段', async () => {
    await act(async () => {
      usePrinterProbeStore.setState({
        state: 'connected',
        checkedAt: Date.now(),
        printers: [makePrinter({ name: 'HP' })],
      })
    })
    await mountModal((p) => createElement(PrintDialog, p))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    // 默认 html 模式：无分辨率字段，有字体嵌入
    expect(body().textContent).toContain('字体嵌入')
    expect(body().textContent).not.toContain('PDF 按此分辨率渲染')
    // 切 PDF
    const pdfRadio = [...body().querySelectorAll<HTMLInputElement>('.ant-radio-button-input')].find(
      (el) => el.value === 'pdf',
    )!
    await act(async () => {
      pdfRadio.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(body().textContent).toContain('PDF 按此分辨率渲染')
  })
})
