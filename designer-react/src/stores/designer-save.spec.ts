/**
 * P5.2 测试：designer store 保存 / 加载链路（repository 接入）
 * 与 Vue 版 saveTemplate / saveTemplateAs / loadTemplate / newBlankTemplate 行为对齐。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useDesignerStore, attachCanvasHost, detachCanvasHost, type CanvasHost } from './designer'
import { resetDesignerStores } from './designer'
import { resetTemplateRepository } from './designer'
import type { TemplateData } from '@/types/template'
import type { AnyControl } from '@/types/control'

/** 记录画布内核调用的 stub（attach 后 loadTemplate/newBlankTemplate 会驱动它） */
function makeHostStub() {
  const calls = {
    addControl: [] as Array<{ id: string; zoneHostId?: string }>,
    clearControls: 0,
    setPage: [] as unknown[],
    setManualPageCount: [] as number[],
    setPageBackground: [] as string[],
    setWatermark: [] as unknown[],
  }
  const host: CanvasHost = {
    addControl: (c) => {
      calls.addControl.push({ id: c.id, zoneHostId: undefined })
    },
    updateControl: vi.fn(),
    removeControl: vi.fn(),
    clearControls: () => {
      calls.clearControls++
    },
    syncZOrder: vi.fn(),
    setActiveControl: vi.fn(),
    setPage: (p) => {
      calls.setPage.push(p)
    },
    setManualPageCount: (n) => {
      calls.setManualPageCount.push(n)
    },
    setPageBackground: (c) => {
      calls.setPageBackground.push(c)
    },
    setWatermark: (w) => {
      calls.setWatermark.push(w)
    },
    setGridVisible: vi.fn(),
    setGridSize: vi.fn(),
    setGridColor: vi.fn(),
    setMarginGuidesVisible: vi.fn(),
    setMarginLocked: vi.fn(),
    syncGridChildren: vi.fn(),
    getControlById: () => null,
    serialize: () => null,
  }
  return { host, calls }
}

/** 最小合法模板（header + body + footer） */
function makeTemplate(): TemplateData<AnyControl> {
  return {
    version: '1.0',
    document: {
      type: 'report',
      page: {
        width: 210,
        height: 297,
        unit: 'mm',
        orientation: 'portrait',
        margin: { top: 10, bottom: 10, left: 10, right: 10 },
      },
      sections: [
        {
          type: 'header',
          height: 20,
          repeat: true,
          components: [
            { id: 'h1', type: 'text', left: 10, top: 0, width: 50, height: 6, value: '页眉文字' },
          ],
        },
        {
          type: 'body',
          components: [
            { id: 'b1', type: 'text', left: 10, top: 30, width: 60, height: 8, value: '正文文字' },
          ],
        },
        { type: 'footer', height: 14, repeat: true, components: [] },
      ],
    },
  } as unknown as TemplateData<AnyControl>
}

const indexKey = 'openprint:templates'

describe('designer store 保存/加载（P5.2）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetDesignerStores()
    resetTemplateRepository()
    detachCanvasHost()
  })

  it('saveTemplate 首次走 create：写 localStorage 索引 + 记录，回填 currentTemplateId，清 dirty', async () => {
    useDesignerStore.getState().renameTemplate('测试模板')
    expect(useDesignerStore.getState().dirty).toBe(true)
    const result = await useDesignerStore.getState().saveTemplate()
    expect(result.ok).toBe(true)

    const after = useDesignerStore.getState()
    expect(after.currentTemplateId).toBeTruthy()
    expect(after.dirty).toBe(false)
    expect(after.lastSavedAt).toBeTruthy()

    const index = JSON.parse(localStorage.getItem(indexKey)!) as Array<{ id: string; name: string }>
    expect(index).toHaveLength(1)
    expect(index[0]!.name).toBe('测试模板')
    expect(index[0]!.id).toBe(after.currentTemplateId)
  })

  it('再次保存走 update：不新增索引条目', async () => {
    await useDesignerStore.getState().saveTemplate()
    useDesignerStore.getState().renameTemplate('改名了')
    await useDesignerStore.getState().saveTemplate()

    const index = JSON.parse(localStorage.getItem(indexKey)!) as Array<{ id: string; name: string }>
    expect(index).toHaveLength(1)
    expect(index[0]!.name).toBe('改名了')
    expect(useDesignerStore.getState().currentTemplateId).toBe(index[0]!.id)
  })

  it('空名保存回落「未命名模板」', async () => {
    useDesignerStore.getState().renameTemplate('   ')
    const result = await useDesignerStore.getState().saveTemplate()
    expect(result.ok).toBe(true)
    const index = JSON.parse(localStorage.getItem(indexKey)!) as Array<{ name: string }>
    expect(index[0]!.name).toBe('未命名模板')
  })

  it('saveTemplateAs 以新名称创建独立副本（新 id）', async () => {
    await useDesignerStore.getState().saveTemplate()
    const firstId = useDesignerStore.getState().currentTemplateId
    const result = await useDesignerStore.getState().saveTemplateAs('副本 A')
    expect(result.ok).toBe(true)

    const after = useDesignerStore.getState()
    expect(after.currentTemplateId).not.toBe(firstId)
    expect(after.templateName).toBe('副本 A')
    const index = JSON.parse(localStorage.getItem(indexKey)!) as unknown[]
    expect(index).toHaveLength(2)
  })

  it('loadTemplate 装配 zones/controls 并驱动画布内核（先 zone 后 body/子控件）', () => {
    const { host, calls } = makeHostStub()
    attachCanvasHost(host)

    useDesignerStore.getState().loadTemplate({ id: 'tpl-1', name: '载入的模板', data: makeTemplate() })
    const s = useDesignerStore.getState()
    expect(s.currentTemplateId).toBe('tpl-1')
    expect(s.templateName).toBe('载入的模板')
    expect(s.zones).toHaveLength(2)
    expect(s.zones[0]!.zone).toBe('header')
    expect(s.zones[0]!.children).toHaveLength(1)
    expect(s.controls).toHaveLength(1)
    expect(s.dirty).toBe(false)
    expect(s.selectedIds).toEqual([])
    // 页面装饰已同步
    expect(calls.setPage.length).toBe(1)
    expect(calls.setManualPageCount).toEqual([0])
    expect(calls.clearControls).toBe(1)
    // addControl 顺序：header zone → footer zone → header 子控件 → body 控件
    expect(calls.addControl).toHaveLength(4)
    expect(calls.addControl.slice(2).map((c) => c.id)).toEqual(['h1', 'b1'])
    detachCanvasHost()
  })

  it('newBlankTemplate 归零 currentTemplateId 并清空画布', async () => {
    await useDesignerStore.getState().saveTemplate()
    expect(useDesignerStore.getState().currentTemplateId).toBeTruthy()
    useDesignerStore.getState().newBlankTemplate()
    const s = useDesignerStore.getState()
    expect(s.currentTemplateId).toBeNull()
    expect(s.templateName).toBe('未命名模板')
    expect(s.controls).toHaveLength(0)
    expect(s.dirty).toBe(false)
  })
})
