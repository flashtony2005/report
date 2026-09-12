import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vite.config'

/**
 * 引擎层（`../openprint/src`）测试的独立配置 —— 只跑引擎，不跑 React 应用。
 *
 * 背景：引擎源码 `openprint/src/**` 被 React 端经 alias `@` 复用，但它的 spec 一直
 * 只跑在 **Vue 项目的 vitest** 里 —— 而 Vue 已不是我们的技术栈（2026-09-12 决定）。
 * 于是「只跑 React 单端回归」会静默丢掉整层引擎的测试覆盖。
 *
 * 复用 vite.config.ts 的 alias / plugins，只把 include 收窄到引擎目录。
 * 注意：mergeConfig 对数组是**拼接**而非替换，所以这里显式赋值覆盖。
 * 少数强耦合 Vue/Pinia 的 spec（design/stores 下 3 个）在此环境跑不了，显式排除。
 *
 * 主配置（vite.config.ts）已经把引擎 spec 一并纳入，`npm run test` 即为完整回归；
 * 本配置用于「只改引擎时」的快速反馈（`npm run test:engine`）。
 */
const baseResolved =
  typeof base === 'function'
    ? (base as never as (e: never) => never)({ command: 'serve', mode: 'test' } as never)
    : base

const merged = mergeConfig(
  baseResolved as never,
  defineConfig({}) as never,
) as { test: Record<string, unknown> }

merged.test.include = ['../openprint/src/**/*.spec.ts']
merged.test.exclude = [
  '**/node_modules/**',
  // 依赖 Vue / Pinia（Vue 应用状态层，非可跨端复用的引擎）
  '../openprint/src/design/stores/dataSource.spec.ts',
  '../openprint/src/design/stores/designer-duplicate.spec.ts',
  '../openprint/src/design/stores/designer-field-bind.spec.ts',
  // Vue 侧 golden 录制器：按 process.cwd() 写盘，跑到 React cwd 下会误录制副本
  // （污染仓库 + 断言退化成自比自）。契约校验交给 React 自己的 spec。
  '../openprint/src/design/stores/designer-contract.spec.ts',
]

export default merged
