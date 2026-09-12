/**
 * 打印客户端探测状态 —— 模块级单例，顶栏状态灯与打印弹窗共用一份
 *
 * 为什么做成单例：
 * - 顶栏打印按钮要常驻显示连接状态；打印弹窗打开时也要拿打印机列表。
 *   两处各自请求会重复打扰本机服务，也会出现状态不同步（顶栏红点 / 弹窗已连接）。
 * - 这里用模块级 ref 共享，一次探测两处同时更新；并发调用合并为同一个 inflight Promise。
 */
import { computed, ref } from 'vue'
import {
  checkHealth,
  describePrintError,
  listPrinters,
  type PrinterHealth,
  type PrinterInfo,
} from '@/core/print-client'
import { resolvePrinterBaseUrl } from '@/config/printer'
import { useSystemFonts } from '@/design/composables/useSystemFonts'

/** idle=从未探测 / checking=探测中 / connected=已连接 / disconnected=不可达 */
export type PrinterProbeState = 'idle' | 'checking' | 'connected' | 'disconnected'

const state = ref<PrinterProbeState>('idle')
const health = ref<PrinterHealth | null>(null)
const printers = ref<PrinterInfo[]>([])
const errorText = ref('')
const baseUrl = ref(resolvePrinterBaseUrl())
const checkedAt = ref(0)

let inflight: Promise<boolean> | null = null

/** 在线且可用的打印机（离线的仍在列表里，只是不可选） */
const onlinePrinters = computed(() => printers.value.filter((p) => p.isOnline))

/** 默认打印机（服务端标记 isDefault，否则取第一台在线的） */
const defaultPrinter = computed<PrinterInfo | null>(
  () => printers.value.find((p) => p.isDefault) ?? onlinePrinters.value[0] ?? printers.value[0] ?? null,
)

/** 一句话状态描述（顶栏 tooltip / 弹窗提示复用） */
const summary = computed(() => {
  switch (state.value) {
    case 'idle':
      return '打印客户端：未检测'
    case 'checking':
      return '正在检测打印客户端…'
    case 'connected': {
      const h = health.value
      const v = h?.version ? ` v${h.version}` : ''
      return `打印客户端已连接（${h?.app ?? 'OpenPrint'}${v} · ${printers.value.length} 台打印机）`
    }
    case 'disconnected':
      return `打印客户端不可达：${errorText.value || '未知原因'}`
  }
})

/**
 * 执行一次探测：/health 判活 → /printers 取列表。
 * 并发调用共享同一次请求；返回是否连接成功。
 */
async function probe(): Promise<boolean> {
  if (inflight) return inflight
  state.value = 'checking'
  errorText.value = ''
  const base = resolvePrinterBaseUrl()
  baseUrl.value = base

  inflight = (async () => {
    try {
      health.value = await checkHealth(base)
      printers.value = await listPrinters(base)
      state.value = 'connected'
      // 客户端连接成功 → 顺手加载电脑系统字体清单（失败不阻塞连接状态）。
      // 用 loadIfStale（60s TTL）而非 load：load 会向客户端拉全量字体清单 + 逐个 FontFace 拉字体文件，
      // 每次 probe 都全量拉会占满客户端连接，导致紧随其后的 /health /printers 探测超时（流水标签面板"打开即断开"）。
      void useSystemFonts().loadIfStale().catch(() => {})
      return true
    } catch (e) {
      health.value = null
      printers.value = []
      errorText.value = describePrintError(e)
      state.value = 'disconnected'
      // 客户端断开 → 清空系统字体（避免下拉里残留客户端不可达的字体）
      useSystemFonts().clear()
      return false
    } finally {
      checkedAt.value = Date.now()
      inflight = null
    }
  })()

  return inflight
}

/** 距上次探测超过 ttl（默认 15s）才重新探测，避免频繁打扰本机服务 */
async function probeIfStale(ttlMs = 15000): Promise<boolean> {
  if (state.value === 'connected' && Date.now() - checkedAt.value < ttlMs) return true
  if (state.value === 'checking' && inflight) return inflight
  return probe()
}

export function usePrinterProbe() {
  return {
    state,
    health,
    printers,
    onlinePrinters,
    defaultPrinter,
    errorText,
    baseUrl,
    checkedAt,
    summary,
    probe,
    probeIfStale,
  }
}
