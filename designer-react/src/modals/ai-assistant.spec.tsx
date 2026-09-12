/**
 * P5.9 —— AiAssistantModal（AI 设计助手抽屉）测试
 *
 * 覆盖：未配置态（去设置/试用示例）/ 已配置对话流（chip 发送 → 生成 → 模板卡 → 应用到画布）/
 * 错误呈现 / 选区改写 diff 应用（原位改/新增/删）。generateTemplate 与 ai-settings 全 mock，
 * 共享纯逻辑已由 Vue 端 ai-assistant-logic.spec.ts 覆盖。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { createRoot, type Root } from 'react-dom/client'
import { resetDesignerStores, useDesignerStore } from '../stores/designer'
import { resetPreviewDataCache } from '../stores/dataSource'
import { AiAssistantModal } from './AiAssistantModal'
import { antdMessage } from '../ui-confirm'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'

/* ------------------------------ mock：AI 生成 / 配置 / 消息 ------------------------------ */

const generateMock = vi.fn()

vi.mock('@/ai/generate', () => ({
  generateTemplate: (...a: unknown[]) => generateMock(...(a as [])),
}))

vi.mock('@/config/ai-settings', () => ({
  isAiConfigured: vi.fn(() => true),
  readAiSettings: vi.fn(() => ({ baseURL: 'https://x/v1', apiKey: 'k', model: 'm', enabled: true })),
}))

vi.mock('../ui-confirm', () => ({
  antdMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  confirmDialog: vi.fn(async () => true),
}))

function body(): HTMLElement {
  return document.body
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...body().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  )
}

/** 用真实 demo 模板造数据（loadTemplate 有 assertTemplate 校验，极简结构会被拒） */
function makeTpl(): TemplateData<AnyControl> {
  return createDemoTemplate()
}

const ctrl = (id: string): AnyControl =>
  ({ id, type: 'text', left: 10, top: 10, width: 30, height: 8 }) as unknown as AnyControl

let host: HTMLDivElement
let root: Root
let onClose: () => void
let onOpenSettings: () => void

async function mount(show = true): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onClose = vi.fn()
  onOpenSettings = vi.fn()
  await act(async () => {
    root.render(
      createElement(AiAssistantModal, { show, onClose, onOpenSettings }),
    )
    await new Promise((r) => setTimeout(r, 60))
  })
}

beforeEach(async () => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetDesignerStores()
  resetPreviewDataCache()
  generateMock.mockReset()
  // 测试 1 会把 configured 关掉，每个用例前复位（mock 工厂默认 true）
  const { isAiConfigured } = await import('@/config/ai-settings')
  vi.mocked(isAiConfigured).mockReturnValue(true)
  vi.mocked(antdMessage.success).mockClear()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await new Promise((r) => setTimeout(r, 60))
  })
  document.body.innerHTML = ''
})

/* ------------------------------ 用例 ------------------------------ */

describe('AiAssistantModal', () => {
  it('未配置态：提示 + 去设置回调 + 试用示例载入 demo 模板并关闭', async () => {
    const { isAiConfigured } = await import('@/config/ai-settings')
    vi.mocked(isAiConfigured).mockReturnValue(false)
    await mount()
    expect(body().textContent).toContain('尚未配置 AI')
    await act(async () => {
      findButton('去设置')!.click()
    })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    await act(async () => {
      findButton('试用示例')!.click()
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(useDesignerStore.getState().templateName).toBe('AI 示例模板')
    expect(onClose).toHaveBeenCalled()
    // 空态 chips 禁用（未配置）
    expect(findButton('清空')!.disabled).toBe(true)
  })

  it('已配置：chip 发送 → 生成模板卡（尺寸·控件数）→ 应用到画布', async () => {
    generateMock.mockResolvedValue({ ok: true, data: makeTpl() })
    await mount()
    const chip = [...body().querySelectorAll<HTMLButtonElement>('.ai-chip')].find((b) =>
      b.textContent!.includes('快递面单'),
    )!
    expect(chip).toBeTruthy()
    await act(async () => {
      chip.click()
      await new Promise((r) => setTimeout(r, 300))
    })
    // 请求带 settings；消息流有 user 提问
    expect(generateMock).toHaveBeenCalledTimes(1)
    const req = generateMock.mock.calls[0][0] as { prompt: string; settings: unknown }
    expect(req.prompt).toContain('快递面单')
    expect(body().querySelector('.ai-row.user')?.textContent).toContain('快递面单')
    // 模板卡：共享 templateMeta 摘要（demo 模板的实际尺寸与控件数）
    const card = body().querySelector('[data-testid="ai-tpl-card"]')!
    expect(card.textContent).toContain('模板已生成')
    expect(card.textContent).toMatch(/\d+×\d+ mm · \d+ 个控件/)
    // 应用到画布
    await act(async () => {
      findButton('应用到画布')!.click()
      await new Promise((r) => setTimeout(r, 40))
    })
    const s = useDesignerStore.getState()
    expect(s.templateName).toBe('AI 生成模板')
    expect(s.currentTemplateId).toMatch(/^ai-/)
    expect(antdMessage.success).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('生成失败：气泡内错误文案呈现', async () => {
    generateMock.mockResolvedValue({ ok: false, error: '模型超时' })
    await mount()
    await act(async () => {
      ;(body().querySelector('[data-testid="ai-input"]') as HTMLTextAreaElement).focus()
    })
    const input = body().querySelector('[data-testid="ai-input"]') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(input, '做一个测试模板')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
      findButton('发送')!.click()
      await new Promise((r) => setTimeout(r, 120))
    })
    const err = body().querySelector('[data-testid="ai-error"]')!
    expect(err.textContent).toContain('模型超时')
  })

  it('C 选区改写：diff 应用（原位改 / 新增 / 删除）', async () => {
    // 画布上选中 2 个控件：a1、a2
    useDesignerStore.setState({
      controls: [ctrl('a1'), ctrl('a2')],
      selectedIds: ['a1', 'a2'],
    })
    // AI 返回：a1 原位改（换宽）、a3 新增；a2 被删
    generateMock.mockResolvedValue({
      ok: true,
      controls: [ctrl('a1'), { ...ctrl('a3'), width: 40 } as unknown as AnyControl],
    })
    await mount()
    // 选区模式下出现「选中部分」模式按钮
    await act(async () => {
      ;[...body().querySelectorAll<HTMLButtonElement>('.ai-mode-btn')]
        .find((b) => b.textContent!.includes('选中部分'))!
        .click()
      await new Promise((r) => setTimeout(r, 20))
    })
    const input = body().querySelector('[data-testid="ai-input"]') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(input, '对齐并改风格')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
      findButton('发送')!.click()
      await new Promise((r) => setTimeout(r, 120))
    })
    // selectedControls 传给了 generate
    const req = generateMock.mock.calls[0][0] as { selectedControls: AnyControl[] }
    expect(req.selectedControls.map((c) => c.id)).toEqual(['a1', 'a2'])
    // 应用：替换选中控件
    await act(async () => {
      findButton('替换选中控件')!.click()
      await new Promise((r) => setTimeout(r, 40))
    })
    const s = useDesignerStore.getState()
    const ids = s.controls.map((c) => c.id)
    expect(ids).toContain('a1')
    expect(ids).toContain('a3')
    expect(ids).not.toContain('a2')
    expect(antdMessage.success).toHaveBeenCalledWith(
      expect.stringContaining('改 1 / 加 1 / 删 1'),
    )
    expect(onClose).toHaveBeenCalled()
  })
})
