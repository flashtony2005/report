/**
 * P5.6 —— DataImportModal + store.importTable 测试
 *
 * store 侧：内嵌数据表格落地（列宽均分 / field 前缀 / 数值尾行 / 选中 / dirty / 撤销）
 * 组件侧：选文件解析 → 预览（删列 / 删行 / 改标题）→ 确认导入
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { useDesignerStore, resetDesignerStores } from '../stores/designer'
import { resetPreviewDataCache } from '../stores/dataSource'
import { DataImportModalInner } from './DataImportModal'
import type { TableControl } from '@/types/control'
import type { ParsedData } from '@/design/utils/data-import'

vi.mock('@/design/utils/data-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/design/utils/data-import')>()
  return {
    ...actual,
    parseDataFile: (...args: Parameters<typeof actual.parseDataFile>) => parseDataFileMock(...args),
  }
})

const parseDataFileMock = vi.fn(async (_file: File): Promise<ParsedData> => {
  throw new Error('not stubbed')
})

let host: HTMLDivElement
let root: { render: (el: React.ReactElement) => void; unmount: () => void } | null = null

function body(): HTMLElement {
  return document.body
}

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(DataImportModalInner, { show: true, onClose: () => {} }))
    await new Promise((r) => setTimeout(r, 60))
  })
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...body().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetDesignerStores()
  resetPreviewDataCache()
  parseDataFileMock.mockReset()
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount()
      await new Promise((r) => setTimeout(r, 60))
    })
    root = null
  }
})

describe('designer store · importTable', () => {
  it('落地内嵌数据表格：列宽均分 / items[].field / 数值尾行 / 选中 / dirty', () => {
    const s0 = useDesignerStore.getState()
    act(() => {
      s0.importTable({
        columns: [
          { key: 'name', title: '品名' },
          { key: 'price', title: '金额' },
        ],
        records: [
          { name: 'A', price: 10 },
          { name: 'B', price: 5 },
        ],
        sourceName: 'demo.csv',
      })
    })
    const s = useDesignerStore.getState()
    expect(s.controls).toHaveLength(1)
    const t = s.controls[0] as TableControl
    expect(t.type).toBe('table')
    expect(t.data).toEqual([
      { name: 'A', price: 10 },
      { name: 'B', price: 5 },
    ])
    expect(t.columns[0]!.field).toBe('items[].name')
    expect(t.columns[0]!.title).toBe('品名')
    // 列宽 = 内容区宽度均分（A4 210 - 2×10 边距 = 190 → 每列 95）
    expect(t.columns[0]!.width).toBe(95)
    expect(t.columns[1]!.width).toBe(95)
    // 金额列 → seedSummaryTail 已植入合计尾行
    expect(t.columns.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(t)).toContain('合计')
    expect(s.selectedIds).toContain(t.id)
    expect(s.dirty).toBe(true)
  })

  it('撤销 importTable：控件移除、重做恢复', () => {
    const s0 = useDesignerStore.getState()
    act(() => {
      s0.importTable({
        columns: [{ key: 'a', title: 'A' }],
        records: [{ a: 1 }],
      })
    })
    let id = ''
    act(() => {
      id = (useDesignerStore.getState().controls[0] as TableControl).id
      useDesignerStore.getState().undo()
    })
    expect(useDesignerStore.getState().controls.some((c) => c.id === id)).toBe(false)
    act(() => {
      useDesignerStore.getState().redo()
    })
    expect(useDesignerStore.getState().controls.some((c) => c.id === id)).toBe(true)
    void id
  })
})

describe('DataImportModal', () => {
  function stubFile(name: string): File {
    return new File(['x'], name, { type: 'text/plain' })
  }

  async function chooseFile(name = 'stock.csv'): Promise<void> {
    const input = body().querySelector<HTMLInputElement>('input[type="file"]')!
    await act(async () => {
      parseDataFileMock.mockResolvedValue({
        sourceName: name,
        columns: [
          { key: 'name', title: 'name' },
          { key: 'qty', title: 'qty' },
        ],
        rows: [
          { name: '苹果', qty: 3 },
          { name: '香蕉', qty: 7 },
          { name: '橙子', qty: 12 },
        ],
      })
      Object.defineProperty(input, 'files', { value: [stubFile(name)], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
    })
  }

  it('选文件 → 预览标题 / 统计 / 行数', async () => {
    await mount()
    await chooseFile()
    expect(body().textContent).toContain('导入数据 · stock.csv')
    expect(body().textContent).toContain('2 列 · 3 行')
    expect(body().querySelectorAll('.import-preview-table tbody tr')).toHaveLength(3)
  })

  it('删列 / 删行 / 改标题 / 全部删行提示', async () => {
    await mount()
    await chooseFile()
    // 删第一列（name）
    await act(async () => {
      ;(body().querySelector('.th-del') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(body().textContent!.replace(/\s/g, '')).toContain('1列·3行')
    // 删第一行（取消勾选）
    const checkbox = body().querySelector<HTMLInputElement>('.import-preview-table tbody input')!
    await act(async () => {
      checkbox.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(body().textContent!.replace(/\s/g, '')).toContain('已删1行')
    // 全部删行 → 空态提示
    await act(async () => {
      findButton('删除全部行')!.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(body().textContent).toContain('没有可显示的行')
    // 保留全部行 → 恢复全部行（已删计数清零）
    await act(async () => {
      findButton('保留全部行')!.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(body().textContent!.replace(/\s/g, '')).toContain('1列·3行')
    // 改标题：仅剩 qty 列
    const titleInput = body().querySelector<HTMLInputElement>('.th-title-input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(titleInput, '品名')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(titleInput.value).toBe('品名')
  })

  it('确认导入 → store.importTable 收到过滤后的记录并关闭', async () => {
    await mount()
    await chooseFile()
    // 删第一行
    const checkbox = body().querySelector<HTMLInputElement>('.import-preview-table tbody input')!
    await act(async () => {
      checkbox.click()
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      findButton('确认导入')!.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    const s = useDesignerStore.getState()
    expect(s.controls).toHaveLength(1)
    const t = s.controls[0] as TableControl
    expect(t.data).toEqual([
      { name: '香蕉', qty: 7 },
      { name: '橙子', qty: 12 },
    ])
    expect(t.columns[0]!.title).toBe('name')
  })

  it('解析失败 → 错误提示，不进入预览态', async () => {
    await mount()
    const input = body().querySelector<HTMLInputElement>('input[type="file"]')!
    await act(async () => {
      parseDataFileMock.mockRejectedValue(new Error('文件中没有可解析的数据行'))
      Object.defineProperty(input, 'files', { value: [stubFile('bad.csv')], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(body().textContent).toContain('文件中没有可解析的数据行')
    expect(body().querySelector('.import-preview-table')).toBeNull()
  })

  it('全部删列后确认 → 提示至少保留一列，不落地控件', async () => {
    await mount()
    await chooseFile()
    await act(async () => {
      ;(body().querySelector('.th-del') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 20))
      ;(body().querySelector('.th-del') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 20))
      findButton('确认导入')!.click()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(useDesignerStore.getState().controls).toHaveLength(0)
  })
})
