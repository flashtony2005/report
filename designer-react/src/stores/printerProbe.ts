/**
 * 打印客户端探测状态 —— 模块级单例（React 版 / Zustand）
 *
 * 从 Vue 版 `src/design/composables/usePrinterProbe.ts` 迁移。
 * 保留单例语义：顶栏状态灯与打印弹窗共用一份，一次探测两处同时更新，
 * 并发调用合并为同一个 inflight Promise。
 */
import { create } from 'zustand'
import {
  checkHealth,
  describePrintError,
  listPrinters,
  type PrinterHealth,
  type PrinterInfo,
} from '@/core/print-client'
import { resolvePrinterBaseUrl } from '@/config/printer'
import { loadSystemFontsIfStale, clearSystemFonts } from '@/core/fonts/system'

/** idle=从未探测 / checking=探测中 / connected=已连接 / disconnected=不可达 */
export type PrinterProbeState = 'idle' | 'checking' | 'connected' | 'disconnected'

interface ProbeState {
  state: PrinterProbeState
  health: PrinterHealth | null
  printers: PrinterInfo[]
  errorText: string
  baseUrl: string
  checkedAt: number
}

interface ProbeActions {
  probe: () => Promise<boolean>
  probeIfStale: (ttlMs?: number) => Promise<boolean>
  /** 供 dataSource 等外部模块响应连接状态变化（替代 Vue 版的 watch） */
  handleStateChange: (s: PrinterProbeState) => void
  $reset: () => void
}

export type PrinterProbeStore = ProbeState & ProbeActions

/** 并发调用合并为同一个 inflight Promise（模块级，与 Vue 版一致） */
let inflight: Promise<boolean> | null = null

const initial: ProbeState = {
  state: 'idle',
  health: null,
  printers: [],
  errorText: '',
  baseUrl: resolvePrinterBaseUrl(),
  checkedAt: 0,
}

export const usePrinterProbeStore = create<PrinterProbeStore>((set, get) => ({
  ...initial,

  probe: () => {
    if (inflight) return inflight
    set({ state: 'checking', errorText: '' })
    const base = resolvePrinterBaseUrl()
    set({ baseUrl: base })

    inflight = (async () => {
      try {
        const health = await checkHealth(base)
        const printers = await listPrinters(base)
        set({ health, printers, state: 'connected' })
        // 客户端连接成功 → 顺手加载系统字体（失败不阻塞连接状态）。
        // 用 loadIfStale（60s TTL）而非 load：全量拉字体会占满客户端连接，
        // 导致紧随其后的 /health /printers 探测超时。
        void loadSystemFontsIfStale().catch(() => {})
        return true
      } catch (e) {
        set({
          health: null,
          printers: [],
          errorText: describePrintError(e),
          state: 'disconnected',
        })
        clearSystemFonts()
        return false
      } finally {
        set({ checkedAt: Date.now() })
        inflight = null
      }
    })()

    return inflight
  },

  probeIfStale: (ttlMs = 15000) => {
    const { state, checkedAt } = get()
    if (state === 'connected' && Date.now() - checkedAt < ttlMs) return Promise.resolve(true)
    if (state === 'checking' && inflight) return inflight
    return get().probe()
  },

  handleStateChange: () => {
    // 由 App 层调用 usePrinterProbeStore.subscribe 后按需接入
  },

  $reset: () => set({ ...initial }),
}))

/* ------------------------------ 派生值（原 computed） ------------------------------ */

/** 在线且可用的打印机（离线的仍在列表里，只是不可选） */
export const selectOnlinePrinters = (s: PrinterProbeStore): PrinterInfo[] =>
  s.printers.filter((p) => p.isOnline)

/** 默认打印机（服务端标记 isDefault，否则取第一台在线的） */
export const selectDefaultPrinter = (s: PrinterProbeStore): PrinterInfo | null => {
  const online = selectOnlinePrinters(s)
  return s.printers.find((p) => p.isDefault) ?? online[0] ?? s.printers[0] ?? null
}

/** 一句话状态描述（顶栏 tooltip / 弹窗提示复用） */
export const selectSummary = (s: PrinterProbeStore): string => {
  switch (s.state) {
    case 'idle':
      return '打印客户端：未检测'
    case 'checking':
      return '正在检测打印客户端…'
    case 'connected': {
      const h = s.health
      const v = h?.version ? ` v${h.version}` : ''
      return `打印客户端已连接（${h?.app ?? 'OpenPrint'}${v} · ${s.printers.length} 台打印机）`
    }
    case 'disconnected':
      return `打印客户端不可达：${s.errorText || '未知原因'}`
  }
}
