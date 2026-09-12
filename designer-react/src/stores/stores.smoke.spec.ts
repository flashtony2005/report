/**
 * Store 冒烟测试 —— P1 骨架交付验收
 *
 * 验证 4 个 store（designer / history / ui / dataSource）在 React 环境下
 * 能正确初始化并可用，且引擎层（core / repository / config）能被 React 端引用。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useDesignerStore, resetDesignerStores } from './designer'
import { useHistoryStore, resetHistoryStore } from './history'
import { useUiStore, resolveEffectiveTheme } from './ui'
import { useDataSourceStore } from './dataSource'
import { usePrinterProbeStore, selectSummary, selectDefaultPrinter } from './printerProbe'
// 引擎层复用验证：这些 import 走 alias 指向 Vue 项目的 openprint/src
import { render } from '@/core/sdk'
import type { TemplateData } from '@/types/template'

describe('P1 骨架 · store 冒烟', () => {
  beforeEach(() => {
    resetDesignerStores()
    useUiStore.getState().$reset()
    useDataSourceStore.getState().$reset()
  })

  it('designer store 初始状态正确', () => {
    const s = useDesignerStore.getState()
    expect(s.controls).toEqual([])
    expect(s.zones).toEqual([])
    expect(s.minPages).toBe(0)
    expect(s.dirty).toBe(false)
    expect(s.pageSetup.width).toBe(210)
    expect(s.pageSetup.height).toBe(297)
  })

  it('history store 可用且 reset 生效', () => {
    resetHistoryStore()
    expect(useHistoryStore.getState().undoStack).toEqual([])
    useHistoryStore.getState().push({ undo: () => {}, redo: () => {}, description: 't' })
    expect(useHistoryStore.getState().undoStack.length).toBe(1)
    resetHistoryStore()
    expect(useHistoryStore.getState().undoStack.length).toBe(0)
  })

  it('ui store 主题解析正确', () => {
    const s = useUiStore.getState()
    expect(resolveEffectiveTheme({ themePreference: 'dark', systemDark: false })).toBe('dark')
    expect(resolveEffectiveTheme({ themePreference: 'system', systemDark: true })).toBe('dark')
    expect(resolveEffectiveTheme({ themePreference: 'system', systemDark: false })).toBe('light')
    expect(resolveEffectiveTheme({ themePreference: 'svip', systemDark: false })).toBe('svip')
    s.toggleMarginGuides()
    expect(useUiStore.getState().showMarginGuides).toBe(false)
  })

  it('dataSource store 初始为示例数据态', () => {
    const s = useDataSourceStore.getState()
    expect(['sample', 'erp', 'database']).toContain(s.kind)
    expect(s.previewRowCount).toBe(30)
    s.setPreviewRowCount(12.7)
    expect(useDataSourceStore.getState().previewRowCount).toBe(12)
  })

  it('printerProbe store 初始 idle', () => {
    const s = usePrinterProbeStore.getState()
    expect(s.state).toBe('idle')
    expect(selectSummary(s)).toBe('打印客户端：未检测')
    expect(selectDefaultPrinter(s)).toBeNull()
  })

  it('引擎层可被 React 端直接引用（render 是函数）', () => {
    expect(typeof render).toBe('function')
  })

  it('引擎能渲染 React 端 designer store 产出的模板', async () => {
    const d = useDesignerStore.getState()
    d.addControlOfType('text', { leftMm: 20, topMm: 20 }, { value: 'Hello {{name}}' })
    const tpl = useDesignerStore.getState().buildTemplate() as TemplateData<never>
    expect(tpl.document.sections.length).toBeGreaterThan(0)

    const res = await render({ template: tpl, data: { name: 'OpenPrint' } })
    expect(res.html).toContain('Hello OpenPrint')
  })
})
