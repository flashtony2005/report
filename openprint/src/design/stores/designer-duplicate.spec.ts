/**
 * P5.1d —— 复制选中控件（Vue store，与 React 端 duplicateControl 同语义）
 *
 * 覆盖：换新 id + 右下偏移 10mm、复制后选中副本、可撤销；
 * 宿主归属 —— zone 子件副本留在原 zone 内（不落正文），zone 本身不复制。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ZoneControl } from '@/types/control'
import { useDesignerStore } from './designer'

function last<T>(arr: T[]): T {
  return arr[arr.length - 1]!
}

function makeZone(id: string): ZoneControl {
  return {
    id,
    type: 'zone',
    zone: 'header',
    zoneHeight: 20,
    left: 0,
    top: 0,
    width: 100,
    height: 20,
    children: [],
  } as unknown as ZoneControl
}

describe('P5.1d · 复制选中控件（Vue store）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('正文控件：换新 id + 右下偏移 10mm，复制后选中副本', () => {
    const store = useDesignerStore()
    store.addControlOfType('text', { leftMm: 10, topMm: 20 })
    const src = last(store.controls)
    const before = store.controls.length

    store.duplicateControl(src.id)

    expect(store.controls.length).toBe(before + 1)
    const clone = last(store.controls)
    expect(clone.id).not.toBe(src.id)
    expect(clone.left).toBe(src.left + 10)
    expect(clone.top).toBe(src.top + 10)
    expect(store.selectedIds).toEqual([clone.id])
  })

  it('撤销复制 → 删除副本，原控件保留', () => {
    const store = useDesignerStore()
    store.addControlOfType('text', { leftMm: 10, topMm: 20 })
    const src = last(store.controls)
    const before = store.controls.length

    store.duplicateControl(src.id)
    store.undo()

    expect(store.controls.length).toBe(before)
    expect(store.controls.some((c) => c.id === src.id)).toBe(true)
  })

  it('zone 子控件：副本留在原 zone 内，不落入正文', () => {
    const store = useDesignerStore()
    store.zones.push(makeZone('z1'))
    store.addControlOfType('text', { leftMm: 1, topMm: 2 }, undefined, 'z1')
    const child = last(store.zones[0]!.children)
    const controlsBefore = store.controls.length

    store.duplicateControl(child.id)

    expect(store.zones[0]!.children.length).toBe(2)
    expect(store.controls.length).toBe(controlsBefore)
    expect(store.selectedIds).toEqual([last(store.zones[0]!.children).id])
  })

  it('zone 本身不可复制', () => {
    const store = useDesignerStore()
    store.zones.push(makeZone('z1'))

    store.duplicateControl('z1')

    expect(store.zones.length).toBe(1)
  })

  it('id 不存在 → 无副作用', () => {
    const store = useDesignerStore()
    store.addControlOfType('text', { leftMm: 10, topMm: 20 })
    const snapshot = JSON.stringify(store.controls)

    store.duplicateControl('not-exist')

    expect(JSON.stringify(store.controls)).toBe(snapshot)
  })
})
