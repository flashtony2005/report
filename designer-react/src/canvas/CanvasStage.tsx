/**
 * CanvasStage —— 画布舞台（React 版）
 *
 * 与 Vue 版 `canvas/CanvasStage.vue` 职责一致：Fabric canvas 宿主 + 标尺覆盖层。
 * 本组件是「引擎（复用的 CanvasDesigner）」与「React store」的接合点：
 *
 * - 挂载：new CanvasDesigner → init（事件接线到 zustand）→ attachCanvasHost
 * - 卸载：dispose → detachCanvasHost —— **必须幂等**（React StrictMode 下
 *   useEffect 会挂载-卸载-再挂载各跑一次）
 * - Fabric 实例只存在于 CanvasDesigner 内部（模块级 canvasHost 句柄），
 *   绝不进 zustand state —— 与 Vue 版用 shallowRef 是同一个理由
 * - 表格/图表/公式走**方案 A 覆盖层**：真实视觉由 HTML/SVG overlay 承担，
 *   Fabric 对象只做命中 / 手柄 / 层级（几何与内容组装复用 Vue 端同源的 overlay-logic）
 */
import { useEffect, useRef, useState } from 'react'
import { CanvasDesigner } from '@/design/canvas/CanvasDesigner'
import { loadBuiltinFonts } from '@/core/fonts/loader'
import { RULER_THICK } from '@/utils/constants'
import {
  attachCanvasHost,
  detachCanvasHost,
  getCanvasHost,
  useDesignerStore,
  type CanvasHost,
} from '../stores/designer'
import { useUiStore } from '../stores/ui'
import RulerOverlay from './RulerOverlay'
import ZoomBar from './ZoomBar'
import TableViewLayer from './TableViewLayer'
import ChartViewLayer from './ChartViewLayer'
import MathViewLayer from './MathViewLayer'
import { LongPressMenu, type LongPressMenuState } from './LongPressMenu'
import { useDragDrop } from './useDragDrop'
import { useHotkey } from '../hooks/useHotkey'
import type { AnyControl } from '@/types/control'

export default function CanvasStage() {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasHostRef = useRef<HTMLDivElement | null>(null)
  // 控件库拖入画布：dragover/drop 落控件（P5.1，与 Vue 版 useDragAdd 等价）
  useDragDrop(stageRef)
  // 全局快捷键：Delete 删除选中控件 / mod+Z 撤销 / mod+D 复制 / Esc 取消选中
  useHotkey()
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const [stageWidth, setStageWidth] = useState(0)
  const [stageHeight, setStageHeight] = useState(0)

  const showMarginGuides = useUiStore((s) => s.showMarginGuides)
  const gridVisible = useDesignerStore((s) => s.gridConfig.visible)
  const gridSizeMm = useDesignerStore((s) => s.gridConfig.sizeMm)
  const gridColor = useDesignerStore((s) => s.gridConfig.color)
  // P6.4 触屏长按菜单
  const [longPress, setLongPress] = useState<LongPressMenuState | null>(null)
  /**
   * 画布内核挂载就绪后再渲染 HTML/SVG 覆盖层（表格 / 图表 / 公式），
   * 避免 attachCanvasHost 之前 overlay 里 getObjects() 取不到对象而白渲染一帧。
   * 与 Vue 版 `canvasReady` ref 等价。
   */
  const [canvasReady, setCanvasReady] = useState(false)

  /* ---------- 挂载 / 卸载画布内核（幂等） ---------- */

  useEffect(() => {
    const canvasEl = canvasElRef.current
    const host = canvasHostRef.current
    const stage = stageRef.current
    if (!canvasEl || !host) return

    // 标尺尺寸取 **stage**（含左侧/顶部 20px 标尺带），不取 canvas 宿主——
    // 否则 svg 比舞台小 20px，标尺带在右端/底端各空出一截底色（视觉上"标尺没画满"）
    const measure = () => {
      if (!stage) return
      setStageWidth(stage.clientWidth)
      setStageHeight(stage.clientHeight)
    }
    measure()

    const store = useDesignerStore.getState()
    const ui = useUiStore.getState()
    const d = new CanvasDesigner()
    d.init(canvasEl, host, {
      onSelectionChange: (ids) => {
        // 选中切走等场景由 store 统一持有（多选也直接落地）；
        // 走 setSelection 而非裸 setState —— 它内含「选中集不含正在编辑的表格 → 退出编辑」联动
        useDesignerStore.getState().setSelection(ids)
      },
      onObjectModified: (control) => {
        useDesignerStore.getState().applyCanvasControl(control)
      },
      onViewportChange: (vp) => {
        useDesignerStore.getState().setViewport(vp)
      },
      onPageCountChange: (count) => {
        const s = useDesignerStore.getState()
        s.setPageCount(count)
      },
      onTransformTick: () => {
        // Fabric 对象不是响应式的：移动/缩放/视口变化靠打点驱动覆盖层重算定位
        useDesignerStore.getState().bumpCanvasTick()
      },
      onCellEdit: (info) => {
        // 双击表格命中单元格：物化 cells 网格（派生数据，不入撤销栈、不标脏）后进入编辑
        const s = useDesignerStore.getState()
        s.updateControlSilent(info.controlId, info.control as Partial<AnyControl>)
        s.openCellEditor(info.controlId, info.row, info.col)
      },
      onLongPress: (controlId, screen) => {
        // 长按即选中（属性抽屉联动），再弹上下文菜单
        useDesignerStore.getState().selectControl(controlId)
        setLongPress({ controlId, x: screen.x, y: screen.y })
      },
    })

    // CanvasDesigner 方法面与 CanvasHost 接口一致（同名同义），直接挂接
    attachCanvasHost(d as unknown as CanvasHost)
    // 内核已挂载：可以安全渲染覆盖层（此时 canvas.getObjects() 才有内容）
    setCanvasReady(true)

    // 初始同步：页边距参考线 / 网格（与 Vue 版 onMounted 相同）
    d.setMarginGuidesVisible(ui.showMarginGuides)
    d.setGridVisible(store.gridConfig.visible)
    d.setGridSize(store.gridConfig.sizeMm)
    d.setGridColor(store.gridConfig.color)
    d.setPage(store.pageSetup)
    d.setPageBackground(store.pageSetup.backgroundColor ?? '#ffffff')
    d.setWatermark(store.pageSetup.watermark)

    // 内置字体注册完成后刷新画布
    void loadBuiltinFonts().then(() => {
      document.fonts?.ready
        .then(() => d.canvas.requestRenderAll())
        .catch(() => undefined)
    })

    // dev 调试句柄（与 Vue 版一致）
    if (import.meta.env.DEV) {
      ;(window as unknown as { __op: unknown }).__op = useDesignerStore
    }

    const ro = new ResizeObserver(measure)
    ro.observe(stage ?? host)

    return () => {
      ro.disconnect()
      setCanvasReady(false)
      detachCanvasHost()
      d.dispose()
    }
    // 挂载一次即可；显隐/网格变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- 视觉开关联动（与 Vue 版 watch 一致） ---------- */

  useEffect(() => {
    getCanvasHost()?.setMarginGuidesVisible(showMarginGuides)
  }, [showMarginGuides])

  useEffect(() => {
    getCanvasHost()?.setGridVisible(gridVisible)
  }, [gridVisible])

  useEffect(() => {
    getCanvasHost()?.setGridSize(gridSizeMm)
  }, [gridSizeMm])

  useEffect(() => {
    getCanvasHost()?.setGridColor(gridColor)
  }, [gridColor])

  return (
    <div ref={stageRef} className="relative h-full w-full overflow-hidden bg-[#e8eaed]">
      {/* Fabric canvas 宿主（留出标尺厚度） */}
      <div
        ref={canvasHostRef}
        className="absolute"
        style={{ top: RULER_THICK, left: RULER_THICK, right: 0, bottom: 0 }}
      >
        <canvas ref={canvasElRef} style={{ touchAction: 'none' }} />
        {/* 方案 A 覆盖层：表格 / 图表 / 公式的真实视觉（Fabric 对象只承担命中与手柄）。
            必须与 canvas 同级同一层定位上下文 —— 放到外层 stage 会差一个标尺厚度。 */}
        {canvasReady && (
          <>
            <TableViewLayer />
            <ChartViewLayer />
            <MathViewLayer />
          </>
        )}
      </div>

      {/* 标尺覆盖层（只看不拦截事件） */}
      {stageWidth > 0 && <RulerOverlay stageWidth={stageWidth} stageHeight={stageHeight} />}

      {/* 右下角缩放工具栏（P6.1） */}
      <ZoomBar />

      {/* 触屏长按上下文菜单（P6.4） */}
      {longPress && <LongPressMenu state={longPress} onClose={() => setLongPress(null)} />}
    </div>
  )
}
