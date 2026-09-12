/**
 * 契约 · Vue 端录制/校验
 *
 * 首次运行：golden fixture 不存在 → 跑契约并写出 `contracts/golden/designer-v1.json`
 * 之后运行：与 golden 深比对，不一致即失败（防止 Vue 端行为被无意改动）
 *
 * React 端迁完后会跑同一份契约并与同一个 golden 比对，
 * 两端都绿 == 状态层行为等价。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDesignerContract, diffContract } from '@/contracts/designer-contract'
import { createVueDriver } from './vue-driver'

/** 相对 vitest 工作目录（= 项目根），避免依赖 import.meta.url 的 scheme */
const GOLDEN = resolve(process.cwd(), 'src/contracts/golden/designer-v1.json')

/** 契约只跑一次，多个 it 共享结果（避免依赖 mock 次数漂移） */
const result = runDesignerContract(createVueDriver())

describe('designer 状态层 · 跨框架契约（Vue 端）', () => {
  it('应覆盖全部场景', () => {
    const names = Object.keys(result)
    expect(names.length).toBe(13)
    expect(names[0]).toBe('01-blank')
    expect(names.at(-1)).toBe("13-nested-style-history")
  })

  it('每个场景都应产出合法 template 结构', () => {
    for (const [name, r] of Object.entries(result)) {
      expect(r.template.version, name).toBe('1.0')
      expect(r.template.document.type, name).toBe('report')
      expect(Array.isArray(r.template.document.sections), name).toBe(true)
      const body = r.template.document.sections.find((s) => s.type === 'body')
      expect(body, `${name} 缺少 body section`).toBeTruthy()
    }
  })

  it('场景 02：12 种控件默认工厂全部落地', () => {
    const body = result['02-all-control-types']!.template.document.sections.find(
      (s) => s.type === 'body',
    )!
    expect(body.components.length).toBe(12)
    const types = body.components.map((c) => c.type)
    expect(types).toContain('text')
    expect(types).toContain('barcode')
    expect(types).toContain('labelgrid')
  })

  it('场景 03：属性编辑可逐步撤销、再逐步重做', () => {
    const r = result['03-update-then-undo-redo']!
    const cp = r.checkpoints
    expect(cp['after-add']!.controls.length).toBe(1)
    // 两次 update 后几何已改变
    expect(cp['after-2-updates']!.controls[0]!.left).toBe(35.5)
    expect(cp['after-2-updates']!.controls[0]!.width).toBe(90)
    // 撤一次 → 回到第一次 update 后的状态
    expect(cp['after-undo-1']!.controls[0]!.left).toBe(11.1)
    expect(cp['after-undo-1']!.controls[0]!.width).toBe(66)
    // 再撤一次 → 回到刚添加时的默认几何
    expect(cp['after-undo-2']!.controls[0]!.left).toBe(20)
    expect(cp['after-undo-2']!.controls[0]!.width).not.toBe(66)
    // 重做一次 → 前进到第一次 update 后的状态
    expect(r.snapshot.controls[0]!.left).toBe(11.1)
    expect(r.snapshot.controls[0]!.width).toBe(66)
    expect(r.snapshot.canRedo).toBe(true)
  })

  it('场景 05：撤销到底清空、空栈操作无副作用、重做可完全恢复', () => {
    const cp = result['05-undo-to-empty']!.checkpoints
    expect(cp['after-add-3']!.controls.length).toBe(3)
    expect(cp['after-undo-all']!.controls.length).toBe(0)
    expect(cp['after-undo-all']!.canUndo).toBe(false)
    expect(cp['after-undo-all']!.canRedo).toBe(true)
    // 空栈再撤一次：不得有副作用
    expect(cp['after-undo-overflow']!.controls.length).toBe(0)
    expect(cp['after-undo-overflow']!.canUndo).toBe(false)
    // 重做到底：完全恢复
    expect(cp['after-redo-all']!.controls.length).toBe(3)
    expect(cp['after-redo-all']!.canRedo).toBe(false)
    // 空栈再重做一次：不得有副作用
    expect(cp['after-redo-overflow']!.controls.length).toBe(3)
  })

  it('场景 10：新建模板应清空历史栈', () => {
    const cp = result['10-new-blank-clears-history']!.checkpoints
    expect(cp['before-new-blank']!.controls.length).toBe(2)
    expect(cp['before-new-blank']!.canUndo).toBe(true)
    expect(cp['after-new-blank']!.controls.length).toBe(0)
    expect(cp['after-new-blank']!.canUndo).toBe(false)
    expect(cp['after-new-blank']!.canRedo).toBe(false)
  })

  it('场景 12：坐标应 snap 到 0.1mm 且负数收敛为 0', () => {
    const body = result['12-coordinate-snap']!.template.document.sections.find(
      (s) => s.type === 'body',
    )!
    expect(body.components[0]!.left).toBe(139.8)
    expect(body.components[0]!.top).toBe(0)
    expect(body.components[1]!.left).toBe(0)
    expect(body.components[2]!.left).toBe(33.3)
  })

  it('与 golden fixture 逐字段一致', () => {
    if (!existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true })
      writeFileSync(GOLDEN, JSON.stringify(result, null, 2), 'utf8')
      console.log(`[golden] 首次运行，已录制 ${Object.keys(result).length} 个场景 → ${GOLDEN}`)
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    const diffs = diffContract(golden, result)
    if (diffs.length > 0) {
      console.error(`[golden] 发现 ${diffs.length} 处差异，前 40 条：\n${diffs.slice(0, 40).join('\n')}`)
    }
    expect(diffs).toEqual([])
  })
})
