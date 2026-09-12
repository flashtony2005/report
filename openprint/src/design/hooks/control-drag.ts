/**
 * control-drag —— 控件库拖拽的框架无关部分
 *
 * 交互：控件库卡片 draggable → dragstart 写入控件类型（startControlDrag）→
 * 画布容器 dragover 允许放置 → drop 时由框架侧 hook（Vue useDragAdd / React useDragDrop）
 * 读取类型并落控件。同标签页内拖拽为同步过程，pendingInit 用模块级变量传递。
 *
 * 坐标换算纯函数 computeDropMm 供两端 drop 逻辑共用（防漂移）。
 */
import type { AnyControl, ControlType } from '@/types/control'
import { MM_TO_PX } from '@/utils/constants'

export const DRAG_TYPE_KEY = 'application/x-openprint-control'

/** 拖拽时携带的额外初始属性（如圆形 shape） */
let pendingInit: Partial<AnyControl> | undefined

/** 控件库侧：卡片 dragstart 调用；init 允许注入额外初始属性 */
export function startControlDrag(e: DragEvent, type: ControlType, init?: Partial<AnyControl>): void {
  e.dataTransfer?.setData(DRAG_TYPE_KEY, type)
  pendingInit = init
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

/** 画布侧：drop 时取回类型与初始属性 */
export function readControlDrag(e: DragEvent): { type: ControlType | ''; init: Partial<AnyControl> | undefined } {
  const type = (e.dataTransfer?.getData(DRAG_TYPE_KEY) as ControlType | '') ?? ''
  const init = pendingInit
  pendingInit = undefined
  return { type, init }
}

/** dragover 判断：是否为本应用的控件拖拽 */
export function isControlDragOver(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(DRAG_TYPE_KEY)
}

/** drop 换算的输入 */
export interface DropGeomInput {
  /** stage 容器 getBoundingClientRect() */
  rect: { left: number; top: number }
  /** 视口状态（缩放 + 平移 px） */
  vp: { zoom: number; offsetX: number; offsetY: number }
  /** 相对 stage 容器的 client 坐标（e.clientX - rect.left） */
  canvasX: number
  canvasY: number
}

/** drop 换算的输出（全部为 mm） */
export interface DropGeom {
  /** 相对页面左上角 mm */
  pageMmX: number
  pageMmY: number
  /** 相对内容区（正文原点）mm —— 既用于区域命中，也用于标签网格首卡命中 */
  dropLeft: number
  dropTop: number
}

/**
 * client px → 画布 mm 纯换算（与 Vue 版 onDrop 逐行等价）。
 * @param contentOriginPx 内容区左上角的页面内 px 偏移（d.contentOriginPx）
 */
export function computeDropMm(input: DropGeomInput, contentOriginPx: { x: number; y: number }): DropGeom {
  const { rect, vp, canvasX, canvasY } = input
  const pageMmX = (canvasX - vp.offsetX) / (MM_TO_PX * vp.zoom)
  const pageMmY = (canvasY - vp.offsetY) / (MM_TO_PX * vp.zoom)
  // 默认正文区原点 = 内容区左上角 + 页眉高（与渲染端 .op_body 起算点一致）
  const origin = { x: contentOriginPx.x / MM_TO_PX, y: contentOriginPx.y / MM_TO_PX }
  return {
    pageMmX,
    pageMmY,
    dropLeft: pageMmX - origin.x,
    dropTop: pageMmY - origin.y,
  }
}
