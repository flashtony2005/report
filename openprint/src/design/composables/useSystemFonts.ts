/**
 * useSystemFonts —— Vue composable 包装（系统字体注册中心的响应式视图）
 *
 * 核心状态在 `@/core/fonts/system`（框架无关：模块单例 + onSystemFontsChange 订阅）。
 * 这里只做 ref/computed 适配，Vue 组件统一从本文件导入 useSystemFonts。
 */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import {
  getSystemFontsSnapshot,
  loadSystemFonts,
  loadSystemFontsIfStale,
  clearSystemFonts,
  onSystemFontsChange,
  systemFontFaceCss,
  systemFontDefs,
  snapshotSystemFonts,
  findSystemFontFamily,
  type SystemFontState,
} from '@/core/fonts/system'
import type { SystemFontEntry } from '@/core/print-client'
import type { FontFamilyDef } from '@/core/fonts/catalog'

export interface UseSystemFonts {
  state: Ref<SystemFontState>
  fonts: Ref<SystemFontEntry[]>
  grouped: ComputedRef<{ family: string; entries: SystemFontEntry[] }[]>
  count: ComputedRef<number>
  ready: ComputedRef<boolean>
  errorText: Ref<string>
  baseUrl: Ref<string>
  checkedAt: Ref<number>
  load: () => Promise<boolean>
  loadIfStale: (ttlMs?: number) => Promise<boolean>
  clear: () => void
  systemFontFaceCss: (usedFamilies?: string[]) => string
  systemFontDefs: (usedFamilies: string[]) => FontFamilyDef[]
  snapshot: () => SystemFontEntry[]
  findSystemFontFamily: (family: string | undefined) => FontFamilyDef | undefined
}

export function useSystemFonts(): UseSystemFonts {
  const snap = ref(getSystemFontsSnapshot())

  // 订阅核心状态变化（作用域销毁自动取消）
  const stop = onSystemFontsChange(() => {
    snap.value = getSystemFontsSnapshot()
  })
  onScopeDispose(stop)

  const grouped = computed(() => snap.value.grouped)
  const count = computed(() => snap.value.count)
  const ready = computed(() => snap.value.ready)

  return {
    state: computed(() => snap.value.state) as Ref<SystemFontState>,
    fonts: computed(() => snap.value.fonts) as Ref<SystemFontEntry[]>,
    grouped,
    count,
    ready,
    errorText: computed(() => snap.value.errorText) as Ref<string>,
    baseUrl: computed(() => snap.value.baseUrl) as Ref<string>,
    checkedAt: computed(() => snap.value.checkedAt) as Ref<number>,
    load: loadSystemFonts,
    loadIfStale: loadSystemFontsIfStale,
    clear: clearSystemFonts,
    systemFontFaceCss,
    systemFontDefs,
    snapshot: snapshotSystemFonts,
    findSystemFontFamily,
  }
}
