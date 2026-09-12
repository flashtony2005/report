/**
 * ui store —— 缩放 / 主题 / 面板开关 / 语言（React 版 / Zustand）
 *
 * 从 Vue 版 `src/design/stores/ui.ts` 1:1 迁移。
 * 差异：Vue 版用 `watch(effectiveTheme, applyDomTheme, {immediate:true})` 自动同步 DOM，
 * React 版没有 watch，改为在**每个可能改变主题的 action 末尾**显式调用 `syncDom()`。
 * 行为等价，且更符合 React 的显式数据流。
 */
import { create } from 'zustand'

const STORAGE_KEY = 'openprint:ui:theme'

type ThemePreference = 'light' | 'dark' | 'system' | 'svip'
export type EffectiveTheme = 'light' | 'dark' | 'svip'

function readPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' || v === 'system' || v === 'svip' ? v : 'system'
  } catch {
    return 'system'
  }
}

function writePreference(v: ThemePreference): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, v)
  } catch {
    /* noop */
  }
}

function systemIsDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

interface UiState {
  /** 用户偏好（持久化） */
  themePreference: ThemePreference
  /** 系统暗色（只读实时值） */
  systemDark: boolean
  /** 左侧面板当前 Tab */
  leftTab: 'components' | 'layers' | 'datasource'
  rightPanelVisible: boolean
  previewOpen: boolean
  exportOpen: boolean
  /** 流水标签批量打印工作台（P5.8） */
  flowLabelOpen: boolean
  locale: 'zh-CN' | 'en-US'
  /** 画布上是否显示页边距内容区参考线（蓝色虚线） */
  showMarginGuides: boolean
  /** 进入 SVIP 前的主题（退出时恢复） */
  prevBeforeSvip: Exclude<ThemePreference, 'system' | 'svip'>
}

interface UiActions {
  setPreference: (v: ThemePreference) => void
  toggleTheme: () => void
  toggleSvip: () => void
  toggleMarginGuides: () => void
  setLeftTab: (t: UiState['leftTab']) => void
  setRightPanelVisible: (v: boolean) => void
  setPreviewOpen: (v: boolean) => void
  setExportOpen: (v: boolean) => void
  setFlowLabelOpen: (v: boolean) => void
  setLocale: (l: UiState['locale']) => void
  setSystemDark: (v: boolean) => void
  /** 把当前生效主题同步到 documentElement（Vue 版由 watch 自动做） */
  syncDom: () => void
  /** 监听系统主题变化，返回取消监听函数 */
  bindSystemListener: () => () => void
  $reset: () => void
}

export type UiStore = UiState & UiActions

/** 实际生效主题（system 下解析出的 light/dark；svip 直通不解析） */
export function resolveEffectiveTheme(s: Pick<UiState, 'themePreference' | 'systemDark'>): EffectiveTheme {
  if (s.themePreference === 'svip') return 'svip'
  return s.themePreference === 'system' ? (s.systemDark ? 'dark' : 'light') : s.themePreference
}

function applyDomTheme(mode: EffectiveTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const isDark = mode !== 'light'
  root.classList.toggle('dark', isDark)
  root.classList.toggle('svip', mode === 'svip')
  root.style.colorScheme = isDark ? 'dark' : 'light'
}

const initialState: UiState = {
  themePreference: readPreference(),
  systemDark: systemIsDark(),
  leftTab: 'components',
  rightPanelVisible: true,
  previewOpen: false,
  exportOpen: false,
  flowLabelOpen: false,
  locale: 'zh-CN',
  showMarginGuides: true,
  prevBeforeSvip: 'dark',
}

export const useUiStore = create<UiStore>((set, get) => ({
  ...initialState,

  setPreference: (v) => {
    set({ themePreference: v })
    writePreference(v)
    get().syncDom()
  },

  toggleTheme: () => {
    const { themePreference, systemDark, setPreference } = get()
    if (themePreference === 'system') {
      setPreference(systemDark ? 'light' : 'dark')
      return
    }
    // svip / dark → light；light → dark
    setPreference(themePreference === 'light' ? 'dark' : 'light')
  },

  toggleSvip: () => {
    const { themePreference, systemDark, setPreference } = get()
    if (themePreference === 'svip') {
      setPreference(get().prevBeforeSvip)
      return
    }
    set({
      prevBeforeSvip:
        themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference,
    })
    setPreference('svip')
  },

  toggleMarginGuides: () => set({ showMarginGuides: !get().showMarginGuides }),

  setLeftTab: (t) => set({ leftTab: t }),
  setRightPanelVisible: (v) => set({ rightPanelVisible: v }),
  setPreviewOpen: (v) => set({ previewOpen: v }),
  setExportOpen: (v) => set({ exportOpen: v }),
  setFlowLabelOpen: (v) => set({ flowLabelOpen: v }),
  setLocale: (l) => set({ locale: l }),
  setSystemDark: (v) => {
    set({ systemDark: v })
    get().syncDom()
  },

  syncDom: () => applyDomTheme(resolveEffectiveTheme(get())),

  bindSystemListener: () => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {}
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => get().setSystemDark(e.matches)
    set({ systemDark: mql.matches })
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  },

  $reset: () => set({ ...initialState }),
}))
