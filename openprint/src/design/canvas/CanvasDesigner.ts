/**
 * CanvasDesigner —— Fabric 画布内核
 *
 * 职责：画布初始化 / 页面（A4 白纸）/ 缩放平移 / 控件增删改 / 选中事件 / 序列化。
 * 坐标约定（《标尺与辅助系统》§4.3）：
 * - 页面左上角 = 画布坐标 (0,0)，zoom=1 时 1mm = MM_TO_PX px
 * - 居中/平移/缩放全部走 viewportTransform，标尺层直接读 vt[4]/vt[5] + zoom
 * - 协议层坐标：body 控件相对"物理页"左上角（整页相对，边距仅可视化参考线）；zone 子控件相对色带左上角（§5.14.2）
 */
import { Canvas, Rect, Line, Point, FabricObject, Text, Pattern, type TPointerEventInfo } from 'fabric'
import type { AnyControl, LabelGridControl, ZoneControl } from '@/types/control'
import type { PageSetup, WatermarkConfig } from '@/types/template'
import { MM_TO_PX, ZOOM_MAX, ZOOM_MIN } from '@/utils/constants'
import { toMm } from '@/core/units'
import { createFabricControl, isPrintObject, PrintText, PrintZone, type IPrintObject } from './controls'
import { SmartGuides } from './guides/SmartGuides'
import { PrintTable } from './controls/PrintTable'
import { ensureCells } from '@/core/layout-engine/table-cells'
import { computeGridLayout, hitTestCell } from './table-design-render'
import { computePhysicalPageCount } from './page-geometry'
import { pageGapPx, modelTopToCanvasY, canvasYToModelTop } from './page-gap'
import { parsePinch, pinchTransform, pointerClientXY } from './touch-gesture'
import type { TableControl } from '@/types/control'

export interface ViewportState {
  zoom: number
  offsetX: number
  offsetY: number
}

export interface CanvasDesignerEvents {
  /** 选中变化（controlId 列表；空数组 = 取消选中） */
  onSelectionChange?: (ids: string[]) => void
  /** 控件几何/属性被画布交互修改（拖拽/缩放手柄结束） */
  onObjectModified?: (control: AnyControl) => void
  /** 视口变化（缩放/平移），驱动标尺重绘 */
  onViewportChange?: (vp: ViewportState) => void
  /** 双击表格单元格进入编辑：返回物化了 cells 的控件与命中行列 */
  onCellEdit?: (info: { controlId: string; control: AnyControl; row: number; col: number }) => void
  /**
   * 画布变换心跳：对象拖拽/缩放/旋转或视口变化时触发。
   * 表格 HTML overlay 靠它重算定位（不走 store 直连，避免 store ↔ 画布循环依赖）。
   */
  onTransformTick?: () => void
  /** 物理页数变化（内容推导或手动分页触发），驱动右侧页面面板刷新 */
  onPageCountChange?: (count: number) => void
  /**
   * P6.4 触屏长按控件（约 500ms，仅 pointer:coarse）：弹出上下文菜单用。
   * screen 为触发点的视口坐标（clientX/Y），供菜单浮层定位。
   */
  onLongPress?: (controlId: string, screen: { x: number; y: number }) => void
}

type PrintFabricObject = FabricObject & IPrintObject

export class CanvasDesigner {
  canvas!: Canvas
  /** 容器尺寸监听（init 内创建，dispose 必须 disconnect，否则每次 attachCanvas 泄漏一个观察者） */
  private resizeObserver: ResizeObserver | null = null
  /** 页面尺寸（mm，内部统一换算） */
  pageWidthMm = 210
  pageHeightMm = 297
  marginMm = { top: 10, bottom: 10, left: 10, right: 10 }

  private pageRect!: Rect
  /** 第 2..N 页白色背景（与 pageRect 同款，按 stride 堆叠） */
  private extraPageRects: Rect[] = []
  /** 每页内容区参考线（蓝色虚线矩形，非交互、不导出） */
  private pageGuides: Rect[] = []
  /** 每页内容区底部的分页虚线（红色，与渲染 floor(top/bodyH) 落页边界一致） */
  private pageBreaks: Line[] = []
  /** 分页线标签（"分页"）与每页页码标签（"第 N 页"） */
  private pageLabels: Text[] = []
  /** 当前文档物理页数 = max(内容推导页数, 手动分页 minPages)，最小 1 */
  private pageCount = 1
  /** 手动分页下限：用户「加页/减页」调整；0 = 完全由内容推导 */
  private minPages = 0
  /**
   * 页间视觉间距（px，仅设计态）：上下两页之间留白，便于分辨页边界。
   * 只作用在画布坐标（模型 mm 保持 flush，导出/渲染不变）。
   */
  private readonly PAGE_GAP_PX = 24
  private smartGuides?: SmartGuides
  /** 水印装饰层（非交互、不导出、不进序列化），随页面尺寸/配置重建 */
  private watermarkObjs: FabricObject[] = []
  private lastWatermark?: WatermarkConfig
  private events: CanvasDesignerEvents = {}
  private spacePanning = false
  /** 用户手动缩放后置 true，窗口 resize 不再自动 refit */
  private userZoomed = false
  /** init 时记住宿主容器（fitToHost 复用；Vue/React 两端缩放工具栏共用） */
  private containerEl: HTMLElement | null = null
  /** 页边距锁定：默认开启，正文控件移动被钳制在内容区内（边距内=设计安全区，辅助设计）；关闭后自由移动 */
  private marginLocked = true
  /** 页边距参考线显示开关：rebuildPages 重建后保持，移动组件不会让隐藏的参考线复活 */
  private marginGuidesVisible = true
  /** P6.3 触屏手势：双指捏合状态（null = 未在捏合） */
  private touchPinch: { prev: { dist: number; midX: number; midY: number } } | null = null
  /** 粗指针设备（触屏）：开启单指空白拖拽平移（桌面保持框选语义） */
  private readonly coarsePointer: boolean =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false
  /** 触控手势监听（dispose 时移除） */
  private touchCleanup: Array<() => void> = []

  /**
   * 注册「临时」全局监听并纳入 dispose 清理链。
   * 长按取消 / 空格平移 / 单指平移的 window 监听原先只在自身回调里移除，
   * 若在手势中途 dispose（切模板 / 卸载组件），监听残留并持有 canvas 闭包 → 泄漏。
   * 返回的 off 幂等，回调内自己移除也不会出错。
   */
  private addTempListener<K extends keyof WindowEventMap>(
    type: K,
    fn: (ev: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): () => void {
    window.addEventListener(type, fn as EventListener, opts)
    let off = false
    const remove = (): void => {
      if (off) return
      off = true
      window.removeEventListener(type, fn as EventListener)
      this.touchCleanup = this.touchCleanup.filter((f) => f !== remove)
    }
    this.touchCleanup.push(remove)
    return remove
  }
  /** P6.4 长按检测：定时器句柄与起始点（移动超阈值即取消） */
  private longPressTimer: ReturnType<typeof setTimeout> | null = null
  private longPressStart = { x: 0, y: 0 }

  private clearLongPressTimer(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
  }

  /** 初始化画布。container 决定画布像素尺寸（ ResizeObserver 自适应） */
  init(el: HTMLCanvasElement, container: HTMLElement, events: CanvasDesignerEvents = {}): void {
    this.containerEl = container
    this.events = events
    // Fabric 7 默认 origin 为 center——全局改回 left/top，协议坐标语义保持一致
    FabricObject.ownDefaults.originX = 'left'
    FabricObject.ownDefaults.originY = 'top'
    this.canvas = new Canvas(el, {
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundColor: '#e8eaed',
      preserveObjectStacking: true,
      selection: true,
      stopContextMenu: true,
      fireRightClick: true,
    })

    this.buildPage()
    this.fitToContainer(container)
    this.bindEvents()
    // 监听挂宿主容器：Fabric 交互发生在 upper-canvas（传入 el 的兄弟节点），挂 el 收不到
    this.bindTouchGestures(container)

    this.smartGuides = new SmartGuides(this.canvas, () => this.pageRect, () => this.marginMm)

    this.resizeObserver = new ResizeObserver(() => {
      this.canvas.setDimensions({
        width: container.clientWidth,
        height: container.clientHeight,
      })
      // 布局稳定前（面板展开/窗口调整）保持适配；用户手动缩放后不再打扰。
      // fitToContainer 内部已 requestRenderAll + emitViewport，这里不重复，
      // 否则每次尺寸变化双发 viewport，双端各多一轮状态栏/组件重渲染。
      if (!this.userZoomed) {
        this.fitToContainer(container)
      } else {
        this.canvas.requestRenderAll()
        this.emitViewport()
      }
    })
    this.resizeObserver.observe(container)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.clearLongPressTimer()
    for (const off of this.touchCleanup) off()
    this.touchCleanup = []
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.smartGuides?.dispose()
    void this.canvas.dispose()
  }

  /* -------------------------------- 页面 -------------------------------- */

  private buildPage(): void {
    this.pageRect = new Rect({
      left: 0,
      top: 0,
      width: this.pageWidthMm * MM_TO_PX,
      height: this.pageHeightMm * MM_TO_PX,
      fill: this.lastPageBackground || '#ffffff',
      selectable: false,
      evented: false,
      hoverCursor: 'default',
      shadow: '0 2px 12px rgba(0,0,0,0.15)',
      // 标记：序列化/选中时排除
      excludeFromExport: true,
    } as never)
    ;(this.pageRect as unknown as { isPageRect: boolean }).isPageRect = true
    this.canvas.add(this.pageRect)
    this.pageRect.canvas = this.canvas
    // 首次构建后按当前内容推导页数并铺好分页线 / 参考线 / 页码
    this.rebuildPages()
  }

  /** 记忆最近一次背景色（buildPage 首帧用） */
  private lastPageBackground = '#ffffff'

  /* ------------------------ 页间留白（模型 mm 与画布 px 换算） ------------------------ */
  // 复用 page-gap.ts 纯函数，避免实现与 page-gap.spec.ts 测试逻辑分叉（单一真相来源）。
  // 整页相对坐标模型：正文 top 相对物理页 0,0（页边距仅作可视化参考线，不参与渲染/分页偏移）；
  // 分页步长 = 整页高，正文控件越过物理页底才跨页。

  /** 当前页眉色带高度（mm）；无页眉为 0 */
  private get headerZoneMm(): number {
    const z = this.getZones().find((z) => z.zone === 'header')
    return z ? z.zoneHeightMm : 0
  }

  /** 当前页脚色带高度（mm）；无页脚为 0 */
  private get footerZoneMm(): number {
    const z = this.getZones().find((z) => z.zone === 'footer')
    return z ? z.zoneHeightMm : 0
  }

  /** 分页步长（mm）= 整页高：正文控件越过物理页底才跨页（边距仅参考线，不约束分页） */
  private get bodyHeightMm(): number {
    return Math.max(1, this.pageHeightMm)
  }

  /** 模型 top(mm, 相对内容区) 所在页索引 → 该页之前的累计页间距(px) */
  private gapPx(topMm: number): number {
    return pageGapPx(topMm, this.bodyHeightMm, this.PAGE_GAP_PX)
  }

  /** 模型 top(mm, 整页相对) → 画布绝对 y(px)：页序堆叠 + 页内偏移 + 累计页间距（边距不参与偏移） */
  private modelTopToY(topMm: number): number {
    return modelTopToCanvasY(
      topMm,
      0,
      this.bodyHeightMm,
      this.pageHeightMm * MM_TO_PX,
      this.PAGE_GAP_PX,
    )
  }

  /** 画布绝对 y(px) → 模型 top(mm, 整页相对)：反解累计页间距（边距不参与偏移） */
  private yToModelTop(y: number): number {
    return canvasYToModelTop(
      y,
      0,
      this.bodyHeightMm,
      this.pageHeightMm * MM_TO_PX,
      this.PAGE_GAP_PX,
    )
  }

  /* -------------------------------- 页面 -------------------------------- */

  /**
   * 由正文控件最低底部推导物理页数：floor(maxBottomMm / bodyHeightMm) + 1。
   * 与渲染端 layoutStaticOnly 的 `floor(top/contentHeight)` 落页口径一致（body 控件按
   * 上边距 + top 绝对定位，越过内容区底部即落入下一页）。
   */
  private computeContentPageCount(): number {
    let maxBottomMm = 0
    for (const obj of this.getPrintObjects()) {
      if (obj instanceof PrintZone) continue
      // 模型 mm（flush）口径：先反解页间距再算底部，与渲染/导出一致
      const topMm = this.yToModelTop(obj.top ?? 0)
      const bottom = topMm + obj.getScaledHeight() / MM_TO_PX
      if (bottom > maxBottomMm) maxBottomMm = bottom
    }
    // 物理页数按「正文可用高」推导：与渲染端 layoutStaticOnly 的 floor(top/bodyHeight) 一致
    return computePhysicalPageCount(maxBottomMm, this.bodyHeightMm)
  }

  /** 有效物理页数 = max(内容推导, 手动分页下限)，最小 1 */
  private computePageCount(): number {
    return Math.max(this.minPages, this.computeContentPageCount())
  }

  /** 内容推导页数（不含手动分页），供 store 的「加页」计算 */
  get contentPageCount(): number {
    return this.computeContentPageCount()
  }

  /** 当前有效物理页数 */
  get effectivePageCount(): number {
    return this.pageCount
  }

  /** 手动分页下限（0 = 完全由内容推导） */
  get manualPageCount(): number {
    return this.minPages
  }

  /** 设置手动分页下限并重建页面视觉 */
  setManualPageCount(n: number): void {
    this.minPages = Math.max(0, Math.floor(n) || 0)
    this.rebuildPages()
  }

  /**
   * 依据正文控件布局重建多页视觉：第 2..N 页白色背景、每页内容区参考线、
   * 内容区底部的分页虚线 + 「分页」标签、每页「第 N 页」页码标签。
   * 背景/参考线/分页线全部排在控件下方（控件 bringToFront），避免遮挡正文。
   */
  private rebuildPages(): void {
    const count = Math.max(1, this.computePageCount())
    const changed = count !== this.pageCount
    this.pageCount = count
    const stale = [
      ...this.extraPageRects,
      ...this.pageGuides,
      ...this.pageBreaks,
      ...this.pageLabels,
    ]
    for (const o of stale) this.canvas.remove(o)
    this.extraPageRects = []
    this.pageGuides = []
    this.pageBreaks = []
    this.pageLabels = []

    const pageW = this.pageWidthMm * MM_TO_PX
    const pageH = this.pageHeightMm * MM_TO_PX
    const stride = pageH + this.PAGE_GAP_PX
    const ml = this.marginMm.left * MM_TO_PX
    const mt = this.marginMm.top * MM_TO_PX
    const mr = this.marginMm.right * MM_TO_PX
    const mb = this.marginMm.bottom * MM_TO_PX
    const bodyH = Math.max(1, pageH - mt - mb)
    const contentW = Math.max(1, pageW - ml - mr)
    // 边距仅作可视化参考线：分页虚线画在「物理页底」（整页相对模型，越过页底才跨页）
    const bg = this.lastPageBackground || '#ffffff'

    // 第 2..N 页背景（按 stride 堆叠，带阴影）
    for (let i = 1; i < count; i++) {
      const r = new Rect({
        left: 0,
        top: i * stride,
        width: pageW,
        height: pageH,
        fill: bg,
        selectable: false,
        evented: false,
        hoverCursor: 'default',
        shadow: '0 2px 12px rgba(0,0,0,0.15)',
        excludeFromExport: true,
        objectCaching: false,
      } as never)
      ;(r as unknown as { isPageRect: boolean }).isPageRect = true
      this.canvas.add(r)
      this.extraPageRects.push(r)
    }

    // 每页内容区参考线（蓝色虚线）
    for (let i = 0; i < count; i++) {
      const g = new Rect({
        left: ml,
        top: i * stride + mt,
        width: contentW,
        height: bodyH,
        fill: '',
        stroke: '#1677ff',
        strokeWidth: 1,
        strokeDashArray: [4, 3],
        selectable: false,
        evented: false,
        hoverCursor: 'default',
        excludeFromExport: true,
        objectCaching: false,
        // 尊重「显示/隐藏参考线」开关：rebuildPages 重建后不复活
        visible: this.marginGuidesVisible,
      } as never)
      ;(g as unknown as { isMarginGuide: boolean }).isMarginGuide = true
      this.canvas.add(g)
      this.pageGuides.push(g)
    }

    // 每页内容区底部的分页虚线（最后一页不画），并标注「分页」
    for (let i = 0; i < count - 1; i++) {
      const y = i * stride + pageH
      const line = new Line([ml, y, ml + contentW, y], {
        stroke: '#f5222d',
        strokeWidth: 1,
        strokeDashArray: [6, 4],
        selectable: false,
        evented: false,
        excludeFromExport: true,
        objectCaching: false,
      } as never)
      this.canvas.add(line)
      this.pageBreaks.push(line)
      const tag = new Text('分页', {
        left: ml + 4,
        top: y - 13,
        fontSize: 9,
        fill: '#f5222d',
        selectable: false,
        evented: false,
        excludeFromExport: true,
      } as never)
      this.canvas.add(tag)
      this.pageLabels.push(tag)
    }

    // 每页页码标签（左上角）
    for (let i = 0; i < count; i++) {
      const lbl = new Text(`第 ${i + 1} 页`, {
        left: ml + 4,
        top: i * stride + 4,
        fontSize: 9,
        fill: '#999999',
        selectable: false,
        evented: false,
        excludeFromExport: true,
      } as never)
      this.canvas.add(lbl)
      this.pageLabels.push(lbl)
    }

    // 【层级修复】背景/参考线/分页线全部排在正文控件之下，杜绝「第二页盖住控件」
    for (const obj of this.getPrintObjects()) this.canvas.bringObjectToFront(obj)

    this.canvas.requestRenderAll()
    if (changed) this.events.onPageCountChange?.(count)
  }

  /** 正文控件布局变化后由外部调用，重算页数与分页线 */
  refreshPages(): void {
    this.rebuildPages()
  }

  /** 显示/隐藏页边距参考线（影响全部页）。状态被记住，rebuildPages 重建后保持 */
  setMarginGuidesVisible(visible: boolean): void {
    this.marginGuidesVisible = visible
    for (const g of this.pageGuides) g.visible = visible
    this.canvas.requestRenderAll()
  }

  /**
   * 设置页边距锁定。
   * - 锁定（默认）：正文控件移动被钳制在内容区内（边距=辅助设计参考线，锁定便于把内容排进安全区）
   * - 关闭：可自由移动/溢出到边距外（内外都会打印，边距仅参考线）
   * 开启时立即把已越界的正文控件拉回内容区。
   */
  setMarginLocked(locked: boolean): void {
    this.marginLocked = locked
    if (locked) {
      for (const obj of this.getPrintObjects()) {
        if (obj instanceof PrintZone) continue
        this.clampToContentArea(obj)
      }
      this.canvas.requestRenderAll()
    }
  }

  /** 把正文控件钳制在「当前所在页」的内容区内（边距内=设计安全区，X/Y 均受限）。
   *  边距仅作辅助设计参考线（不参与渲染），锁定可避免内容排进边距带。 */
  private clampToContentArea(obj: PrintFabricObject): void {
    const pageWpx = this.pageWidthMm * MM_TO_PX
    const pageHpx = this.pageHeightMm * MM_TO_PX
    const stride = pageHpx + this.PAGE_GAP_PX
    const w = obj.getScaledWidth()
    const h = obj.getScaledHeight()
    // 所在页：按对象中心 y 落在第几个 stride 区间
    const cy = (obj.top ?? 0) + h / 2
    const i = Math.max(0, Math.floor(cy / stride))
    const pageTop = i * stride
    const minX = pageTop + this.marginMm.left * MM_TO_PX
    const minY = pageTop + this.marginMm.top * MM_TO_PX
    const maxX = pageTop + (pageWpx - this.marginMm.right * MM_TO_PX) - w
    const maxY = pageTop + (pageHpx - this.marginMm.bottom * MM_TO_PX) - h
    obj.set({
      left: Math.max(minX, Math.min(maxX, obj.left ?? minX)),
      top: Math.max(minY, Math.min(maxY, obj.top ?? minY)),
    })
    obj.setCoords()
  }

  /**
   * 应用页面设置。
   * 【约定】PageSetup.width/height 一律是**物理尺寸**（实际打印宽高，横向时宽>高），
   * orientation 仅是派生标志（UI 用）。方向切换由面板在改 width/height 时完成，
   * 这里**不再**按 orientation 二次交换 —— 否则横向页会被换回纵向（旧 bug）。
   * 渲染端 computePageMetrics / 导出 export-pdf 同口径（w>h 判定），全链路所见即所得。
   */
  setPage(setup: PageSetup): void {
    this.pageWidthMm = toMm(setup.width, setup.unit)
    this.pageHeightMm = toMm(setup.height, setup.unit)
    this.marginMm = {
      top: toMm(setup.margin.top, setup.unit),
      bottom: toMm(setup.margin.bottom, setup.unit),
      left: toMm(setup.margin.left, setup.unit),
      right: toMm(setup.margin.right, setup.unit),
    }
    this.minPages = setup.minPages ?? 0
    this.pageRect.set({
      width: this.pageWidthMm * MM_TO_PX,
      height: this.pageHeightMm * MM_TO_PX,
      fill: this.lastPageBackground || '#ffffff',
    })
    // 页面尺寸变化：重建全部页视觉（背景/参考线/分页线/页码）后再注入水印
    this.rebuildPages()
    for (const z of this.getZones()) z.relayout(this.pageWidthMm, this.pageHeightMm)
    this.syncWatermark()
    this.canvas.requestRenderAll()
  }

  /** 设置画布页面背景色（不导出、随模板持久化）；同步填充所有页 */
  setPageBackground(color: string): void {
    this.lastPageBackground = color || '#ffffff'
    this.pageRect.set({ fill: this.lastPageBackground })
    for (const r of this.extraPageRects) r.set({ fill: this.lastPageBackground })
    this.canvas.requestRenderAll()
  }

  /** 设置画布水印（enabled=false 时清空；tile=全页平铺 / 否则居中单个） */
  setWatermark(cfg: WatermarkConfig | undefined): void {
    this.lastWatermark = cfg && cfg.enabled ? cfg : undefined
    this.syncWatermark()
  }

  /** 重建水印装饰层：先清旧对象，再按配置绘制 */
  private syncWatermark(): void {
    for (const o of this.watermarkObjs) this.canvas.remove(o)
    this.watermarkObjs = []
    const cfg = this.lastWatermark
    if (!cfg) {
      this.canvas.requestRenderAll()
      return
    }

    const pageWpx = this.pageWidthMm * MM_TO_PX
    const pageHpx = this.pageHeightMm * MM_TO_PX
    const fontSizePx = Math.max(1, cfg.fontSize) * MM_TO_PX
    const fontFamily = '"Source Han Sans CN", "PingFang SC", sans-serif'

    if (cfg.tile) {
      // 全页平铺：用离屏 canvas 生成单个旋转水印瓦片，作为 pageRect 之上的 Pattern
      const spacingMm = Math.max(cfg.fontSize * 2.6, 14)
      const tilePx = Math.max(1, Math.ceil(spacingMm * MM_TO_PX))
      const tile = document.createElement('canvas')
      tile.width = tilePx
      tile.height = tilePx
      const ctx = tile.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, tilePx, tilePx)
        ctx.translate(tilePx / 2, tilePx / 2)
        ctx.rotate((cfg.rotation * Math.PI) / 180)
        ctx.fillStyle = cfg.color
        ctx.font = `${fontSizePx}px ${fontFamily}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(cfg.text || '', 0, 0)
      }
      const pattern = new Pattern({ source: tile, repeat: 'repeat' })
      const rect = new Rect({
        left: 0,
        top: 0,
        width: pageWpx,
        height: pageHpx,
        fill: pattern as unknown as string,
        selectable: false,
        evented: false,
        excludeFromExport: true,
        objectCaching: false,
      } as never)
      ;(rect as unknown as { isWatermark: boolean }).isWatermark = true
      this.canvas.insertAt(1, rect)
      this.watermarkObjs.push(rect)
    } else {
      // 居中单个
      const text = new Text(cfg.text || ' ', {
        left: pageWpx / 2,
        top: pageHpx / 2,
        originX: 'center',
        originY: 'center',
        fontSize: fontSizePx,
        fill: cfg.color,
        fontFamily,
        angle: cfg.rotation,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      } as never)
      ;(text as unknown as { isWatermark: boolean }).isWatermark = true
      this.canvas.insertAt(1, text)
      this.watermarkObjs.push(text)
    }

    this.canvas.requestRenderAll()
  }

  /**
   * 正文控件协议坐标原点 = 物理页左上角 (0,0)。
   * 边距仅作可视化辅助参考线，不参与渲染/导出偏移——所见即所得，
   * 控件拖到哪、渲染/导出就在哪（整页相对坐标）。
   */
  get contentOriginPx(): { x: number; y: number } {
    return { x: 0, y: 0 }
  }

  /* ------------------------------- 控件 CRUD ------------------------------ */

  getPrintObjects(): PrintFabricObject[] {
    return this.canvas.getObjects().filter(isPrintObject) as PrintFabricObject[]
  }

  getControlById(id: string): PrintFabricObject | undefined {
    return this.getPrintObjects().find((o) => o.controlId === id)
  }

  getZones(): PrintZone[] {
    return this.getPrintObjects().filter((o): o is PrintZone => o instanceof PrintZone)
  }

  hasZone(zone: 'header' | 'footer'): boolean {
    return this.getZones().some((z) => z.zone === zone)
  }

  addControl(
    control: AnyControl,
    opts: { select?: boolean; zoneHostId?: string } = {},
  ): void {
    const obj = createFabricControl(control, {
      widthMm: this.pageWidthMm,
      heightMm: this.pageHeightMm,
      marginLeftMm: this.marginMm.left,
      marginRightMm: this.marginMm.right,
    })
    // 协议坐标（相对内容区/所属色带）→ 画布绝对坐标
    this.applySectionOrigin(obj, control, opts.zoneHostId)
    // 镜像「常驻辅助线」开关到 Fabric 对象，供 SmartGuides 读取
    ;(obj as unknown as { showGuides: boolean }).showGuides = control.showGuides ?? false
    this.canvas.add(obj)
    // 标签网格：首卡子组件以真实 Fabric 对象渲染（可选中/拖动/编辑，所见即所得）
    if (control.type === 'labelgrid') {
      this.syncGridChildren(control as LabelGridControl)
    }
    if (opts.select ?? true) this.canvas.setActiveObject(obj)
    this.refreshPages()
    this.canvas.requestRenderAll()
  }

  /**
   * 同步标签网格的「首卡子组件」为真实 Fabric 对象（建/改/删三向）。
   *
   * - 新增：按模型（卡内相对坐标 + 网格左上角）创建子对象，标记 `childOf = grid.id`；
   * - 已存在：走 `updateControl` 按模型刷新几何与属性；
   * - 模型已删除：从画布移除。
   *
   * 子对象位于网格位图之上，可像普通控件一样选中 / 拖动 / 缩放 / 删除，
   * 拖动结束由 `readControl` 把卡内相对坐标写回模型 → 预览 / 导出逐卡复刻。
   */
  syncGridChildren(grid: LabelGridControl): void {
    const gridObj = this.getControlById(grid.id)
    if (!gridObj || gridObj.controlType !== 'labelgrid') return
    const existing = new Map(
      this.getPrintObjects()
        .filter((o) => o.childOf === grid.id)
        .map((o) => [o.controlId, o] as const),
    )
    const page = {
      widthMm: this.pageWidthMm,
      heightMm: this.pageHeightMm,
      marginLeftMm: this.marginMm.left,
      marginRightMm: this.marginMm.right,
    }
    for (const child of grid.children ?? []) {
      if (child.type === 'zone' || child.type === 'labelgrid') continue
      const cobj = existing.get(child.id)
      if (cobj) {
        // 已存在：按模型（卡内相对坐标 + childOf）重定位/刷属性
        this.updateControl({ ...child, childOf: grid.id } as AnyControl)
      } else {
        // 新增：绝对坐标 = 网格左上角 + 卡内相对坐标
        const absChild: AnyControl = {
          ...child,
          left: (grid.left ?? 0) + (child.left ?? 0),
          top: (grid.top ?? 0) + (child.top ?? 0),
        }
        const obj = createFabricControl(absChild, page)
        this.applySectionOrigin(obj, absChild)
        ;(obj as unknown as { showGuides: boolean }).showGuides = false
        ;(obj as IPrintObject).childOf = grid.id
        this.canvas.add(obj)
      }
    }
    for (const [cid, obj] of existing) {
      if (!(grid.children ?? []).some((c) => c.id === cid)) this.canvas.remove(obj)
    }
    this.canvas.requestRenderAll()
  }

  /** 清空全部控件（保留页面矩形），加载模板前调用 */
  clearControls(): void {
    for (const obj of this.getPrintObjects()) this.canvas.remove(obj)
    this.canvas.discardActiveObject()
    this.refreshPages()
    this.canvas.requestRenderAll()
  }

  /**
   * 按给定 id 顺序（bottom→top）重排正文控件的 z-order，使画布与设计模型 / 预览一致。
   * 仅重排列出的 body 控件，页眉/页脚色带（zone）保持原位。所见即所得：图层面板上下
   * 移动即同步到画布与渲染输出。
   */
  syncZOrder(orderedIds: string[]): void {
    const all = this.canvas.getObjects()
    const firstPrint = all.findIndex(isPrintObject)
    const base = firstPrint >= 0 ? firstPrint : 0
    const byId = new Map(this.getPrintObjects().map((o) => [o.controlId, o]))
    let i = 0
    for (const id of orderedIds) {
      const obj = byId.get(id)
      if (obj) this.canvas.moveObjectTo(obj, base + i++)
    }
    this.canvas.requestRenderAll()
  }

  /** body 控件加内容区偏移（含页间距）；zone 子控件加所属色带偏移（MVP：按几何中心归属） */
  private applySectionOrigin(
    obj: PrintFabricObject,
    control: AnyControl,
    zoneHostId?: string,
  ): void {
    if (control.type === 'zone') return
    if (zoneHostId) {
      const host = this.getControlById(zoneHostId)
      if (host) {
        // zone 子控件：相对色带左上角，无页间距
        obj.set({
          left: (Number.isFinite(obj.left) ? obj.left! : 0) + (host.left ?? 0),
          top: (Number.isFinite(obj.top) ? obj.top! : 0) + (host.top ?? 0),
        })
      }
    } else {
      // body 控件：obj.top 此刻是 mm→px（相对页顶），modelTopToY 叠加内容区偏移与页间距
      obj.set({
        left: (Number.isFinite(obj.left) ? obj.left! : 0) + this.contentOriginPx.x,
        top: this.modelTopToY((obj.top ?? 0) / MM_TO_PX),
      })
    }
    obj.setCoords()
  }

  updateControl(control: AnyControl): void {
    const obj = this.getControlById(control.id)
    if (!obj) return
    if (control.type !== 'zone') {
      // 几何同步：协议 mm（相对内容区/所属色带）→ 画布绝对 px（含页间距）
      if (control.childOf) {
        // 标签网格首卡子组件：相对所属网格左上角（读回模型时 readControl 反向换算）
        const gridObj = this.getControlById(control.childOf)
        if (gridObj) {
          obj.set({
            left: (gridObj.left ?? 0) + control.left * MM_TO_PX,
            top: (gridObj.top ?? 0) + control.top * MM_TO_PX,
            angle: control.angle ?? 0,
          })
        }
      } else {
        const origin = this.originFor(obj)
        obj.set({
          left: origin.x + control.left * MM_TO_PX,
          top: origin.y + control.top * MM_TO_PX + (obj instanceof PrintZone ? 0 : this.gapPx(control.top)),
          angle: control.angle ?? 0,
        })
      }
      if (obj instanceof PrintText) {
        // 文本框：直接改宽度重排文字，不缩放字形
        obj.set({ width: control.width * MM_TO_PX, scaleX: 1, scaleY: 1 })
      } else if (obj.width && obj.height) {
        // 其余控件：按目标尺寸等比缩放（Group/Line/位图均适用）
        obj.set({
          scaleX: (control.width * MM_TO_PX) / obj.width,
          scaleY: (control.height * MM_TO_PX) / obj.height,
        })
      }
      obj.setCoords()
    }
    ;(obj as IPrintObject).applyControlProps(control)
    // 同步「常驻辅助线」开关到 Fabric 对象（控制面板实时切换即生效）
    ;(obj as unknown as { showGuides: boolean }).showGuides = control.showGuides ?? false
    // 网格几何/位置变化 → 首卡子组件按模型重新锚定（跟随网格移动/重排）
    if (control.type === 'labelgrid') this.syncGridChildren(control as LabelGridControl)
    this.refreshPages()
    this.canvas.requestRenderAll()
  }

  /** 几何中心落在哪个色带内（§5.14.2 子控件坐标相对色带左上角） */
  private hostZoneOf(obj: PrintFabricObject): PrintZone | undefined {
    if (obj instanceof PrintZone) return undefined
    const center = obj.getCenterPoint()
    return this.getZones().find((z) => {
      const b = z.getBoundingRect()
      return (
        center.x >= b.left && center.x <= b.left + b.width && center.y >= b.top && center.y <= b.top + b.height
      )
    })
  }

  /** 对象协议坐标原点：zone 子控件用色带左上角，其余用页边距内容区左上角 */
  private originFor(obj: PrintFabricObject): { x: number; y: number } {
    const host = this.hostZoneOf(obj)
    if (host) return { x: host.left ?? 0, y: host.top ?? 0 }
    return this.contentOriginPx
  }

  /**
   * 读取 Fabric 对象为**协议控件**。
   *
   * 【重要】`obj.toControl()` 返回的 left/top 是 **Fabric 绝对画布坐标**，
   * 而协议层 / store 模型一律是「相对内容区（或所属色带）左上角」的 mm。
   * 任何要把画布状态写回 store 的路径都必须走本方法归一化，否则 `updateControl()`
   * 会再叠加一次 origin，导致控件每次操作都向右下平移一个页边距。
   */
  readControl(obj: PrintFabricObject): AnyControl {
    const control = obj.toControl()
    if (obj instanceof PrintZone || control.type === 'zone') return control
    const host = this.hostZoneOf(obj)
    const origin = host ? { x: host.left ?? 0, y: host.top ?? 0 } : this.contentOriginPx
    const abs = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const rel = (v: number, o: number): number => Math.round(((v - o) / MM_TO_PX) * 100) / 100
    const left = rel(abs(obj.left), origin.x)
    // body 控件反解页间距（zone 子控件相对色带，间距恒为 0）
    const top = host ? rel(abs(obj.top), origin.y) : Math.round(this.yToModelTop(abs(obj.top)) * 100) / 100
    // 标签网格首卡子组件：坐标归一为「相对所属网格左上角」（卡内 mm），并携带 childOf 标记
    if (obj.childOf) {
      const gridObj = this.getControlById(obj.childOf)
      if (gridObj) {
        const cLeft = rel(abs(obj.left), this.contentOriginPx.x)
        const cTop = Math.round(this.yToModelTop(abs(obj.top)) * 100) / 100
        const gLeft = rel(abs(gridObj.left), this.contentOriginPx.x)
        const gTop = Math.round(this.yToModelTop(abs(gridObj.top)) * 100) / 100
        control.left = Math.round((cLeft - gLeft) * 100) / 100
        control.top = Math.round((cTop - gTop) * 100) / 100
        control.childOf = obj.childOf
      }
      return control
    }
    // 色带子控件不允许溢出到色带上方/左侧
    control.left = host ? Math.max(0, left) : left
    control.top = host ? Math.max(0, top) : top
    return control
  }

  removeControl(id: string): void {
    const obj = this.getControlById(id)
    if (!obj) return
    // 删除标签网格时级联删除其首卡子对象
    if (obj.controlType === 'labelgrid') {
      for (const c of this.getPrintObjects()) {
        if (c.childOf === id) this.canvas.remove(c)
      }
    }
    this.canvas.remove(obj)
    this.canvas.discardActiveObject()
    this.refreshPages()
    this.canvas.requestRenderAll()
  }

  setActiveControl(id: string | null): void {
    if (!id) {
      this.canvas.discardActiveObject()
    } else {
      const obj = this.getControlById(id)
      if (obj) this.canvas.setActiveObject(obj)
    }
    this.canvas.requestRenderAll()
  }

  /* ------------------------------- 序列化 -------------------------------- */

  /**
   * 导出当前画布为协议组件列表。
   * zone 子控件归属判定：几何中心落在色带内（§5.14.2 子组件坐标相对色带左上角）。
   */
  serialize(): { body: AnyControl[]; zones: ZoneControl[] } {
    const zones = this.getZones()
    const zoneControls: ZoneControl[] = zones.map((z) => z.toControl())
    const body: AnyControl[] = []
    // 标签网格首卡子组件按所属网格收集（画布为真理源，序列化时重建 children）
    const childrenByGrid = new Map<string, AnyControl[]>()

    for (const obj of this.getPrintObjects()) {
      if (obj instanceof PrintZone) continue
      // readControl 已把几何归一化到「相对色带 / 相对内容区」
      const control = this.readControl(obj)
      if (control.childOf) {
        const arr = childrenByGrid.get(control.childOf) ?? []
        arr.push(control)
        childrenByGrid.set(control.childOf, arr)
        continue
      }
      const host = this.hostZoneOf(obj)
      if (host) {
        const zc = zoneControls.find((z) => z.zone === host.zone)
        zc?.children.push(control)
      } else {
        body.push(control)
      }
    }

    // 网格的 children 以画布子对象为准（避免模型快照与画布状态漂移）
    for (const c of body) {
      if (c.type === 'labelgrid') {
        c.children = childrenByGrid.get(c.id) ?? []
      }
    }
    return { body, zones: zoneControls }
  }

  /* ------------------------------- 缩放平移 ------------------------------- */

  get zoom(): number {
    return this.canvas?.getZoom() ?? 1
  }

  setZoom(zoom: number, center?: Point): void {
    this.userZoomed = true
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
    const point =
      center ?? new Point(this.canvas.getWidth() / 2, this.canvas.getHeight() / 2)
    this.canvas.zoomToPoint(point, z)
    this.emitViewport()
  }

  zoomIn(): void {
    this.setZoom(this.zoom + 0.25)
  }

  zoomOut(): void {
    this.setZoom(this.zoom - 0.25)
  }

  /** 适配宿主容器（缩放工具栏「适应页面」用；init 时记住的 container） */
  fitToHost(): void {
    if (this.containerEl) this.fitToContainer(this.containerEl)
  }

  /** 适配容器：按页宽适配（上限 200%），文档可整页容纳则垂直居中，否则顶部对齐以便向下滚动翻页 */
  fitToContainer(container: HTMLElement): void {
    const pageW = this.pageWidthMm * MM_TO_PX
    const stride = this.pageHeightMm * MM_TO_PX + this.PAGE_GAP_PX
    const docH = this.pageCount * stride
    const zoom = Math.min((container.clientWidth - 96) / pageW, 2)
    const vt = this.canvas.viewportTransform
    vt[0] = vt[3] = zoom
    vt[4] = (container.clientWidth - pageW * zoom) / 2
    const usedH = docH * zoom
    vt[5] = usedH <= container.clientHeight - 96 ? Math.max(48, (container.clientHeight - usedH) / 2) : 48
    this.canvas.setViewportTransform(vt)
    this.canvas.requestRenderAll()
    this.emitViewport()
  }

  /** 滚动视口使第 index 页（0 起）顶部对齐到视口上方（顶部留 48px） */
  scrollToPage(index: number): void {
    const stride = (this.pageHeightMm * MM_TO_PX + this.PAGE_GAP_PX) * this.zoom
    const vt = this.canvas.viewportTransform
    const viewH = this.canvas.getHeight()
    const docH = this.pageCount * stride
    const topY = Math.max(0, Math.min(index, this.pageCount - 1)) * stride
    let y = 48 - topY
    // 约束：不滚出文档顶部 / 底部
    const maxY = 48
    const minY = Math.min(maxY, viewH - docH - 48)
    vt[5] = Math.max(Math.min(y, maxY), minY)
    this.canvas.setViewportTransform(vt)
    this.canvas.requestRenderAll()
    this.emitViewport()
  }

  getViewportState(): ViewportState {
    const vt = this.canvas.viewportTransform
    return { zoom: this.zoom, offsetX: vt[4] ?? 0, offsetY: vt[5] ?? 0 }
  }

  private emitViewport(): void {
    this.events.onViewportChange?.(this.getViewportState())
    // 视口变化同样需要驱动表格 HTML overlay 重定位
    this.events.onTransformTick?.()
  }

  /* -------------------------------- 事件 -------------------------------- */

  private bindEvents(): void {
    const c = this.canvas

    const emitSelection = () => {
      const active = c.getActiveObjects().filter(isPrintObject) as PrintFabricObject[]
      this.events.onSelectionChange?.(active.map((o) => o.controlId))
    }
    c.on('selection:created', emitSelection)
    c.on('selection:updated', emitSelection)
    c.on('selection:cleared', () => this.events.onSelectionChange?.([]))

    // 对象变换 / 视口变化 → 驱动表格 HTML overlay 重定位
    const bump = () => this.events.onTransformTick?.()
    // 拖拽起点快照（网格拖动时用增量移动首卡子对象）
    c.on('mouse:down', (opt) => {
      const t = opt.target
      if (t) (t as { __prevPos?: { left: number; top: number } }).__prevPos = { left: t.left ?? 0, top: t.top ?? 0 }
    })
    // 边距锁定：正文控件移动时钳制在内容区内（边距=设计安全区；页眉/页脚色带自身锁定位置，其子控件在边距区不受限）
    c.on('object:moving', (e) => {
      const obj = e.target
      if (obj && isPrintObject(obj)) {
        if (this.marginLocked && !(obj instanceof PrintZone) && !obj.zoneId) {
          this.clampToContentArea(obj)
        }
        // 标签网格整体拖动 → 首卡子对象按同一增量跟随（所见即所得）
        if (obj.controlType === 'labelgrid') {
          const prev =
            (obj as { __prevPos?: { left: number; top: number } }).__prevPos ?? {
              left: obj.left ?? 0,
              top: obj.top ?? 0,
            }
          const dx = (obj.left ?? 0) - prev.left
          const dy = (obj.top ?? 0) - prev.top
          if (dx || dy) {
            for (const child of this.getPrintObjects()) {
              if (child.childOf === obj.controlId) {
                child.set({ left: (child.left ?? 0) + dx, top: (child.top ?? 0) + dy })
                child.setCoords()
              }
            }
            ;(obj as { __prevPos?: { left: number; top: number } }).__prevPos = {
              left: obj.left ?? 0,
              top: obj.top ?? 0,
            }
          }
        }
      }
      bump()
    })
    c.on('object:scaling', bump)
    c.on('object:rotating', bump)
    c.on('object:modified', bump)
    c.on('object:added', bump)
    c.on('object:removed', bump)

    // 双击单元格：进入原生 contenteditable 编辑（方案 A）
    c.on('mouse:dblclick', (opt) => {
      const target = opt.target
      if (!(target instanceof PrintTable)) return
      // 必须用 readControl（相对坐标），直接 toControl() 会把绝对坐标写进 store 导致漂移
      const control = this.readControl(target) as TableControl
      const ensured = ensureCells(control)
      // 场景坐标 → 控件局部坐标（先平移到左上角原点，再反向旋转，最后归一化）
      const dx = opt.scenePoint.x - (target.left ?? 0)
      const dy = opt.scenePoint.y - (target.top ?? 0)
      const rad = (-(target.angle ?? 0) * Math.PI) / 180
      const localX = dx * Math.cos(rad) - dy * Math.sin(rad)
      const localY = dx * Math.sin(rad) + dy * Math.cos(rad)
      const hit = hitTestCell(
        computeGridLayout(ensured),
        localX / Math.max(1e-6, target.getScaledWidth()),
        localY / Math.max(1e-6, target.getScaledHeight()),
      )
      if (!hit) return
      this.events.onCellEdit?.({ controlId: target.controlId, control: ensured, row: hit.row, col: hit.col })
    })

    c.on('object:modified', (e) => {
      const obj = e.target
      if (!obj || !isPrintObject(obj)) return
      if (obj instanceof PrintZone) {
        // zone 只允许改高度：把位置吸附回页顶/页底
        obj.relayout(this.pageWidthMm, this.pageHeightMm)
      }
      // 位图类控件缩放结束后按新尺寸重渲染，保证清晰
      const regenerable = obj as Partial<{ regenerate: () => void }>
      if (typeof regenerable.regenerate === 'function' && !(obj instanceof PrintZone)) {
        const scaledW = obj.getScaledWidth()
        const scaledH = obj.getScaledHeight()
        obj.set({ width: scaledW, height: scaledH, scaleX: 1, scaleY: 1 })
        regenerable.regenerate()
      }
      this.events.onObjectModified?.(this.readControl(obj))
      // 移动/缩放结束后正文布局可能跨页，刷新页数与分页线
      this.refreshPages()
    })

    // Ctrl/Cmd + 滚轮缩放；普通滚轮 = 垂直平移；Shift+滚轮 = 水平平移
    c.on('mouse:wheel', (opt: TPointerEventInfo<WheelEvent>) => {
      const e = opt.e
      e.preventDefault()
      e.stopPropagation()
      const vt = c.viewportTransform
      if (e.ctrlKey || e.metaKey) {
        const delta = e.deltaY
        const zoom = this.zoom * 0.999 ** delta
        this.setZoom(zoom, new Point(e.offsetX, e.offsetY))
      } else {
        if (e.shiftKey) {
          vt[4] = (vt[4] ?? 0) - e.deltaY
        } else {
          vt[5] = (vt[5] ?? 0) - e.deltaY
          vt[4] = (vt[4] ?? 0) - e.deltaX
        }
        c.setViewportTransform(vt)
        c.requestRenderAll()
        this.emitViewport()
      }
    })

    // 空格 + 拖拽 = 平移；触屏（pointer:coarse）单指空白拖拽 = 平移（桌面保持框选）
    c.on('mouse:down', (opt) => {
      const e = opt.e
      const touches = (e as TouchEvent).touches
      const coarseBlankPan =
        this.coarsePointer && !!touches && touches.length === 1 && !opt.target

      // P6.4 触屏长按控件（约 500ms，无右键的移动端上下文菜单入口）
      if (this.coarsePointer && opt.target && touches && touches.length === 1) {
        const controlId = (opt.target as { controlId?: string }).controlId
        if (controlId) {
          const p0 = pointerClientXY(e)
          this.longPressStart = p0
          this.clearLongPressTimer()
          this.longPressTimer = setTimeout(() => {
            this.longPressTimer = null
            this.events.onLongPress?.(controlId, { x: p0.x, y: p0.y })
          }, 500)
          // 移动超阈值 / 抬手 / 第二指按下 → 取消长按
          const offMove = this.addTempListener('touchmove', (ev) => {
            const p = pointerClientXY(ev as unknown as TouchEvent)
            if (Math.hypot(p.x - this.longPressStart.x, p.y - this.longPressStart.y) > 10) {
              this.clearLongPressTimer()
              offMove()
              offEnd()
            }
          }, { passive: true })
          const offEnd = this.addTempListener('touchend', () => {
            this.clearLongPressTimer()
            offMove()
            offEnd()
          })
        }
      }

      if (this.spacePanning) {
        const pt = pointerClientXY(e)
        let lastX = pt.x
        let lastY = pt.y
        c.selection = false
        c.defaultCursor = 'grab'
        const vt = c.viewportTransform
        const offMove = this.addTempListener('mousemove', (ev) => {
          vt[4] = (vt[4] ?? 0) + (ev.clientX - lastX)
          vt[5] = (vt[5] ?? 0) + (ev.clientY - lastY)
          lastX = ev.clientX
          lastY = ev.clientY
          c.setViewportTransform(vt)
          c.requestRenderAll()
          this.emitViewport()
        })
        const offUp = this.addTempListener('mouseup', () => {
          offMove()
          offUp()
          c.selection = true
          c.defaultCursor = 'default'
        })
      } else if (coarseBlankPan) {
        const pt0 = pointerClientXY(e)
        let lastX = pt0.x
        let lastY = pt0.y
        c.selection = false
        c.defaultCursor = 'grab'
        const offMove = this.addTempListener('touchmove', (ev) => {
          const tev = ev as unknown as TouchEvent
          if (tev.touches.length !== 1) return
          tev.preventDefault()
          const p = pointerClientXY(tev)
          const vt = c.viewportTransform
          vt[4] = (vt[4] ?? 0) + (p.x - lastX)
          vt[5] = (vt[5] ?? 0) + (p.y - lastY)
          lastX = p.x
          lastY = p.y
          c.setViewportTransform(vt)
          c.requestRenderAll()
          this.emitViewport()
        }, { passive: false })
        const offEnd = this.addTempListener('touchend', () => {
          offMove()
          offEnd()
          c.selection = true
          c.defaultCursor = 'default'
        })
        const offCancel = this.addTempListener('touchcancel', () => {
          offMove()
          offEnd()
          offCancel()
          c.selection = true
          c.defaultCursor = 'default'
        })
      }
    })

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && !this.isEditingText()) {
      this.spacePanning = true
      e.preventDefault()
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.spacePanning = false
  }

  /**
   * P6.3 触屏手势（框架无关，Vue/React 两端共用）：
   * - 双指捏合：锚点缩放 + 中点平移（capture + preventDefault 阻断浏览器页面缩放）
   * - 单指空白拖拽（仅 pointer:coarse）：平移画布（桌面空白拖拽保持框选语义）
   */
  private bindTouchGestures(el: HTMLElement): void {
    const onTouchStart = (e: TouchEvent): void => {
      const pinch = parsePinch(e.touches)
      if (!pinch) return
      e.preventDefault()
      e.stopPropagation()
      // 双指接管：清空 Fabric 选区/框选，避免捏合误拖控件；取消未完成的长按
      this.clearLongPressTimer()
      this.canvas.discardActiveObject()
      this.canvas.selection = false
      this.touchPinch = { prev: pinch }
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (!this.touchPinch) return
      const next = parsePinch(e.touches)
      if (!next) return
      e.preventDefault()
      e.stopPropagation()
      const { zoom, dx, dy } = pinchTransform(this.touchPinch.prev, next, this.zoom)
      // 先平移再以新中点为锚缩放
      const vt = this.canvas.viewportTransform
      vt[4] = (vt[4] ?? 0) + dx
      vt[5] = (vt[5] ?? 0) + dy
      this.canvas.setViewportTransform(vt)
      this.setZoom(zoom, new Point(next.midX, next.midY))
      this.userZoomed = true
      this.canvas.requestRenderAll()
      this.touchPinch = { prev: next }
    }
    const onTouchEnd = (): void => {
      if (!this.touchPinch) return
      this.touchPinch = null
      this.canvas.selection = true
      this.emitViewport()
    }
    const opts: AddEventListenerOptions = { capture: true, passive: false }
    el.addEventListener('touchstart', onTouchStart, opts)
    el.addEventListener('touchmove', onTouchMove, opts)
    el.addEventListener('touchend', onTouchEnd, opts)
    el.addEventListener('touchcancel', onTouchEnd, opts)
    this.touchCleanup.push(() => {
      el.removeEventListener('touchstart', onTouchStart, opts)
      el.removeEventListener('touchmove', onTouchMove, opts)
      el.removeEventListener('touchend', onTouchEnd, opts)
      el.removeEventListener('touchcancel', onTouchEnd, opts)
    })
  }

  private isEditingText(): boolean {
    const active = this.canvas.getActiveObject() as unknown as { isEditing?: boolean } | undefined
    return !!active?.isEditing
  }

  /* ----------------------------- 网格控制 ------------------------------ */

  setGridSize(sizeMm: number): void {
    if (this.smartGuides) this.smartGuides.config.gridSizeMm = sizeMm
  }

  setGridColor(color: string): void {
    if (this.smartGuides) this.smartGuides.config.gridColor = color
    this.canvas.requestRenderAll()
  }

  setGridVisible(visible: boolean): void {
    if (this.smartGuides) this.smartGuides.config.gridVisible = visible
    this.canvas.requestRenderAll()
  }
}
