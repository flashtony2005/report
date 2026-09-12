/**
 * hotkey-logic —— 全局快捷键的框架无关部分
 *
 * 键位表（与「快捷键指南」弹窗 `toolbar/shared/toolbar-logic.ts` 的宣传**必须一致**，
 * 改键位时两边一起改）：
 *
 * | 按键 | 行为 |
 * |---|---|
 * | mod + Z | 撤销 |
 * | mod + Shift + Z 或 mod + Y | 重做 |
 * | Delete / Backspace | 删除选中控件 |
 * | mod + D | 复制选中控件（右下偏移 10mm） |
 * | Escape | 取消选中 |
 *
 * mod = macOS 的 ⌘ / 其他平台的 Ctrl（判定复用 `toolbar/shared/isMacPlatform`，
 * 与指南弹窗的 MOD 显示同源）。
 *
 * 与 control-drag.ts / field-drag.ts 同构：纯逻辑 + 端侧 adapter。
 * 端侧只在事件监听生命周期上不同——Vue 见 `design/hooks/useHotkey.ts`，
 * React 见 `designer-react/src/hooks/useHotkey.ts`。
 */
import { isMacPlatform } from '@/design/toolbar/shared/toolbar-logic'

/** 一条可识别的快捷键 */
export type HotkeyCommand = 'undo' | 'redo' | 'delete' | 'duplicate' | 'deselect'

/**
 * 端侧能力：把 store 的几个动作压成最小接口，
 * 让本模块不必知道两端 store 的名字与形状。
 */
export interface HotkeyAdapter {
  /** 当前选中控件 id 列表（无选中返回空数组） */
  selectedIds(): string[]
  undo(): void
  redo(): void
  /** 删除单个控件（撤销/重做与画布同步由端侧 store 负责） */
  remove(id: string): void
  /** 复制单个控件（端侧负责换新 id、偏移、以及是否跳过 zone / 标签网格子件） */
  duplicate(id: string): void
  /** 取消选中 */
  deselect(): void
}

/** 焦点在可输入元素内时不劫持按键（否则删不掉字、Ctrl+Z 撤不掉输入） */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  // SELECT 也放行：下拉里 Backspace 不应删控件
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** 事件里取平台判定所需的最小字段（便于单测构造） */
export interface HotkeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey?: boolean
}

/**
 * 键位解析：返回命中的命令，未命中返回 null。
 *
 * 注意 `e.key` 在按住 Shift 时是大写（`'Z'` 而非 `'z'`），故统一 toLowerCase 后再比，
 * 否则「mod + Shift + Z 重做」这一支永远匹配不到。
 * 带 alt 的组合一律不劫持（可能被系统 / 输入法占用）。
 */
export function resolveHotkey(e: HotkeyEventLike, opts?: { mac?: boolean }): HotkeyCommand | null {
  if (e.altKey) return null
  const mac = opts?.mac ?? isMacPlatform()
  const mod = mac ? e.metaKey : e.ctrlKey
  const key = e.key.toLowerCase()

  if (mod) {
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (key === 'y' && !e.shiftKey) return 'redo'
    if (key === 'd' && !e.shiftKey) return 'duplicate'
    return null
  }
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete'
  if (e.key === 'Escape') return 'deselect'
  return null
}

/**
 * 执行一次按键：命中则调 adapter 并（必要时）阻止默认行为，返回是否已处理。
 *
 * - 输入框 / 可编辑区内一律返回 false，交由原生处理
 * - 删除 / 复制在**无选中**时返回 false（不 preventDefault，避免吞掉浏览器默认行为）
 * - Escape 不 preventDefault（可能与弹窗自身的关闭逻辑冲突），与既有行为一致
 */
export function runHotkey(
  e: KeyboardEvent,
  adapter: HotkeyAdapter,
  opts?: { mac?: boolean },
): boolean {
  if (isEditableTarget(e.target)) return false
  const cmd = resolveHotkey(e, opts)
  if (!cmd) return false

  if (cmd === 'delete' || cmd === 'duplicate') {
    const ids = adapter.selectedIds()
    if (ids.length === 0) return false
    e.preventDefault()
    // 先快照：remove / duplicate 会改写 selectedIds，直接遍历原数组引用虽安全但语义不清
    for (const id of [...ids]) {
      if (cmd === 'delete') adapter.remove(id)
      else adapter.duplicate(id)
    }
    return true
  }

  if (cmd === 'undo') {
    e.preventDefault()
    adapter.undo()
    return true
  }
  if (cmd === 'redo') {
    e.preventDefault()
    adapter.redo()
    return true
  }
  adapter.deselect()
  return true
}
