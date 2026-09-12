/**
 * useSystemFonts —— React hook（系统字体注册中心的响应式视图）
 *
 * 核心状态在 Vue 项目 `core/fonts/system.ts`（框架无关：模块单例 + onSystemFontsChange 订阅），
 * 通过 vite alias 零复制复用。快照对象引用稳定，直到状态变化才重建——正是
 * useSyncExternalStore 需要的语义。
 */
import { useSyncExternalStore } from 'react'
import {
  getSystemFontsSnapshot,
  loadSystemFonts,
  loadSystemFontsIfStale,
  clearSystemFonts,
  systemFontFaceCss,
  systemFontDefs,
  snapshotSystemFonts,
  findSystemFontFamily,
  onSystemFontsChange,
} from '@/core/fonts/system'

export type SystemFontsSnapshot = ReturnType<typeof getSystemFontsSnapshot>

export function useSystemFonts(): SystemFontsSnapshot {
  return useSyncExternalStore(onSystemFontsChange, getSystemFontsSnapshot, getSystemFontsSnapshot)
}

export {
  loadSystemFonts,
  loadSystemFontsIfStale,
  clearSystemFonts,
  systemFontFaceCss,
  systemFontDefs,
  snapshotSystemFonts,
  findSystemFontFamily,
}
