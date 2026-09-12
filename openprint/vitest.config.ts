import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 测试配置：复用项目的 @ alias；环境用 happy-dom（无真实排版，纯函数测试足够）。
// 不引入 unocss 插件——核心单测不依赖 unocss 虚拟模块，避免测试期副作用。
export default defineConfig({
  // vue() 插件类型与 vitest 内置 vite（rolldown/rollup 双实现）存在类型冲突，
  // 此处为测试配置，强制 any 以通过 vue-tsc 类型检查（不影响运行）。
  plugins: [vue() as unknown as never],
  server: {
    host: '0.0.0.0',
    port: 5227,
    open: true,
  },
  preview: {
    port: 5227,
     host: '0.0.0.0'
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.ts', 'src/design/preview/**/*.ts', 'src/repository/mock/**/*.ts'],
      exclude: ['src/core/**/*.d.ts', 'src/core/**/index.ts'],
    },
  },
})
