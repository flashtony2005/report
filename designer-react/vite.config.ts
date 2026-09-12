import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import unocss from 'unocss/vite'
import { normalizePath, type Plugin } from 'vite'
import { resolve } from 'node:path'

/**
 * React 设计器骨架。
 *
 * 关键设计：本应用**不复制** Vue 项目的引擎代码，而是通过 alias 直接引用
 * `../openprint/src` 下的零框架依赖层（core / types / utils / contracts）。
 * 这样迁移期不存在两份代码分叉，验证成本最低；
 * 待 React 版 UI 回归通过后，再把这些目录正式抽成 packages/engine。
 */
const OPENPRINT_SRC = resolve(__dirname, '../openprint/src')

/**
 * 把 `../openprint/src` 下的引擎文件纳入 dev 监听。
 *
 * 这些文件在 vite root（designer-react/）之外，chokidar 默认不监听 ——
 * 于是改完引擎层（core / config / types…）后，页面拿到的还是**旧模块**：
 * 典型症状是 `ReferenceError: xxx is not defined`（新增的导出在旧模块里不存在），
 * 必须重启 dev server 才生效。`load` 里 addWatchFile 后，改动即触发模块失效 / HMR。
 */
function watchEngineFiles(): Plugin {
  const engineRoot = normalizePath(OPENPRINT_SRC)
  return {
    name: 'openprint:watch-engine',
    apply: 'serve',
    load(id) {
      if (id && normalizePath(id).startsWith(engineRoot)) this.addWatchFile(id)
      return null
    },
  }
}

export default defineConfig({
  // unocss 与 Vue 版同源（presetWind4 + 品牌色 CSS 变量），见 uno.config.ts。
  // 此前缺失导致组件里的原子类（absolute inset-0 等）全部无效——
  // 标尺覆盖层因此掉出定位流、被画布内容盖住的 bug 即源于此。
  plugins: [react(), unocss(), watchEngineFiles()],
  resolve: {
    // 注意顺序：更具体的规则必须排在前面。
    // `@` 指向 **Vue 项目的 src** —— 因为被引用的引擎层代码（core/types/design）内部
    // 都用 `@/xxx` 互相引用，只有让 `@` 落在 openprint/src 才能整条链路解析成功。
    // 本项目自身代码一律用相对路径，避免与引擎层的 `@` 抢别名。
    alias: [
      // —— P2：画布内核解耦 shim ——
      // 画布内核（CanvasDesigner → table-design-render）依赖 Pinia 的 dataSource store，
      // 用 shim 顶替，避免为了迁 UI 而改动引擎代码。
      // 注意：必须排在 `@` 之前，否则会被 `@` 的前缀匹配抢先解析到 Vue 项目里去。
      // （rulerHighlight 不再需要 shim：Vue 端源文件已改为框架无关的显式订阅实现）
      {
        find: '@/design/stores/dataSource',
        replacement: resolve(__dirname, 'src/canvas/shims/dataSource.ts'),
      },
      { find: '@contracts', replacement: resolve(OPENPRINT_SRC, 'contracts') },
      { find: '@', replacement: OPENPRINT_SRC },
    ],
  },
  server: {
    // 允许访问 vite root 之外的 ../openprint 目录
    fs: { allow: [resolve(__dirname, '..')] },
    port: 5188,
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    // 统一清理用例残留的 timer / rAF，避免环境拆除后触碰 window 造成假失败（见 src/test-setup.ts）
    setupFiles: ['./src/test-setup.ts'],
    // P4.2 面板含 antd Select/Popup 交互，happy-dom 下较慢，放宽默认 5s 超时
    testTimeout: 20000,
    // AppShell 等壳层挂载（antd + 画布装配）并行时可能超过 10s
    hookTimeout: 30000,
  },
})
