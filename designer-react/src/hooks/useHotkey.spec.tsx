/**
 * useHotkey —— React 侧全局快捷键（真实 hook + window keydown）
 *
 * 目的：锁住「选中控件后按 Delete 能删掉」这条最容易被发现缺失的行为，
 * 以及撤销/复制/取消选中、输入框内不劫持。
 *
 * 合成事件在 **window** 上派发（target=window，非输入框），与真实使用一致；
 * Ctrl / ⌘ 同时置位，避免测试受运行环境 isMacPlatform() 判定影响。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AnyControl, ZoneControl } from '@/types/control'
import { resetDesignerStores, useDesignerStore } from '../stores/designer'
import { useHotkey } from './useHotkey'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const controls = (): AnyControl[] => useDesignerStore.getState().controls
const selected = (): string[] => useDesignerStore.getState().selectedIds

function Harness(): ReactElement {
  useHotkey()
  return createElement('div', { className: 'hotkey-probe' })
}

/** 合成 window 级 keydown；mod=true 时 Ctrl / ⌘ 同时置位（平台无关） */
function press(key: string, opts: { mod?: boolean; shift?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        cancelable: true,
        ctrlKey: !!opts.mod,
        metaKey: !!opts.mod,
        shiftKey: !!opts.shift,
      }),
    )
  })
}

/** 落一个文本控件并选中它，返回 id */
function addSelectedText(leftMm = 10, topMm = 10): string {
  useDesignerStore.getState().addControlOfType('text', { leftMm, topMm })
  const id = controls()[controls().length - 1]!.id
  act(() => useDesignerStore.getState().selectControl(id))
  return id
}

describe('useHotkey · React 全局快捷键', () => {
  let host: HTMLElement
  let root: Root

  beforeAll(() => {
    // 固定平台判定，避免真机为 macOS 时 ctrl/meta 语义反转（本用例两者同时置位，双保险）
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
  })

  beforeEach(() => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    resetDesignerStores()
    act(() => root.render(createElement(Harness)))
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.innerHTML = ''
  })

  it('选中控件后按 Delete → 删除，并清空选中', () => {
    addSelectedText()
    expect(controls()).toHaveLength(1)
    press('Delete')
    expect(controls()).toHaveLength(0)
    expect(selected()).toEqual([])
  })

  it('Backspace 同样可删除（笔记本无独立 Delete 键）', () => {
    addSelectedText()
    press('Backspace')
    expect(controls()).toHaveLength(0)
  })

  it('多选时 Delete 逐个删掉', () => {
    const a = addSelectedText(10, 10)
    const b = addSelectedText(30, 10)
    useDesignerStore.setState({ selectedIds: [a, b] })
    press('Delete')
    expect(controls()).toHaveLength(0)
  })

  it('无选中时 Delete 是空操作（不会误删别的控件）', () => {
    addSelectedText()
    act(() => useDesignerStore.getState().selectControl(null))
    press('Delete')
    expect(controls()).toHaveLength(1)
  })

  it('焦点在输入框内不劫持 Delete（让原生删字）', () => {
    addSelectedText()
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(controls()).toHaveLength(1)
  })

  it('mod+Z 撤销刚发生的删除', () => {
    addSelectedText()
    press('Delete')
    expect(controls()).toHaveLength(0)
    press('z', { mod: true })
    expect(controls()).toHaveLength(1)
  })

  it('mod+D 复制选中控件：新 id + 右下偏移 10mm + 选中副本', () => {
    const id = addSelectedText(10, 10)
    press('d', { mod: true })
    expect(controls()).toHaveLength(2)
    const copy = controls()[1]!
    expect(copy.id).not.toBe(id) // 修掉「副本沿用原 id」的老问题
    expect(copy.left).toBe(20)
    expect(copy.top).toBe(20)
    expect(selected()).toEqual([copy.id])
  })

  it('Escape 取消选中，但不删除', () => {
    addSelectedText()
    press('Escape')
    expect(selected()).toEqual([])
    expect(controls()).toHaveLength(1)
  })
})

describe('useHotkey · duplicateControl 边界', () => {
  beforeEach(() => {
    resetDesignerStores()
  })

  it('zone 本身不复制', () => {
    const zone: ZoneControl = {
      id: 'z1',
      type: 'zone',
      zone: 'header',
      left: 0,
      top: 0,
      width: 210,
      height: 20,
      zoneHeight: 20,
      children: [],
    }
    useDesignerStore.setState({ zones: [zone] })
    act(() => useDesignerStore.getState().duplicateControl('z1'))
    expect(useDesignerStore.getState().zones).toHaveLength(1)
  })

  it('页眉/页脚内的子控件复制进同一 zone（不落到正文）', () => {
    const child: AnyControl = {
      id: 'c1',
      type: 'text',
      left: 5,
      top: 2,
      width: 40,
      height: 8,
    } as AnyControl
    const zone: ZoneControl = {
      id: 'z1',
      type: 'zone',
      zone: 'header',
      left: 0,
      top: 0,
      width: 210,
      height: 20,
      zoneHeight: 20,
      children: [child],
    }
    useDesignerStore.setState({ zones: [zone] })
    act(() => useDesignerStore.getState().duplicateControl('c1'))
    const after = useDesignerStore.getState()
    expect(after.controls).toHaveLength(0) // 没落到正文
    expect(after.zones[0]!.children).toHaveLength(2)
    const copy = after.zones[0]!.children[1]!
    expect(copy.id).not.toBe('c1')
    expect(copy.left).toBe(15)
    expect(after.selectedIds).toEqual([copy.id])
  })
})
