/**
 * 打印客户端服务地址解析 —— 端口/地址覆盖的唯一出口
 *
 * 出厂默认：http://127.0.0.1:18888
 *
 * 覆盖优先级（高 → 低）：
 *   1. 用户在「设置 → 本地打印」里填的 IP/端口（localStorage `openprint:print-settings`）
 *   2. 出厂默认 http://127.0.0.1:18888
 *
 * 客户端已支持局域网打印：手填局域网地址（如 http://192.168.1.20:19000）即可直接推送，
 * 手填地址优先级最高。
 *
 * 主任铁律：无后端全链路可用 —— 这里只读本地存储与构建期常量，绝不请求任何后端。
 */
import { DEFAULT_PRINTER_BASE_URL } from '@/core/print-client'
import { PRINT_SETTINGS_KEY } from './print-settings'

/** 地址来源，UI 用于提示用户当前生效的是哪一层配置 */
export type PrinterBaseSource = 'settings' | 'default'

/** 出厂默认，供 UI 占位/重置使用 */
export const FACTORY_PRINTER_BASE_URL = DEFAULT_PRINTER_BASE_URL
export const FACTORY_PRINTER_HOST = '127.0.0.1'
export const FACTORY_PRINTER_PORT = 18888

/** 补全协议 + 去掉尾部斜杠 */
export function normalizePrinterBase(input: string): string {
  const raw = input.trim().replace(/\/+$/, '')
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
}

/** host + port → 基地址。host 可带协议（http://x）或只写 IP/域名 */
export function buildPrinterBase(host: string, port: number): string {
  const base = normalizePrinterBase(host)
  if (!base) return ''
  // host 里已经自带端口就不再拼（如用户填了 "127.0.0.1:18888"）
  if (/:\d+$/.test(base)) return base
  const p = Number.isFinite(port) && port > 0 ? Math.floor(port) : FACTORY_PRINTER_PORT
  return `${base}:${p}`
}

/**
 * 读取用户在设置里显式配置的端点。
 * 只有 localStorage 里确实存在 local.silent.host/port 才算「用户配置过」，
 * 否则返回 null 让位给环境变量。
 */
export function readStoredPrinterEndpoint(): { host: string; port: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PRINT_SETTINGS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      local?: { silent?: { host?: unknown; port?: unknown } }
    }
    const silent = parsed?.local?.silent
    if (!silent) return null
    const host = typeof silent.host === 'string' ? silent.host.trim() : ''
    const port = typeof silent.port === 'number' ? silent.port : Number(silent.port)
    if (!host || !Number.isFinite(port) || port <= 0) return null
    return { host, port: Math.floor(port) }
  } catch {
    return null
  }
}

/** 当前生效的打印客户端基地址 */
export function resolvePrinterBaseUrl(): string {
  const stored = readStoredPrinterEndpoint()
  if (stored) {
    const base = buildPrinterBase(stored.host, stored.port)
    if (base) return base
  }
  return FACTORY_PRINTER_BASE_URL
}

/** 当前地址来自哪一层配置（UI 提示用） */
export function resolvePrinterBaseSource(): PrinterBaseSource {
  if (readStoredPrinterEndpoint()) return 'settings'
  return 'default'
}
