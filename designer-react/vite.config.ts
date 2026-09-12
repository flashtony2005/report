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

export default defineConfig(({ command }) => ({
  // 生产态用相对路径：产物可放在任意子路径下被托管（本地打印客户端 / 静态服务器都可能挂在子目录）。
  // dev 必须保持 '/'，Vite 的相对 base 只在 build 生效。
  base: command === 'build' ? './' : '/',

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
  build: {
    // 拆包策略：只把「入口必然要用」的大依赖归到具名 chunk，其余一律交给 Rollup 自动切分。
    //
    // 为什么只点名 react / antd：
    // 它们在 App 静态 import 链上，一定在首屏 → 拆出来让它们与业务代码各自独立缓存，
    // 业务改动不再让整块 vendor 缓存失效，首屏也能三路并行下载。
    //
    // 反例（实测踩过的坑，不要做）：
    // 1) 把 xlsx / jspdf / html2canvas 也塞进 vendor —— 它们目前是懒加载块，
    //    一旦并进首屏 vendor 就会被提前下载，首屏体积反而变大。
    // 2) 把 `@univerjs/*` 整体归成一个块 —— univer 内部用动态 import 挂 40 多个
    //    语言包，强行合并会把它们全部从「按需」变成「随 univer 一起下载」，
    //    实测 chunk 从 5.5MB 涨到 10.2MB。保持不介入，Rollup 自会把语言包切成独立块。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (/node_modules[\\/](antd|@ant-design)[\\/]/.test(id)) return 'antd'
          return undefined
        },
      },
    },
    // univer 是报表表格编辑器，本身 5MB+（懒加载块，首屏不加载）。默认 500KB 的
    // 告警对它无意义、只会刷满构建日志 —— 抬高阈值，让真正的体积回归仍能报警。
    chunkSizeWarningLimit: 6000,
  },
  server: {
    // 允许访问 vite root 之外的 ../openprint 目录
    fs: { allow: [resolve(__dirname, '..')] },
    port: 5188,
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: [
      // —— 本应用自身的用例 ——
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
      // —— 引擎层（../openprint/src）的用例 ——
      // 引擎源码被本应用经 alias `@` 复用，它的 spec 一度只跑在 Vue 项目的 vitest 里；
      // 既然 Vue 不是我们的技术栈，就必须把它收进自己的跑器，
      // 否则「跑一次测试」会静默丢掉整层引擎的覆盖（65 个 spec / 660+ 用例）。
      '../openprint/src/**/*.spec.ts',
    ],
    // 显式设置 exclude 会覆盖 vitest 默认值 → 必须把默认项也列上
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // —— 以下 spec 属于 Vue 应用层，React 不再消费（2026-09-12 方向决定）——
      // 3 个依赖 Vue / Pinia 的状态层 spec
      '../openprint/src/design/stores/dataSource.spec.ts',
      '../openprint/src/design/stores/designer-duplicate.spec.ts',
      '../openprint/src/design/stores/designer-field-bind.spec.ts',
      // Vue 侧的 golden「录制器」：按 process.cwd() 解析写入路径，跑到 React 的
      // cwd 下会**误判为首次运行而录制一份副本**（既污染仓库、又让断言退化成自比自）。
      // 契约校验由 React 自己的 `src/stores/designer-contract.spec.ts` 负责（只读、比对必失败）。
      '../openprint/src/design/stores/designer-contract.spec.ts',
    ],
    // 统一清理用例残留的 timer / rAF，避免环境拆除后触碰 window 造成假失败（见 src/test-setup.ts）
    setupFiles: ['./src/test-setup.ts'],
    // P4.2 面板含 antd Select/Popup 交互，happy-dom 下较慢，放宽默认 5s 超时
    testTimeout: 20000,
    // AppShell 等壳层挂载（antd + 画布装配）并行时可能超过 10s
    hookTimeout: 30000,
  },
}))
