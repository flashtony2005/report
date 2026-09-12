/**
 * toolbar-logic 共享逻辑测试（P5.2 从 TopToolbar.vue 抽出）
 * Vue/React 两端同源消费：React 端经 alias 引同一文件，契约由各自 spec 把关。
 */
import { describe, expect, it } from 'vitest'
import {
  buildShortcutGroups,
  FILE_MENU_ITEMS,
  modOf,
  printerDotClass,
  printerTooltip,
} from './toolbar-logic'

describe('FILE_MENU_ITEMS', () => {
  it('包含全部 8 个功能项（不含分隔线）', () => {
    const keys = FILE_MENU_ITEMS.filter((i) => !i.divider).map((i) => i.key)
    expect(keys).toEqual([
      'new',
      'open',
      'demo',
      'importTpl',
      'exportTpl',
      'importData',
      'save',
      'saveAs',
    ])
  })

  it('功能项都有 label，分隔线都没有 label', () => {
    for (const item of FILE_MENU_ITEMS) {
      if (item.divider) expect(item.label).toBeUndefined()
      else expect(item.label).toBeTruthy()
    }
  })

  it('保存 / 另存为 位于菜单末尾', () => {
    const last = FILE_MENU_ITEMS[FILE_MENU_ITEMS.length - 1]!
    expect(last.key).toBe('saveAs')
  })
})

describe('modOf / buildShortcutGroups', () => {
  it('mac 平台 MOD 为 ⌘，win 为 Ctrl', () => {
    expect(modOf('mac')).toBe('⌘')
    expect(modOf('win')).toBe('Ctrl')
  })

  it('三组：通用操作 / 画布视图 / 表格单元格编辑', () => {
    const groups = buildShortcutGroups('Ctrl')
    expect(groups.map((g) => g.title)).toEqual([
      '通用操作',
      '画布视图',
      '表格单元格编辑（双击表格进入）',
    ])
  })

  it('撤销 / 重做条目使用当前平台 MOD', () => {
    const mac = buildShortcutGroups('⌘')
    expect(mac[0]!.items[0]).toEqual({ keys: ['⌘', 'Z'], desc: '撤销' })
    expect(mac[0]!.items[1]!.keys).toEqual(['⌘', 'Shift', 'Z'])
    const win = buildShortcutGroups('Ctrl')
    expect(win[0]!.items[0]!.keys).toEqual(['Ctrl', 'Z'])
  })

  it('重做带「或 MOD + Y」提示', () => {
    const groups = buildShortcutGroups('Ctrl')
    expect(groups[0]!.items[1]!.hint).toBe('或 Ctrl + Y')
  })
})

describe('printerDotClass / printerTooltip', () => {
  it('状态灯类名 = is-<state>', () => {
    expect(printerDotClass('connected')).toBe('is-connected')
    expect(printerDotClass('disconnected')).toBe('is-disconnected')
    expect(printerDotClass('checking')).toBe('is-checking')
    expect(printerDotClass('idle')).toBe('is-idle')
  })

  it('connected 提示含应用名 / 版本 / 打印机数', () => {
    const tip = printerTooltip('connected', {
      app: 'OpenPrint Client',
      version: '1.2.0',
      printerCount: 3,
      errorText: '',
      baseUrl: 'http://127.0.0.1:17777',
    })
    expect(tip).toBe(
      '打印 · 客户端已连接（OpenPrint Client v1.2.0 · 3 台打印机）',
    )
  })

  it('connected 且缺应用信息回落 OpenPrint / ?', () => {
    const tip = printerTooltip('connected', {
      printerCount: 0,
      errorText: '',
      baseUrl: '',
    })
    expect(tip).toContain('OpenPrint v?')
    expect(tip).toContain('0 台打印机')
  })

  it('checking 提示为检测中文案', () => {
    expect(
      printerTooltip('checking', { printerCount: 0, errorText: '', baseUrl: 'x' }),
    ).toBe('打印 · 正在检测打印客户端…')
  })

  it('disconnected 提示含失败原因与 baseUrl', () => {
    const tip = printerTooltip('disconnected', {
      printerCount: 0,
      errorText: '连接超时',
      baseUrl: 'http://127.0.0.1:17777',
    })
    expect(tip).toBe('打印 · 客户端不可达：连接超时（http://127.0.0.1:17777）')
  })

  it('idle 提示引导点击自测', () => {
    const tip = printerTooltip('idle', { printerCount: 0, errorText: '', baseUrl: 'http://x' })
    expect(tip).toBe('打印 · 点击自测客户端连接（http://x）')
  })
})
