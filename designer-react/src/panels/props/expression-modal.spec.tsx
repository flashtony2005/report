/**
 * expression-modal.spec —— P4.1 React 端 ExpressionModal 端到端
 *
 * 覆盖链路：antd Modal 真渲染 → 目录渲染/搜索过滤 → 点击插入（含光标逻辑走
 * 共享 insertSnippetAtCursor）→ 实时预览求值（共享 evalExpressionPreview）→
 * 颜色 chip 插入 → 确定回写。共享逻辑本身的行为断言在 Vue 端
 * expression-logic.spec.ts（20 用例），此处复核 React import 链与交互。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useDataSourceStore } from '../../stores/dataSource'
import ExpressionModal from './ExpressionModal'

/** antd Modal 渲染到 document.body 的 portal，断言统一走 body */
const body = () => document.body

/** 用原生 setter 触发受控 textarea 的 input 事件 */
function typeTextarea(ta: HTMLTextAreaElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!
  set.call(ta, value)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ExpressionModal（React 版）', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(() => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useDataSourceStore.getState().$reset()
  })

  async function renderModal(props: Partial<Parameters<typeof ExpressionModal>[0]> = {}) {
    // 真实初始化 mock 数据源（previewData 由 FieldDef.sample 合成，无法直接注入）
    await act(async () => {
      await useDataSourceStore.getState().init()
    })
    let confirmed = ''
    const el = createElement(ExpressionModal, {
      show: true,
      expression: '',
      onCancel: () => {},
      onConfirm: (v: string) => {
        confirmed = v
      },
      ...props,
    })
    await act(async () => {
      root.render(el)
    })
    return { getConfirmed: () => confirmed }
  }

  it('函数目录渲染：分类与函数条目可见', async () => {
    await renderModal()
    const text = body().textContent!
    expect(text).toContain('页面信息')
    expect(text).toContain('页码')
    expect(text).toContain('合计统计')
    expect(text).toContain('求和')
  })

  it('搜索过滤：输入「求和」后仅命中条目保留', async () => {
    await renderModal()
    const search = body().querySelector<HTMLInputElement>('input[placeholder="搜索函数 / 说明"]')
    expect(search, '搜索框存在').toBeTruthy()
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      set.call(search!, '求和')
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const text = body().textContent!
    expect(text).toContain('求和')
    expect(text).not.toContain('页面信息')
  })

  it('点击函数条目把 snippet 插入表达式输入框', async () => {
    await renderModal()
    const fnBtn = [...body().querySelectorAll<HTMLButtonElement>('button.expr-fn')].find((b) =>
      b.textContent!.includes('{{page}}'),
    )
    expect(fnBtn, '「页码」条目存在').toBeTruthy()
    await act(async () => {
      fnBtn!.click()
    })
    const ta = body().querySelector<HTMLTextAreaElement>('textarea.expr-input')!
    expect(ta.value).toBe('{{page}}')
  })

  it('实时预览：输入表达式后显示求值结果（order.total = 12800.5）', async () => {
    await renderModal()
    const ta = body().querySelector<HTMLTextAreaElement>('textarea.expr-input')!
    await act(async () => {
      typeTextarea(ta, '{{order.total}}')
    })
    expect(body().textContent).toContain('12800.5')
  })

  it('点击预设色块插入带引号的 hex 字面量', async () => {
    await renderModal()
    const chip = body().querySelector<HTMLButtonElement>(
      'button.expr-color-chip[title*="#D93636"]',
    )
    expect(chip, '红色色块存在').toBeTruthy()
    await act(async () => {
      chip!.click()
    })
    const ta = body().querySelector<HTMLTextAreaElement>('textarea.expr-input')!
    expect(ta.value).toBe("'#D93636'")
  })

  it('点「确定」回写当前表达式', async () => {
    const { getConfirmed } = await renderModal({ expression: '{{page}}' })
    // antd 按钮两字间插空格 → 文本是「确 定」
    const okBtn = [...body().querySelectorAll<HTMLButtonElement>('button.ant-btn-primary')].find(
      (b) => b.textContent!.includes('确'),
    )
    expect(okBtn, '确定按钮存在').toBeTruthy()
    await act(async () => {
      okBtn!.click()
    })
    expect(getConfirmed()).toBe('{{page}}')
  })

  it('字段 tab：展示数据源字段并支持插入绑定', async () => {
    await renderModal()
    // 切到「字段」tab（Segmented 的 label 点击）
    const segLabel = [...body().querySelectorAll<HTMLElement>('.ant-segmented-item')].find(
      (el) => el.textContent === '字段',
    )
    expect(segLabel, '字段 tab 存在').toBeTruthy()
    await act(async () => {
      segLabel!.click()
    })
    const text = body().textContent!
    expect(text).toContain('单据编号')
    expect(text).toContain('order.orderNo')
  })
})
