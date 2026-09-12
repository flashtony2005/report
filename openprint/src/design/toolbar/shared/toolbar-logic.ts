/**
 * toolbar-logic —— TopToolbar 的框架无关逻辑（Vue/React 共享，防两端漂移）
 *
 * 从 TopToolbar.vue 抽出（P5.2）：文件菜单项 / 快捷键指南数据 / 打印状态灯映射。
 * 这里只放纯数据与纯函数，不 import 任何框架 API。
 */

/* ------------------------------ 文件菜单 ------------------------------ */

export interface FileMenuItem {
  key: string
  label?: string
  /** 分隔线（label 省略） */
  divider?: boolean
}

/** 文件下拉菜单项（顺序即展示顺序） */
export const FILE_MENU_ITEMS: FileMenuItem[] = [
  { key: 'new', label: '新建空白模板' },
  { key: 'open', label: '打开模板...' },
  { key: 'd1', divider: true },
  { key: 'demo', label: '载入示例模板' },
  { key: 'd2', divider: true },
  { key: 'importTpl', label: '导入模板...' },
  { key: 'exportTpl', label: '导出模板...' },
  { key: 'd3', divider: true },
  { key: 'importData', label: '导入数据...' },
  { key: 'd4', divider: true },
  { key: 'save', label: '保存' },
  { key: 'saveAs', label: '另存为...' },
]

/* ------------------------------ 快捷键指南 ------------------------------ */

/** 快捷键指南的平台（MOD 键随平台变化） */
export type ShortcutPlatform = 'mac' | 'win'

/** 按当前系统判断默认平台（SSR 安全） */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

export function modOf(platform: ShortcutPlatform): '⌘' | 'Ctrl' {
  return platform === 'mac' ? '⌘' : 'Ctrl'
}

export interface ShortcutItem {
  keys: string[]
  desc: string
  hint?: string
}

export interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

/** 快捷键数据随所选平台重算（MOD 取自当前平台） */
export function buildShortcutGroups(mod: '⌘' | 'Ctrl'): ShortcutGroup[] {
  return [
    {
      title: '通用操作',
      items: [
        { keys: [mod, 'Z'], desc: '撤销' },
        { keys: [mod, 'Shift', 'Z'], desc: '重做', hint: `或 ${mod} + Y` },
        { keys: ['Delete'], desc: '删除选中控件', hint: '或 Backspace' },
        { keys: [mod, 'D'], desc: '复制选中控件（向右下偏移 10mm）' },
        { keys: ['Esc'], desc: '取消选中' },
      ],
    },
    {
      title: '画布视图',
      items: [
        { keys: ['Space', '拖拽'], desc: '按住空格拖拽平移画布' },
        { keys: [mod, '滚轮'], desc: '缩放画布' },
        { keys: ['滚轮'], desc: '垂直平移；Shift + 滚轮水平平移' },
      ],
    },
    {
      title: '表格单元格编辑（双击表格进入）',
      items: [
        { keys: ['Enter'], desc: '提交并下移一行' },
        { keys: ['Tab'], desc: '跳到下一单元格', hint: 'Shift + Tab 上一格' },
        { keys: ['Esc'], desc: '提交并退出编辑' },
      ],
    },
  ]
}

/* ------------------------------ 打印状态灯 ------------------------------ */

/** idle=从未探测 / checking=探测中 / connected=已连接 / disconnected=不可达 */
export type PrinterDotState = 'idle' | 'checking' | 'connected' | 'disconnected'

/** 状态灯 CSS 类：绿=已连接 / 红=不可达 / 黄=检测中 / 灰=未检测 */
export function printerDotClass(state: PrinterDotState): string {
  return `is-${state}`
}

export interface PrinterTooltipInfo {
  app?: string
  version?: string
  printerCount: number
  errorText: string
  baseUrl: string
}

/** 悬停提示：版本 + 打印机数量 / 失败原因 */
export function printerTooltip(state: PrinterDotState, info: PrinterTooltipInfo): string {
  switch (state) {
    case 'connected':
      return `打印 · 客户端已连接（${info.app ?? 'OpenPrint'} v${info.version ?? '?'} · ${info.printerCount} 台打印机）`
    case 'checking':
      return '打印 · 正在检测打印客户端…'
    case 'disconnected':
      return `打印 · 客户端不可达：${info.errorText}（${info.baseUrl}）`
    default:
      return `打印 · 点击自测客户端连接（${info.baseUrl}）`
  }
}
