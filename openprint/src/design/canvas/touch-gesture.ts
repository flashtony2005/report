/**
 * 触控手势数学（框架无关，Vue/React 共享）
 *
 * P6.3 移动端二期：
 * - parsePinch：从 TouchList 提取捏合状态（两指间距 + 中点，画布元素坐标）
 * - pinchTransform：由前后两帧捏合状态计算视口变换（锚点缩放 + 中点平移）
 */
import type { TouchListLike } from './touch-gesture-types'

export interface PinchState {
  /** 两指间距（px） */
  dist: number
  /** 两指中点 X（画布元素坐标，px） */
  midX: number
  /** 两指中点 Y */
  midY: number
}

/** 从 TouchList 提取捏合状态；不足两指返回 null */
export function parsePinch(touches: TouchListLike): PinchState | null {
  if (!touches || touches.length < 2) return null
  const a = touches[0]!
  const b = touches[1]!
  return {
    dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    midX: (a.clientX + b.clientX) / 2,
    midY: (a.clientY + b.clientY) / 2,
  }
}

export interface PinchTransform {
  /** 新缩放值（未钳制，调用方钳制到 ZOOM_MIN/ZOOM_MAX） */
  zoom: number
  /** 平移增量 X（px，加到 viewportTransform[4]） */
  dx: number
  /** 平移增量 Y（加到 viewportTransform[5]） */
  dy: number
}

/**
 * 由前后两帧捏合状态计算变换：
 * - 缩放：按两指间距比例放大当前 zoom（锚定中点由调用方 zoomToPoint 处理）
 * - 平移：中点位移直接映射为视口平移
 */
export function pinchTransform(prev: PinchState, next: PinchState, curZoom: number): PinchTransform {
  const ratio = prev.dist > 0 ? next.dist / prev.dist : 1
  return {
    zoom: curZoom * ratio,
    dx: next.midX - prev.midX,
    dy: next.midY - prev.midY,
  }
}

/** 从 Pointer/Touch 事件对象安全取触点 client 坐标（兼容 Mouse 事件） */
export function pointerClientXY(e: unknown): { x: number; y: number } {
  const anyE = e as { touches?: TouchListLike; changedTouches?: TouchListLike; clientX?: number; clientY?: number }
  const t = anyE.touches?.[0] ?? anyE.changedTouches?.[0]
  if (t) return { x: t.clientX, y: t.clientY }
  return { x: anyE.clientX ?? 0, y: anyE.clientY ?? 0 }
}
