/**
 * 契约 · React 端校验
 *
 * 本端**不录制** golden —— golden 的唯一权威来源是 Vue 端
 * （`openprint/src/contracts/golden/designer-v1.json`）。
 * React 端跑同一份操作序列，输出必须与之逐字段一致。
 *
 * 全绿 == React 版状态层与 Vue 版行为等价 == P1 骨架可交付。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDesignerContract, diffContract } from '@contracts/designer-contract'
import { createReactDriver } from './react-driver'

const GOLDEN = resolve(
  process.cwd(),
  '../openprint/src/contracts/golden/designer-v1.json',
)

const result = runDesignerContract(createReactDriver())

describe('designer 状态层 · 跨框架契约（React 端 vs Vue golden）', () => {
  it('golden fixture 必须已由 Vue 端录制', () => {
    expect(
      existsSync(GOLDEN),
      `golden 不存在：${GOLDEN}\n请先在 openprint 项目跑：npx vitest run src/design/stores/designer-contract.spec.ts`,
    ).toBe(true)
  })

  it('应覆盖与 Vue 端相同的 13 个场景', () => {
    expect(Object.keys(result).length).toBe(13)
    expect(Object.keys(result)[0]).toBe('01-blank')
  })

  it('每个场景都应产出合法 template 结构', () => {
    for (const [name, r] of Object.entries(result)) {
      expect(r.template.version, name).toBe('1.0')
      expect(r.template.document.type, name).toBe('report')
      const body = r.template.document.sections.find((s) => s.type === 'body')
      expect(body, `${name} 缺少 body section`).toBeTruthy()
    }
  })

  it('与 Vue 端 golden 逐字段一致（核心验收）', () => {
    if (!existsSync(GOLDEN)) return // 上一条 it 已报失败
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    const diffs = diffContract(golden, result)
    if (diffs.length > 0) {
      console.error(
        `[contract] React 与 Vue golden 存在 ${diffs.length} 处差异，前 40 条：\n` +
          diffs.slice(0, 40).join('\n'),
      )
    }
    expect(diffs).toEqual([])
  })
})
