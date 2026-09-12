/**
 * 设计器常量 —— 《标尺与辅助系统》§13
 * 注意：core/units.ts 的 PX_PER_MM 与此 MM_TO_PX 同值，两处同源不可改一个不改另一个。
 */

/** 1mm = 3.7795275591 px (96 DPI)；纯显示换算，不含 DPR（DPR 由 Fabric/浏览器处理） */
export const MM_TO_PX = 3.7795275591

/** 标尺配色（浅色主题；深色主题由 ui store 切换） */
export const RULER_PALETTE_LIGHT = {
  bgColor: '#ffffff',
  tickColor: '#c0c4cc',
  labelColor: '#909399',
  guideColor: '#00A8FF', // PS 蓝
  guideLockedColor: '#999',
  guideDashArray: '4,3',
  smartGuideColor: '#FF3366', // Figma 红粉
  gridColor: 'rgba(128,128,128,0.15)',
  shadowColor: 'rgba(0,168,255,0.1)',
  /** 选中/拖拽元素在标尺上的高亮带（琥珀，与蓝色辅助线对比突出） */
  bandColor: 'rgba(245, 158, 11, 0.30)',
  bandBorder: 'rgba(217, 119, 6, 0.85)',
  bandText: '#7c2d12',
} as const

export const RULER_PALETTE_DARK = {
  bgColor: '#1e1e1e',
  tickColor: '#555',
  labelColor: '#999',
  guideColor: '#00A8FF',
  guideLockedColor: '#666',
  guideDashArray: '4,3',
  smartGuideColor: '#FF3366',
  gridColor: 'rgba(128,128,128,0.15)',
  shadowColor: 'rgba(0,168,255,0.1)',
  /** 选中/拖拽元素在标尺上的高亮带 */
  bandColor: 'rgba(245, 158, 11, 0.38)',
  bandBorder: 'rgba(251, 191, 36, 0.9)',
  bandText: '#fff7ed',
} as const

/** 默认吸附阈值（mm） */
export const DEFAULT_SNAP_THRESHOLD = 0.5

/** 标尺厚度（px） */
export const RULER_THICK = 20

/** 缩放范围与步进 */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4
export const ZOOM_STEP = 0.25
