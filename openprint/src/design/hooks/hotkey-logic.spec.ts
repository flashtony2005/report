/**
 * hotkey-logic —— 全局快捷键纯逻辑单测
 *
 * 覆盖键位解析（含 macOS/Windows 两套 MOD）、输入框守卫、空选中守卫，
 * 以及「是否 preventDefault」这类容易被顺手改坏的行为。
 * 两端 hook（Vue useHotkey / React useHotkey）都只是把 store 包成 adapter，
 * 真正的分派逻辑在这里，故此处测全即可。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  isEditableTarget,
  resolveHotkey,
  runHotkey,
  type HotkeyAdapter,
  type HotkeyEventLike,
} from './hotkey-logic'

/** 构造 resolveHotkey 需要的最小事件对象 */
function ev(key: string, mods: Partial<Omit<HotkeyEventLike, 'key'>> = {}): HotkeyEventLike {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, ...mods }
}

/** 构造 runHotkey 需要的 KeyboardEvent（happy-dom 下自带 target / preventDefault） */
function keyEvent(
  key: string,
  mods: Partial<Omit<HotkeyEventLike, 'key'>> = {},
  target: EventTarget | null = null,
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, cancelable: true, ...mods })
  if (target) Object.defineProperty(e, 'target', { value: target })
  return e
}

function makeAdapter(overrides: Partial<HotkeyAdapter> = {}): HotkeyAdapter & {
  remove: ReturnType<typeof vi.fn>
  duplicate: ReturnType<typeof vi.fn>
  undo: ReturnType<typeof vi.fn>
  redo: ReturnType<typeof vi.fn>
  deselect: ReturnType<typeof vi.fn>
} {
  const adapter: HotkeyAdapter = {
    selectedIds: () => [],
    undo: vi.fn(),
    redo: vi.fn(),
    remove: vi.fn(),
    duplicate: vi.fn(),
    deselect: vi.fn(),
    ...overrides,
  }
  return adapter as never
}

describe('hotkey-logic · resolveHotkey 键位解析', () => {
  const win = { mac: false }
  const mac = { mac: true }

  it('Windows：Ctrl 系列', () => {
    expect(resolveHotkey(ev('z', { ctrlKey: true }), win)).toBe('undo')
    // Shift 按下时 e.key 是大写 'Z'，必须归一后仍能命中重做
    expect(resolveHotkey(ev('Z', { ctrlKey: true, shiftKey: true }), win)).toBe('redo')
    expect(resolveHotkey(ev('y', { ctrlKey: true }), win)).toBe('redo')
    expect(resolveHotkey(ev('d', { ctrlKey: true }), win)).toBe('duplicate')
  })

  it('macOS：⌘ 系列生效、Ctrl 不生效', () => {
    expect(resolveHotkey(ev('z', { metaKey: true }), mac)).toBe('undo')
    expect(resolveHotkey(ev('Z', { metaKey: true, shiftKey: true }), mac)).toBe('redo')
    expect(resolveHotkey(ev('d', { metaKey: true }), mac)).toBe('duplicate')
    // mac 上 Ctrl 不是 MOD，不应命中（避免与系统/编辑器冲突）
    expect(resolveHotkey(ev('z', { ctrlKey: true }), mac)).toBeNull()
    // 反之 Windows 上 ⌘ 无效
    expect(resolveHotkey(ev('z', { metaKey: true }), win)).toBeNull()
  })

  it('Delete / Backspace 删除、Escape 取消选中', () => {
    expect(resolveHotkey(ev('Delete'), win)).toBe('delete')
    expect(resolveHotkey(ev('Backspace'), win)).toBe('delete')
    expect(resolveHotkey(ev('Escape'), win)).toBe('deselect')
  })

  it('未绑定组合不误触', () => {
    expect(resolveHotkey(ev('z'), win)).toBeNull() // 裸 z 不是快捷键
    expect(resolveHotkey(ev('Delete', { ctrlKey: true }), win)).toBeNull()
    expect(resolveHotkey(ev('d', { ctrlKey: true, shiftKey: true }), win)).toBeNull()
    // 带 alt 一律放行（可能被系统 / 输入法占用）
    expect(resolveHotkey(ev('z', { ctrlKey: true, altKey: true }), win)).toBeNull()
    expect(resolveHotkey(ev('Enter'), win)).toBeNull()
  })
})

describe('hotkey-logic · isEditableTarget 输入框守卫', () => {
  it('输入 / 可编辑元素内不劫持按键', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true)
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('select'))).toBe(true)
    const div = document.createElement('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    expect(isEditableTarget(div)).toBe(true)
  })

  it('普通元素 / 空目标返回 false', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('hotkey-logic · runHotkey 分派', () => {
  it('输入框内按 Delete → 不处理（让原生删字）', () => {
    const adapter = makeAdapter()
    const e = keyEvent('Delete', {}, document.createElement('input'))
    expect(runHotkey(e, adapter, { mac: false })).toBe(false)
    expect(adapter.remove).not.toHaveBeenCalled()
  })

  it('有选中：Delete → 逐个删除并 preventDefault', () => {
    const adapter = makeAdapter({ selectedIds: () => ['a', 'b'] })
    const e = keyEvent('Delete')
    expect(runHotkey(e, adapter, { mac: false })).toBe(true)
    expect(adapter.remove.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    expect(e.defaultPrevented).toBe(true)
  })

  it('无选中：Delete 不处理、也不 preventDefault', () => {
    const adapter = makeAdapter()
    const e = keyEvent('Delete')
    expect(runHotkey(e, adapter, { mac: false })).toBe(false)
    expect(adapter.remove).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('有选中：Ctrl+D → 复制选中项', () => {
    const adapter = makeAdapter({ selectedIds: () => ['x'] })
    const e = keyEvent('d', { ctrlKey: true })
    expect(runHotkey(e, adapter, { mac: false })).toBe(true)
    expect(adapter.duplicate).toHaveBeenCalledWith('x')
  })

  it('撤销 / 重做 / 取消选中', () => {
    const adapter = makeAdapter()
    const undoEv = keyEvent('z', { ctrlKey: true })
    expect(runHotkey(undoEv, adapter, { mac: false })).toBe(true)
    expect(adapter.undo).toHaveBeenCalledTimes(1)

    const redoEv = keyEvent('Z', { ctrlKey: true, shiftKey: true })
    expect(runHotkey(redoEv, adapter, { mac: false })).toBe(true)
    expect(adapter.redo).toHaveBeenCalledTimes(1)

    // Escape 不 preventDefault（避免与弹窗自身关闭逻辑冲突）
    const escEv = keyEvent('Escape')
    expect(runHotkey(escEv, adapter, { mac: false })).toBe(true)
    expect(adapter.deselect).toHaveBeenCalledTimes(1)
    expect(escEv.defaultPrevented).toBe(false)
  })
})
