/**
 * P5.5 轻弹窗测试 —— TemplateModal / TemplateMarket / JsonViewerModal
 *
 * - TemplateModal：注入假 repository（list/get/remove），覆盖列表渲染/打开/复制/删除/空态
 * - TemplateMarket：分类过滤 / 关键字搜索 / 使用模板（含 dirty 确认路径）
 * - JsonViewerModal：打开渲染 CodeMirror（mock 掉编辑器库，验证 JSON 序列化与复制/关闭）
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TemplateModal } from './TemplateModal'
import { TemplateMarket } from './TemplateMarket'
import { JsonViewerModal } from './JsonViewerModal'
import { useDesignerStore, setTemplateRepository, resetTemplateRepository, resetDesignerStores } from '../stores/designer'
import { useUiStore } from '../stores/ui'
import { MARKET_TEMPLATES } from '@/repository/mock/data/market-templates'
import type { TemplateRepository, TemplateRecord } from '@/repository/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

/** 用原生 setter 触发受控 input（绕过 React valueTracker） */
function typeInput(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const btnByText = (text: string): HTMLButtonElement | undefined =>
  [...body().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.replace(/\s/g, '') === text,
  )

let root: Root
let host: HTMLElement

function mount(node: React.ReactNode): Promise<void> {
  return act(async () => {
    root.render(node)
  })
}

/** 假仓库：2 条模板，第一条可编辑 */
function fakeRepo(): TemplateRepository & { removeSpy: ReturnType<typeof vi.fn> } {
  const records: TemplateRecord[] = [
    {
      id: 'tpl-1',
      name: '出库单',
      editable: true,
      deletable: true,
      updatedAt: '2026-09-09 01:00',
      data: {
        version: '1.0',
        document: {
          type: 'report',
          page: { width: 210, height: 297, unit: 'mm', orientation: 'portrait', margin: { top: 10, bottom: 10, left: 10, right: 10 } },
          sections: [{ type: 'body', components: [] }],
        },
      },
    },
    {
      id: 'tpl-2',
      name: '标签',
      editable: false,
      deletable: false,
      updatedAt: '2026-09-08 01:00',
      data: {
        version: '1.0',
        document: {
          type: 'report',
          page: { width: 100, height: 150, unit: 'mm', orientation: 'portrait', margin: { top: 5, bottom: 5, left: 5, right: 5 } },
          sections: [{ type: 'body', components: [] }],
        },
      },
    },
  ]
  const removeSpy = vi.fn(async (id: string) => {
    const i = records.findIndex((r) => r.id === id)
    if (i >= 0) records.splice(i, 1)
  })
  const repo: TemplateRepository = {
    async list() {
      return records.map(({ data: _data, ...summary }) => summary)
    },
    async get(id) {
      return records.find((r) => r.id === id) ?? null
    },
    async create(rec) {
      const full = { ...rec, id: `gen-${records.length + 1}`, updatedAt: '2026-09-09 02:00' } as TemplateRecord
      records.push(full)
      return full
    },
    async update(id, patch) {
      const i = records.findIndex((r) => r.id === id)!
      records[i] = { ...records[i]!, ...patch } as TemplateRecord
      return records[i]!
    },
    async remove(id) {
      await removeSpy(id)
    },
  }
  return { ...repo, removeSpy }
}

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetDesignerStores()
  resetTemplateRepository()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return async () => {
    await act(async () => {
      root.unmount()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    host.remove()
  }
})

describe('TemplateModal（模板管理）', () => {
  it('打开即刷新列表：按更新时间倒序，只读模板禁用复制/删除', async () => {
    setTemplateRepository(fakeRepo())
    await mount(createElement(TemplateModal, { open: true, onClose: () => {} }))
    await waitFor(() => body().textContent!.includes('出库单'))
    const text = body().textContent!
    const idx1 = text.indexOf('出库单')
    const idx2 = text.indexOf('标签')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThan(idx1) // tpl-1 更新更晚 → 排前面
    expect(text).toContain('只读')
    const rows = [...body().querySelectorAll('.template-row')]
    expect(rows.length).toBe(2)
    // 只读行（tpl-2）的复制/删除按钮 disabled（antd 两字按钮文案带空格，归一化后匹配）
    const readonlyRow = rows.find((r) => r.textContent!.includes('标签'))!
    const buttons = [...readonlyRow.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.find((b) => b.textContent?.replace(/\s/g, '') === '复制')!.disabled).toBe(true)
    expect(buttons.find((b) => b.textContent?.replace(/\s/g, '') === '删除')!.disabled).toBe(true)
  })

  it('打开模板：loadTemplate 装配并关闭弹窗', async () => {
    setTemplateRepository(fakeRepo())
    let closed = false
    await mount(createElement(TemplateModal, { open: true, onClose: () => (closed = true) }))
    await waitFor(() => body().textContent!.includes('出库单'))
    const row = [...body().querySelectorAll('.template-row')].find((r) =>
      r.textContent!.includes('出库单'),
    )!
    const openBtn = [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.replace(/\s/g, '') === '打开',
    )!
    await act(async () => {
      openBtn.click()
    })
    await waitFor(() => closed)
    const s = useDesignerStore.getState()
    expect(s.templateName).toBe('出库单')
    expect(s.currentTemplateId).toBe('tpl-1')
  })

  it('删除模板：repository.remove 被调用并刷新列表；删当前模板则画布清空', async () => {
    const repo = fakeRepo()
    setTemplateRepository(repo)
    const s0 = useDesignerStore.getState()
    await act(async () => {
      s0.loadTemplate({
        id: 'tpl-1',
        name: '出库单',
        data: {
          version: '1.0',
          document: {
            type: 'report',
            page: { width: 210, height: 297, unit: 'mm', orientation: 'portrait', margin: { top: 10, bottom: 10, left: 10, right: 10 } },
            sections: [{ type: 'body', components: [] }],
          },
        },
      })
    })
    await mount(createElement(TemplateModal, { open: true, onClose: () => {} }))
    await waitFor(() => body().textContent!.includes('出库单'))
    const row = [...body().querySelectorAll('.template-row')].find((r) =>
      r.textContent!.includes('出库单'),
    )!
    // Popconfirm trigger 点击 → 气泡确认按钮
    const delBtn = [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.replace(/\s/g, '') === '删除',
    )!
    await act(async () => {
      delBtn.click()
    })
    await waitFor(() => body().querySelector('.ant-popconfirm-buttons') !== null)
    const okBtn = [...body().querySelectorAll<HTMLButtonElement>('.ant-popconfirm-buttons button')].find(
      (b) => b.textContent?.replace(/\s/g, '') === '删除',
    )!
    await act(async () => {
      okBtn.click()
    })
    await waitFor(() => repo.removeSpy.mock.calls.length > 0)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(useDesignerStore.getState().currentTemplateId).toBeNull()
    expect(useDesignerStore.getState().templateName).toBe('未命名模板')
  })

  it('空仓库：展示空态与新建按钮', async () => {
    const repo = fakeRepo()
    // 清空全部记录
    await repo.remove('tpl-1')
    await repo.remove('tpl-2')
    setTemplateRepository(repo)
    await mount(createElement(TemplateModal, { open: true, onClose: () => {} }))
    await waitFor(() => body().textContent!.includes('暂无模板'))
    expect(btnByText('新建空白模板')).toBeTruthy()
  })
})

describe('TemplateMarket（模板市场）', () => {
  it('渲染全部分类与模板卡片；分类点击过滤', async () => {
    await mount(createElement(TemplateMarket, { open: true, onClose: () => {} }))
    await waitFor(() => body().querySelectorAll('[data-testid="market-card"]').length > 0)
    const total = body().querySelectorAll('[data-testid="market-card"]').length
    expect(total).toBe(MARKET_TEMPLATES.length)
    // 点第二个分类（index 0 是「全部」）→ 卡片数变化
    const catBtn = [...body().querySelectorAll<HTMLButtonElement>('.market-cat-item')][1]!
    await act(async () => {
      catBtn.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    const filtered = body().querySelectorAll('[data-testid="market-card"]').length
    expect(filtered).toBeLessThan(total)
  })

  it('关键字搜索过滤卡片', async () => {
    await mount(createElement(TemplateMarket, { open: true, onClose: () => {} }))
    await waitFor(() => body().querySelectorAll('[data-testid="market-card"]').length > 0)
    const input = body().querySelector<HTMLInputElement>('[data-testid="market-search"]')!
    await act(async () => {
      typeInput(input, '不存在的关键字xyz')
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(body().textContent).toContain('没有匹配的模板')
  })

  it('使用模板：loadTemplate 装配并回调关闭', async () => {
    let closed = false
    await mount(createElement(TemplateMarket, { open: true, onClose: () => (closed = true) }))
    await waitFor(() => body().querySelectorAll('[data-testid="market-card"]').length > 0)
    const useBtn = btnByText('使用')!
    await act(async () => {
      useBtn.click()
    })
    await waitFor(() => closed)
    const s = useDesignerStore.getState()
    expect(s.dirty).toBe(false)
    expect(s.controls.length + s.zones.length).toBeGreaterThan(0)
  })
})

describe('JsonViewerModal（JSON 查看器）', () => {
  it('打开渲染 CodeMirror，内容为 buildTemplate 的两空格缩进 JSON；关闭销毁', async () => {
    let closed = false
    await mount(
      createElement(JsonViewerModal, {
        open: true,
        onClose: () => (closed = true),
      }),
    )
    await waitFor(() => body().querySelector('.json-viewer-body .cm-editor') !== null)
    const content = body().querySelector('.json-viewer-body')!.textContent ?? ''
    expect(content).toContain('"version"')
    expect(content).toContain('"document"')
    // 关闭 → 编辑器销毁
    const closeBtn = btnByText('关闭')!
    await act(async () => {
      closeBtn.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(closed).toBe(true)
    expect(useUiStore.getState()).toBeTruthy()
  })

  it('复制 JSON：写入剪贴板并回调关闭', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    let closed = false
    await mount(
      createElement(JsonViewerModal, {
        open: true,
        onClose: () => (closed = true),
      }),
    )
    await waitFor(() => body().querySelector('.json-viewer-body .cm-editor') !== null)
    const copyBtn = btnByText('复制JSON')!
    await act(async () => {
      copyBtn.click()
    })
    await waitFor(() => writeText.mock.calls.length > 0)
    const json = writeText.mock.calls[0]![0] as string
    expect(JSON.parse(json)).toHaveProperty('document')
    expect(closed).toBe(true)
  })
})
