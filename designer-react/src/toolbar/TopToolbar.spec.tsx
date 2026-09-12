/**
 * P5.2 测试：TopToolbar 顶部工具栏（React 版）
 * 覆盖：品牌/模板名/撤销重做/文件菜单（新建·示例·导出·导入·保存·另存为）/
 * 主题切换 / SVIP / 边距参考线 / 预览导出占位 / 快捷键指南（? 键 + 平台切换）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useDesignerStore } from '../stores/designer'
import { useHistoryStore } from '../stores/history'
import { useUiStore } from '../stores/ui'
import { resetDesignerStores } from '../stores/designer'
import { resetTemplateRepository } from '../stores/designer'
import { DEMO_TEMPLATE_NAME } from '@/repository/mock/data/demo-template'

// 模板文件导入/导出打桩：导出断言调用参数；导入喂入示例模板
const exportTemplateFile = vi.fn()
const importTemplateFile = vi.fn()
vi.mock('@/design/utils/template-file', () => ({
  exportTemplateFile: (...args: unknown[]) => exportTemplateFile(...args),
  importTemplateFile: (...args: unknown[]) => importTemplateFile(...args),
}))

// 预览弹窗已挂真组件（P5.4）：渲染引擎与字体打桩，壳层冒烟不跑真实 render
vi.mock('@/core/sdk', () => ({
  render: vi.fn(async () => ({
    html: '<div class="op-page-wrap">page</div>',
    warnings: [],
    pages: 1,
    result: { metrics: { pageWidth: 210 } },
  })),
}))
vi.mock('@/core/fonts/loader', () => ({
  builtinFontFaceCss: () => '',
}))

const body = () => document.body

/** 用原生 setter 触发受控 input 的 input 事件（绕过 React valueTracker） */
function typeInput(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

function renderIn(root: Root, el: ReactElement): void {
  act(() => {
    root.render(el)
  })
}

/** 已挂载的 root：必须在每个用例后卸载，否则 antd 下拉菜单的动效定时器会在环境拆除后触碰 window */
const openRoots: Array<{ root: Root; host: HTMLElement }> = []

async function mount(): Promise<void> {
  const { default: TopToolbar } = await import('./TopToolbar')
  const host = document.createElement('div')
  body().appendChild(host)
  const root = createRoot(host)
  openRoots.push({ root, host })
  renderIn(root, createElement(TopToolbar))
}

// 不卸载会留下上一棵树的 antd Menu 动效任务 happy-dom 拆环境后报 window is not defined
afterEach(async () => {
  await act(async () => {
    for (const { root, host } of openRoots.splice(0)) {
      root.unmount()
      host.remove()
    }
  })
})

/** 展开文件下拉菜单并点选一项（antd Dropdown 悬停触发，菜单 portal 到 body） */
async function pickFileMenu(label: string): Promise<void> {
  const trigger = body().querySelector<HTMLElement>('[data-testid="file-menu"]')!
  await act(async () => {
    // React 的 onMouseEnter 由原生 mouseover 合成，须派发 mouseover 而非 mouseenter
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
  })
  await waitFor(() => body().querySelectorAll('.ant-dropdown-menu-item').length > 0)
  const item = [...body().querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')].find(
    (el) => el.textContent === label,
  )
  expect(item, `菜单项「${label}」应存在`).toBeTruthy()
  await act(async () => {
    item!.click()
    await new Promise((r) => setTimeout(r, 200))
  })
}

/** 在弹窗中按 placeholder 找输入框并输入 */
async function typeModalInput(placeholder: string, value: string): Promise<void> {
  await waitFor(() => !!body().querySelector('.ant-modal'))
  const input = [...body().querySelectorAll<HTMLInputElement>('.ant-modal input')].find(
    (el) => el.placeholder === placeholder,
  )
  expect(input, '弹窗输入框应存在').toBeTruthy()
  await act(async () => {
    typeInput(input!, value)
  })
}

/** 点击弹窗内指定文字的按钮 */
async function clickModalButton(text: string): Promise<void> {
  const btn = [...body().querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
    (el) => el.textContent?.replace(/\s/g, '') === text,
  )
  expect(btn, `弹窗按钮「${text}」应存在`).toBeTruthy()
  await act(async () => {
    btn!.click()
  })
  await waitFor(() => body().querySelector('.ant-modal-root') === null || true)
}

describe('TopToolbar（P5.2）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    resetDesignerStores()
    resetTemplateRepository()
    useUiStore.getState().$reset()
    exportTemplateFile.mockClear()
    importTemplateFile.mockReset()
  })

  it('渲染品牌 / 模板名输入框 / 主操作按钮', async () => {
    await mount()
    const text = body().textContent!.replace(/\s/g, '')
    expect(text).toContain('OpenPrint')
    expect(text).toContain('文件')
    expect(text).toContain('模板市场')
    expect(text).toContain('流水标签')
    expect(text).toContain('预览')
    expect(text).toContain('保存')
    expect(text).toContain('导出')
    const input = [...body().querySelectorAll<HTMLInputElement>('input')].find(
      (el) => el.value === '销售出库单模板',
    )
    expect(input).toBeTruthy()
  })

  it('改模板名 → store 更新并标记 dirty', async () => {
    await mount()
    const input = [...body().querySelectorAll<HTMLInputElement>('input')].find(
      (el) => el.value === '销售出库单模板',
    )!
    await act(async () => {
      typeInput(input, '新名字')
    })
    const s = useDesignerStore.getState()
    expect(s.templateName).toBe('新名字')
    expect(s.dirty).toBe(true)
  })

  it('撤销 / 重做按钮随历史栈启用', async () => {
    await mount()
    const undoBtn = body().querySelector<HTMLButtonElement>('[aria-label="撤销"]')!
    const redoBtn = body().querySelector<HTMLButtonElement>('[aria-label="重做"]')!
    expect(undoBtn.disabled).toBe(true)
    expect(redoBtn.disabled).toBe(true)
    await act(async () => {
      useHistoryStore.setState({
        undoStack: [{ undo: () => {}, redo: () => {}, description: 'x' }],
        redoStack: [{ undo: () => {}, redo: () => {}, description: 'y' }],
      })
    })
    expect(undoBtn.disabled).toBe(false)
    expect(redoBtn.disabled).toBe(false)
  })

  it('文件菜单 → 保存：写 localStorage，回填 currentTemplateId，清 dirty', async () => {
    await mount()
    useDesignerStore.getState().renameTemplate('菜单保存')
    await pickFileMenu('保存')
    const s = useDesignerStore.getState()
    expect(s.currentTemplateId).toBeTruthy()
    expect(s.dirty).toBe(false)
    expect(localStorage.getItem('openprint:templates')).toContain('菜单保存')
  })

  it('文件菜单 → 新建空白模板：弹窗输入名称后创建干净画布', async () => {
    await mount()
    await pickFileMenu('新建空白模板')
    await typeModalInput('请输入模板名称', '我的新模板')
    await clickModalButton('创建')
    const s = useDesignerStore.getState()
    expect(s.templateName).toBe('我的新模板')
    expect(s.dirty).toBe(false)
    expect(s.currentTemplateId).toBeNull()
    expect(s.controls).toHaveLength(0)
  })

  it('文件菜单 → 载入示例模板：模板名与控件装配', async () => {
    await mount()
    await pickFileMenu('载入示例模板')
    const s = useDesignerStore.getState()
    expect(s.templateName).toBe(DEMO_TEMPLATE_NAME)
    expect(s.currentTemplateId).toBe('demo')
    expect(s.controls.length + s.zones.length).toBeGreaterThan(0)
  })

  it('文件菜单 → 导出模板：exportTemplateFile 收到当前画布模板', async () => {
    await mount()
    await pickFileMenu('导出模板...')
    await waitFor(() => exportTemplateFile.mock.calls.length > 0)
    const [data, name] = exportTemplateFile.mock.calls[0]!
    expect(name).toBe('销售出库单模板')
    expect((data as { document: unknown }).document).toBeTruthy()
  })

  it('文件菜单 → 导入模板：校验通过后载入画布', async () => {
    const { createDemoTemplate } = await import('@/repository/mock/data/demo-template')
    importTemplateFile.mockResolvedValue(createDemoTemplate())
    await mount()
    await pickFileMenu('导入模板...')
    const s = useDesignerStore.getState()
    // 模板 JSON 不带 name 字段 → 沿用当前模板名（与 Vue 版回退逻辑一致）
    expect(s.templateName).toBe('销售出库单模板')
    expect(s.controls.length + s.zones.length).toBeGreaterThan(0)
    expect(s.currentTemplateId).toContain('import-')
  })

  it('文件菜单 → 另存为：以新名称创建副本', async () => {
    await mount()
    await useDesignerStore.getState().saveTemplate()
    const firstId = useDesignerStore.getState().currentTemplateId
    await pickFileMenu('另存为...')
    await typeModalInput('请输入模板名称', '独立副本')
    await clickModalButton('保存副本')
    const s = useDesignerStore.getState()
    expect(s.templateName).toBe('独立副本')
    expect(s.currentTemplateId).not.toBe(firstId)
    expect(s.currentTemplateId).toBeTruthy()
  })

  it('主题一键切换：light ↔ dark', async () => {
    localStorage.setItem('openprint:ui:theme', 'light')
    useUiStore.getState().$reset()
    await mount()
    const themeBtn = body().querySelector<HTMLButtonElement>('[aria-label="切换主题"]')!
    await act(async () => {
      themeBtn.click()
    })
    expect(useUiStore.getState().themePreference).toBe('dark')
    await act(async () => {
      themeBtn.click()
    })
    expect(useUiStore.getState().themePreference).toBe('light')
  })

  it('点击版本号切换 SVIP 黑金主题，再点退出', async () => {
    localStorage.setItem('openprint:ui:theme', 'light')
    useUiStore.getState().$reset()
    await mount()
    const tag = body().querySelector<HTMLElement>('.version-tag')!
    expect(tag.textContent).toBe('v2.0.0')
    await act(async () => {
      tag.click()
    })
    expect(useUiStore.getState().themePreference).toBe('svip')
    expect(body().querySelector<HTMLElement>('.version-tag.is-svip')).toBeTruthy()
    await act(async () => {
      body().querySelector<HTMLElement>('.version-tag.is-svip')!.click()
    })
    expect(useUiStore.getState().themePreference).toBe('light')
  })

  it('边距参考线开关切换 store 状态', async () => {
    await mount()
    const before = useUiStore.getState().showMarginGuides
    await act(async () => {
      body().querySelector<HTMLButtonElement>('[aria-label="页边距参考线"]')!.click()
    })
    expect(useUiStore.getState().showMarginGuides).toBe(!before)
  })

  it('预览 / 导出按钮打开真实弹窗（PreviewPanel / ExportDialog）', async () => {
    await mount()
    const btnByText = (text: string): HTMLButtonElement | undefined =>
      [...body().querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.replace(/\s/g, '') === text,
      )
    await act(async () => {
      btnByText('预览')!.click()
    })
    expect(useUiStore.getState().previewOpen).toBe(true)
    await waitFor(() => body().textContent!.includes('打印预览'))
    await act(async () => {
      btnByText('导出')!.click()
    })
    expect(useUiStore.getState().exportOpen).toBe(true)
    await waitFor(() => body().textContent!.includes('导出文档'))
  })

  it('按 ? 打开快捷键指南；平台切换改变 MOD 键显示', async () => {
    await mount()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))
    })
    await waitFor(() => body().textContent!.includes('快捷键指南'))
    // happy-dom navigator.platform 非 Mac → 默认 Windows → Ctrl
    const kbdText = [...body().querySelectorAll<HTMLElement>('.kbd')]
      .map((k) => k.textContent)
      .join(',')
    expect(kbdText).toContain('Ctrl')
    expect(kbdText).not.toContain('⌘')
    const macTab = [...body().querySelectorAll<HTMLButtonElement>('.platform-tab')].find(
      (b) => b.textContent === 'macOS',
    )!
    await act(async () => {
      macTab.click()
    })
    const after = [...body().querySelectorAll<HTMLElement>('.kbd')]
      .map((k) => k.textContent)
      .join(',')
    expect(after).toContain('⌘')
  })

  it('输入框内按 ? 不触发快捷键指南', async () => {
    await mount()
    const input = body().querySelector<HTMLInputElement>('input')!
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(body().textContent).not.toContain('快捷键指南')
  })
})
