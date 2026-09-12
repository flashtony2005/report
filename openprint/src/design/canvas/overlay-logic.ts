/**
 * overlay-logic —— 画布 HTML/SVG 覆盖层（方案 A）的框架无关逻辑
 *
 * 设计期表格/图表/公式**不**由 Fabric 画位图，而是用真 DOM / SVG / KaTeX HTML
 * 绝对定位覆盖在画布上（Vue 的 TableViewLayer / ChartViewLayer / MathViewLayer）。
 * 三者的算法完全同构：
 *
 *   遍历 Fabric 画布对象 → 按类型筛出目标 → 几何取 Fabric（拖拽/缩放/旋转实时）
 *   内容取 store 模型 → 按视口变换算屏幕定位与渲染产物
 *
 * 只有这一处差异：Vue 用 `computed`、React 用 `useMemo` 订阅 zustand。
 * 几何与内容组装因此下沉成本模块的纯函数，两端共用，避免画布定位逐渐漂移。
 *
 * 注意：本模块**不**直接 import fabric —— 只用结构化接口描述所需的最小投影，
 * 这样纯函数可在无 DOM / 无 canvas 的测试环境里直接构造桩对象验证。
 */
import type { AnyControl } from '@/types/control'
import { MM_TO_PX } from '@/utils/constants'

/** 覆盖层上的一项：几何取自 Fabric 对象，内容取自 store 模型 */
export interface OverlayItem {
  id: string
  x: number
  y: number
  zoom: number
  angle: number
  widthMm: number
  heightMm: number
  /** 渲染产物（HTML 片段或 SVG 字符串） */
  html: string
}

/** Fabric 覆盖对象的只读投影 */
export interface FabricOverlayObject {
  controlId: string
  visible?: boolean
  left?: number
  top?: number
  angle?: number
  getScaledWidth(): number
  getScaledHeight(): number
  /** 从 Fabric 对象还原控件模型（store 里找不到对应控件时的兜底真相源） */
  toControl(): AnyControl
}

/** Fabric 画布的最小投影 */
export interface OverlayCanvas {
  /** [scaleX, skewY, skewX, scaleY, translateX, translateY] */
  viewportTransform: number[]
  getObjects(): unknown[]
}

/** 宿主 store 的最小投影（两个端各自的 store 都能满足） */
export interface OverlayStoreLike {
  controls: AnyControl[]
  zones: { children: AnyControl[] }[]
}

export interface CollectOverlayOptions<T extends FabricOverlayObject> {
  /** 画布（未挂载时为 null，返回空数组） */
  canvas: OverlayCanvas | null | undefined
  /** store 模型（内容真相源） */
  store: OverlayStoreLike
  /** 目标类型判定，如 `(o): o is PrintTable => o instanceof PrintTable` */
  isTarget: (obj: unknown) => obj is T
  /** 控件类型标识（'table' | 'chart' | 'math'），用于 store 模型回查 */
  type: string
  /** 渲染产物生成（HTML 或 SVG 字符串） */
  render: (control: AnyControl) => string
  /**
   * 可选的内容覆盖：返回字符串则优先使用（表格编辑期返回冻结 HTML，
   * 保证编辑时不因 store 变化重渲染而丢光标）；返回 undefined 走 render。
   */
  htmlOverride?: (id: string, control: AnyControl) => string | undefined
}

/**
 * 收集覆盖层各项。
 *
 * 关键约定（与 Vue 端原实现逐字一致）：
 * - `zoom` 取 `viewportTransform[0]`、偏移取 `[4]`/`[5]`
 * - 屏幕定位 = `节点 left/top × zoom + 视口偏移`
 * - 尺寸按 Fabric 缩放后的像素换算回 mm（`getScaledWidth() / MM_TO_PX`）
 * - 控件模型优先取 store（内容真相），取不到才回落到 `obj.toControl()`
 */
export function collectOverlayItems<T extends FabricOverlayObject>(
  o: CollectOverlayOptions<T>,
): OverlayItem[] {
  const canvas = o.canvas
  // 画布未挂载，或宿主是残缺桩（如测试里的 CanvasDesignerStub 只实现 requestRenderAll）
  // → 返回空覆盖层而不抛错：覆盖层永远不该把宿主组件带崩
  if (!canvas || typeof canvas.getObjects !== 'function') return []

  const vt = Array.isArray(canvas.viewportTransform) ? canvas.viewportTransform : []
  const zoom = vt[0] ?? 1
  const offsetX = vt[4] ?? 0
  const offsetY = vt[5] ?? 0

  const objects = canvas.getObjects()
  if (!Array.isArray(objects)) return []

  const out: OverlayItem[] = []
  for (const raw of objects) {
    if (!o.isTarget(raw)) continue
    const obj = raw
    if (obj.visible === false) continue

    const control = controlById(o, obj.controlId) ?? obj.toControl()
    out.push({
      id: obj.controlId,
      x: (obj.left ?? 0) * zoom + offsetX,
      y: (obj.top ?? 0) * zoom + offsetY,
      zoom,
      angle: obj.angle ?? 0,
      widthMm: obj.getScaledWidth() / MM_TO_PX,
      heightMm: obj.getScaledHeight() / MM_TO_PX,
      html: o.htmlOverride?.(obj.controlId, control) ?? o.render(control),
    })
  }
  return out
}

/** 按 id 回查 store 模型，且类型必须匹配（跨类型的同名 id 视为未找到） */
function controlById<T extends FabricOverlayObject>(
  o: CollectOverlayOptions<T>,
  id: string,
): AnyControl | undefined {
  const flat = [...o.store.controls, ...o.store.zones.flatMap((z) => z.children)]
  const hit = flat.find((c) => c.id === id)
  return hit && hit.type === o.type ? hit : undefined
}

/**
 * 覆盖项内联样式。
 * transform 顺序 = 先平移到节点屏幕坐标 → 再按节点角度旋转 → 最后套视口缩放，
 * 与 Fabric 自身的矩阵合成顺序完全一致（顺序错了会出现"缩放时偏心"）。
 */
export function overlayItemStyle(it: OverlayItem): Record<string, string> {
  return {
    transform: `translate(${it.x}px, ${it.y}px) rotate(${it.angle}deg) scale(${it.zoom})`,
    width: `${it.widthMm}mm`,
    height: `${it.heightMm}mm`,
  }
}
