/**
 * 打印设置 —— 本地打印 / 远程云打印 配置（全局设置，localStorage 持久化）
 * 主任铁律：无后端全链路可用 —— 设置只存本地，绝不依赖后端。
 */

export interface LocalPrintConfig {
  /** 打印方式：browser=浏览器打印对话框 / silent=客户端静默打印（需本地客户端服务） */
  method: 'browser' | 'silent'
  /**
   * 本地打印客户端连接地址。
   * 同时也是 /health、/printers、/print 三个接口的基地址来源，
   * 解析优先级见 `@/config/printer` 的 resolvePrinterBaseUrl()。
   */
  silent: {
    /** 客户端所在主机 IP（默认本机回环 127.0.0.1） */
    host: string
    /** 客户端服务端口（默认 18888） */
    port: number
  }
  /** 副本数 */
  copies: number
  /** 打印完成后自动关闭预览窗口 */
  closeAfterPrint: boolean
}

export interface RemotePrintConfig {
  /** 是否启用远程云打印 */
  enabled: boolean
  /** 云打印服务地址（如 http://localhost 或 https://print.example.com） */
  host: string
  /** 服务端口 */
  port: number
  /** 目标打印机名（可选，留空使用服务默认打印机） */
  printer: string
}

export interface PrintSettings {
  local: LocalPrintConfig
  remote: RemotePrintConfig
}

export const PRINT_SETTINGS_KEY = 'openprint:print-settings'

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  local: {
    method: 'browser',
    silent: { host: '127.0.0.1', port: 18888 },
    copies: 1,
    closeAfterPrint: true,
  },
  remote: { enabled: false, host: 'http://localhost', port: 9100, printer: '' },
}

/** 读取设置（损坏/缺失时回退默认值，深度合并保证新字段有默认） */
export function readPrintSettings(): PrintSettings {
  if (typeof window === 'undefined') return DEFAULT_PRINT_SETTINGS
  try {
    const raw = window.localStorage.getItem(PRINT_SETTINGS_KEY)
    if (!raw) return DEFAULT_PRINT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<PrintSettings>
    return {
      local: {
        ...DEFAULT_PRINT_SETTINGS.local,
        ...(parsed.local ?? {}),
        silent: {
          ...DEFAULT_PRINT_SETTINGS.local.silent,
          ...(parsed.local?.silent ?? {}),
        },
      },
      remote: {
        ...DEFAULT_PRINT_SETTINGS.remote,
        ...(parsed.remote ?? {}),
      },
    }
  } catch {
    return DEFAULT_PRINT_SETTINGS
  }
}

export function writePrintSettings(settings: PrintSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PRINT_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* 存储不可用时静默失败（如隐私模式） */
  }
}
