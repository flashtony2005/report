/**
 * 缩放工具函数（CanvasDesigner 的纯函数部分，供工具栏/快捷键复用）
 */
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '@/utils/constants'

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

export const nextZoomIn = (z: number): number => clampZoom(Math.round((z + ZOOM_STEP) * 100) / 100)
export const nextZoomOut = (z: number): number => clampZoom(Math.round((z - ZOOM_STEP) * 100) / 100)

/** 缩放百分比显示（100% / 125% ...） */
export const zoomLabel = (z: number): string => `${Math.round(z * 100)}%`

/** 常用缩放下拉档位 */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const
