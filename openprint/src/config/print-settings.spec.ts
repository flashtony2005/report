import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PRINT_SETTINGS,
  readPrintSettings,
  writePrintSettings,
  PRINT_SETTINGS_KEY,
} from '@/config/print-settings'

describe('print-settings —— 打印设置读写', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('无存储时返回默认值', () => {
    expect(readPrintSettings()).toEqual(DEFAULT_PRINT_SETTINGS)
  })

  it('写入后可读回', () => {
    const s = {
      local: {
        method: 'silent' as const,
        silent: { host: '192.168.1.10', port: 9122 },
        copies: 3,
        closeAfterPrint: false,
      },
      remote: { enabled: true, host: 'http://10.0.0.8', port: 9200, printer: 'HP-1' },
    }
    writePrintSettings(s)
    expect(readPrintSettings()).toEqual(s)
  })

  it('损坏 JSON 回退默认值', () => {
    window.localStorage.setItem(PRINT_SETTINGS_KEY, '{oops')
    expect(readPrintSettings()).toEqual(DEFAULT_PRINT_SETTINGS)
  })

  it('部分配置深度合并（新增字段有默认值）', () => {
    window.localStorage.setItem(
      PRINT_SETTINGS_KEY,
      JSON.stringify({ local: { method: 'silent' } }),
    )
    const s = readPrintSettings()
    expect(s.local.method).toBe('silent')
    expect(s.local.copies).toBe(DEFAULT_PRINT_SETTINGS.local.copies)
    expect(s.local.silent).toEqual({ host: '127.0.0.1', port: 18888 })
    expect(s.remote.enabled).toBe(false)
  })
})
