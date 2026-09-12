/**
 * ExportDialog（P5.4）—— 导出弹窗测试
 *
 * 覆盖：格式单选 / 明细行数 / 文件名 / 导出调用 exportDocument+downloadBlob / 成功后关闭
 * 导出引擎 '@/core/export-engine' 打桩（真实引擎依赖字体与 Blob 组装，另行覆盖）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ExportDialog } from './ExportDialog'
import { useUiStore } from '../stores/ui'
import { resetDesignerStores } from '../stores/designer'
import { resetPreviewDataCache } from '../stores/dataSource'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const exportDocument = vi.fn()
const downloadBlob = vi.fn()
vi.mock('@/core/export-engine', () => ({
  exportDocument: (...args: unknown[]) => exportDocument(...args),
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}))

const body = () => document.body

async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

let root: Root
let host: HTMLElement

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(ExportDialog as unknown as () => ReactElement))
  })
}

describe('ExportDialog（导出弹窗）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    resetDesignerStores()
    resetPreviewDataCache()
    useUiStore.setState({ exportOpen: false })
    exportDocument.mockReset()
    downloadBlob.mockReset()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    return async () => {
      await act(async () => {
        root.unmount()
      })
      // antd message 会延迟挂载 React root，等调度器跑完再拆环境，
      // 否则 scheduler 的 Immediate 在 happy-dom 拆除后执行报 window is not defined
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })
      host.remove()
    }
  })

  it('打开后渲染格式单选 / 明细行数 / 文件名', async () => {
    useUiStore.setState({ exportOpen: true })
    await mount()
    await waitFor(() => body().textContent!.includes('导出文档'))
    const text = body().textContent!
    expect(text).toContain('PDF（单文件 · 多页）')
    expect(text).toContain('JPG（每页一张）')
    expect(text).toContain('SVG（矢量 · 单文件多页）')
    expect(text).toContain('HTML（矢量 · 自包含单文件）')
    expect(text).toContain('明细行数')
    expect((body().querySelector('[data-testid="export-filename"]') as HTMLInputElement).value).toBe(
      '销售出库单',
    )
  })

  it('点击导出：exportDocument 收到模板/数据/文件名，downloadBlob 逐个下载，成功后关闭', async () => {
    useUiStore.setState({ exportOpen: true })
    exportDocument.mockResolvedValue({
      blobs: [new Blob(['a']), new Blob(['b'])],
      filenames: ['doc-1.jpg', 'doc-2.jpg'],
    })
    await mount()
    await waitFor(() => body().textContent!.includes('导出文档'))

    const exportBtn = [...body().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.replace(/\s/g, '') === '导出',
    )!
    await act(async () => {
      exportBtn.click()
    })

    await waitFor(() => exportDocument.mock.calls.length > 0)
    await act(async () => {
      await Promise.resolve()
    })
    const req = exportDocument.mock.calls[0]![0] as {
      template: unknown
      data: Record<string, unknown>
      output: { pageDecoration: { backgroundColor: string } }
    }
    expect(req.template).toBeTruthy()
    expect(req.data).toEqual({})
    expect(req.output.pageDecoration.backgroundColor).toBe('#ffffff')
    expect(exportDocument.mock.calls[0]![1]).toBe('pdf')
    expect(exportDocument.mock.calls[0]![2]).toEqual({ filename: '销售出库单' })
    expect(downloadBlob).toHaveBeenCalledTimes(2)
    expect(downloadBlob.mock.calls[0]![1]).toBe('doc-1.jpg')
    expect(useUiStore.getState().exportOpen).toBe(false)
  })

  it('导出失败：弹窗保持打开，不触发下载', async () => {
    useUiStore.setState({ exportOpen: true })
    exportDocument.mockRejectedValue(new Error('boom'))
    await mount()
    await waitFor(() => body().textContent!.includes('导出文档'))

    const exportBtn = [...body().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.replace(/\s/g, '') === '导出',
    )!
    await act(async () => {
      exportBtn.click()
    })
    await waitFor(() => exportDocument.mock.calls.length > 0)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(useUiStore.getState().exportOpen).toBe(true)
  })

  it('点击取消：仅关闭弹窗，不调用导出引擎', async () => {
    useUiStore.setState({ exportOpen: true })
    await mount()
    await waitFor(() => body().textContent!.includes('导出文档'))

    const cancelBtn = [...body().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.replace(/\s/g, '') === '取消',
    )!
    await act(async () => {
      cancelBtn.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(exportDocument).not.toHaveBeenCalled()
    expect(useUiStore.getState().exportOpen).toBe(false)
  })
})
