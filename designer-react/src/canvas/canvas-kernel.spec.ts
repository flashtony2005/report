/**
 * canvas-kernel —— 画布内核在 React 端的加载与几何契约
 *
 * 目的不是重复 Vue 端已有的单测，而是验证 **P2 的地基是否成立**：
 * 1. 画布内核（CanvasDesigner + 14 类控件 + SmartGuides）能否在**没有 vue / pinia** 的
 *    React 工程里成功加载 —— 即 vite alias + 两个 shim 是否真的把框架依赖顶掉了
 * 2. 画布几何纯函数在 React 端结果是否与 Vue 端一致（同一份源码，重点验证不被环境差异影响）
 * 3. 两个 shim 是否**真的在工作**，而不是被 `buildSampleCtx` 的 try/catch 悄悄兜底
 *
 * 第 3 点最关键：本测试直接调用 shim 导出的函数（测试侧无 try/catch），
 * 只要 shim 抛错就会失败，从而与「错误被吞掉」区分开。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { MM_TO_PX } from '@/utils/constants'

/* ---------------- 1. 内核可加载性 ---------------- */

describe('画布内核在 React 端可加载', () => {
  it('CanvasDesigner 可 import（证明 vue/pinia 依赖已被 shim 顶掉）', async () => {
    const mod = await import('@/design/canvas/CanvasDesigner')
    expect(mod.CanvasDesigner).toBeTypeOf('function')
  })

  it('14 类 PrintXxx 控件全部可加载', async () => {
    const mod = await import('@/design/canvas/controls')
    const names = [
      'PrintText',
      'PrintRect',
      'PrintCircle',
      'PrintLine',
      'PrintImage',
      'PrintBarcode',
      'PrintQrcode',
      'PrintTable',
      'PrintZone',
      'PrintRichText',
      'PrintChart',
      'PrintMath',
      'PrintSignature',
      'PrintLabelGrid',
    ] as const
    for (const n of names) expect(mod[n], n).toBeTypeOf('function')
  })

  it('SmartGuides 可加载（它 import 了被 shim 顶替的 rulerHighlight）', async () => {
    const mod = await import('@/design/canvas/guides/SmartGuides')
    expect(mod.SmartGuides).toBeTypeOf('function')
  })

  it('table-design-render 可加载（它 import 了被 shim 顶替的 dataSource）', async () => {
    const mod = await import('@/design/canvas/table-design-render')
    expect(mod.computeGridLayout).toBeTypeOf('function')
    expect(mod.hitTestCell).toBeTypeOf('function')
  })
})

/* ---------------- 2. 画布几何纯函数 ---------------- */

describe('page-gap —— 模型 mm 与画布 px 往返', () => {
  it('内容区内的 top 往返换算应还原', async () => {
    const { modelTopToCanvasY, canvasYToModelTop } = await import('@/design/canvas/page-gap')
    const marginTopPx = 40
    const stepMm = 250 // A4 分页步长
    const pageHeightPx = 297 * MM_TO_PX
    const gapPx = 24

    for (const topMm of [0, 10, 99.5, 249.9]) {
      const y = modelTopToCanvasY(topMm, marginTopPx, stepMm, pageHeightPx, gapPx)
      const back = canvasYToModelTop(y, marginTopPx, stepMm, pageHeightPx, gapPx)
      expect(back, `topMm=${topMm}`).toBeCloseTo(topMm, 6)
    }
  })

  it('第 2 页的 top 会叠加一次页间距', async () => {
    const { modelTopToCanvasY } = await import('@/design/canvas/page-gap')
    const marginTopPx = 40
    const stepMm = 250
    const pageHeightPx = 297 * MM_TO_PX
    const gapPx = 24

    const y0 = modelTopToCanvasY(10, marginTopPx, stepMm, pageHeightPx, gapPx)
    const y1 = modelTopToCanvasY(10 + stepMm, marginTopPx, stepMm, pageHeightPx, gapPx)
    // 同一页内偏移相差 stepMm，跨一页则额外多出一整页高 + 一个间距
    expect(y1 - y0).toBeCloseTo(pageHeightPx + gapPx, 6)
  })

  it('首页之前的页间距恒为 0', async () => {
    const { pageGapPx } = await import('@/design/canvas/page-gap')
    expect(pageGapPx(0, 250, 24)).toBe(0)
    expect(pageGapPx(249.9, 250, 24)).toBe(0)
    expect(pageGapPx(250, 250, 24)).toBe(24)
    expect(pageGapPx(750, 250, 24)).toBe(24 * 3)
  })
})

describe('page-geometry —— 物理页数', () => {
  it('内容高度决定页数', async () => {
    const { computePhysicalPageCount } = await import('@/design/canvas/page-geometry')
    expect(computePhysicalPageCount(0, 250)).toBe(1)
    expect(computePhysicalPageCount(249.9, 250)).toBe(1)
    expect(computePhysicalPageCount(250, 250)).toBe(2)
    expect(computePhysicalPageCount(750, 250)).toBe(4)
  })

  it('非法步长退化为 1 页', async () => {
    const { computePhysicalPageCount } = await import('@/design/canvas/page-geometry')
    expect(computePhysicalPageCount(1000, 0)).toBe(1)
    expect(computePhysicalPageCount(1000, -5)).toBe(1)
  })
})

/* ---------------- 3. shim 是否真的在工作 ---------------- */

describe('rulerHighlight —— 框架无关共享状态', () => {
  /**
   * 该模块已直接改为框架无关实现（Vue 端源文件去掉 vue ref），
   * 两端 import 同一份 —— 无需 shim。此处验证读写与订阅语义。
   */
  afterEach(async () => {
    const mod = await import('@/design/canvas/rulers/rulerHighlight')
    mod.rulerBand.value = null
  })

  it('写入后可读回，且通知订阅者', async () => {
    const { rulerBand, onRulerBandChange, getRulerBand } = await import(
      '@/design/canvas/rulers/rulerHighlight'
    )
    let notified = 0
    const unsub = onRulerBandChange(() => {
      notified++
    })

    expect(getRulerBand()).toBeNull()
    const band = { left: 10, top: 20, width: 100, height: 50 }
    rulerBand.value = band

    expect(getRulerBand()).toEqual(band)
    expect(rulerBand.value).toEqual(band)
    expect(notified).toBe(1)

    // 同值写入不应触发通知（与 Vue ref 的语义一致）
    rulerBand.value = band
    expect(notified).toBe(1)

    unsub()
    rulerBand.value = { left: 0, top: 0, width: 1, height: 1 }
    expect(notified).toBe(1)
  })

  it('getSnapshot 返回稳定引用（避免 useSyncExternalStore 无限重渲染）', async () => {
    const { rulerBand, getRulerBand } = await import('@/design/canvas/rulers/rulerHighlight')
    const band = { left: 1, top: 2, width: 3, height: 4 }
    rulerBand.value = band
    expect(getRulerBand()).toBe(getRulerBand())
  })

  it('模块内无 vue import（跨框架复用的硬保证）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = resolve(
      __dirname,
      '../../../openprint/src/design/canvas/rulers/rulerHighlight.ts',
    )
    const text = readFileSync(src, 'utf-8')
    expect(text.includes("from 'vue'")).toBe(false)
  })
})

describe('dataSource shim', () => {
  /**
   * 关键：断言 previewData **含 items 数组**。
   * 若只断言「是对象」，则 shim 抛错被 buildSampleCtx 的 try/catch 兜底后返回 {} 也能通过，
   * 测试就形同虚设。items 是 table-design-render 取样例行的依据，非它不可。
   */
  it('加载字段后 previewData 含 items 数组（证明 shim 真在工作，未被 try/catch 兜底）', async () => {
    const { useReactDataSourceStoreReady } = await import('./test-utils')
    await useReactDataSourceStoreReady()

    const { useDataSourceStore } = await import('./shims/dataSource')
    // 测试侧没有 try/catch：shim 一旦抛错，本用例直接失败
    const data = useDataSourceStore().previewData as Record<string, unknown>
    expect(data).toBeTruthy()
    expect(Object.keys(data).length).toBeGreaterThan(0)
    expect(Array.isArray(data['items'])).toBe(true)
    expect((data['items'] as unknown[]).length).toBeGreaterThan(0)
  })

  it('依赖不变时复用缓存（等价 Vue computed）', async () => {
    const { useDataSourceStore, resetPreviewCache } = await import('./shims/dataSource')
    resetPreviewCache()
    const a = useDataSourceStore().previewData
    const b = useDataSourceStore().previewData
    expect(b).toBe(a)
  })

  /**
   * 反「静默失效」测试 —— 本文件最重要的一条。
   *
   * 若 vite alias 被误删，`table-design-render` 会回退到 Vue 项目的 Pinia store，
   * 在无 active pinia 时抛错，被 `buildSampleCtx` 的 try/catch 默默兜底成空上下文：
   * 不报错、其它用例照样全绿，但「设计期动态配色」在 React 端已悄悄失效。
   * 这条用例通过计数断言样例数据**确实来自本 shim**，把静默失效变成红灯。
   */
  it('渲染表格网格时，样例数据确实来自本 shim（而非被 Pinia 抛错兜底）', async () => {
    const { useReactDataSourceStoreReady } = await import('./test-utils')
    await useReactDataSourceStoreReady()

    const { resetPreviewCache, getPreviewComputeCount } = await import('./shims/dataSource')
    const { renderTableGridHtml } = await import('@/design/canvas/table-design-render')
    const { createDefaultControl } = await import('@/design/control-factory')

    resetPreviewCache()
    expect(getPreviewComputeCount()).toBe(0)

    const table = createDefaultControl('table', { leftMm: 10, topMm: 10 })
    const html = renderTableGridHtml(table as never)

    expect(html).toBeTypeOf('string')
    expect(getPreviewComputeCount()).toBeGreaterThan(0)
  })
})
