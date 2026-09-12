import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * SDK 独立构建配置
 *
 * 产出两个入口：
 * - `sdk.js`  —— 浏览器端（渲染 + 导出 PDF/JPG/SVG + 本地打印客户端）
 * - `node.js` —— Node 服务端（仅渲染 HTML，不含导出/打印）
 *
 * 与 App 构建（vite.config.ts）完全分离：不进主包，不影响设计器产物。
 */
const root = fileURLToPath(new URL('./', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  build: {
    lib: {
      entry: {
        sdk: resolve(root, 'src/sdk/index.ts'),
        node: resolve(root, 'src/sdk/node.ts'),
      },
      formats: ['es'],
    },
    outDir: 'dist-sdk',
    emptyOutDir: true,
    sourcemap: true,
    /**
     * 把 vue 列为 external 是一道**防线**而非优化：
     * 引擎层本就不依赖 Vue（已验证产物零 Vue 特征串）。万一哪天有人误把
     * design 层的东西引进来，这里不会静默把框架塞进 SDK，而是留下一个裸 import
     * 让使用方立刻发现，比悄悄膨胀 300 kB 好得多。
     */
    rollupOptions: {
      external: ['vue'],
      output: {
        // 入口文件留在根目录，按需 chunk 归到 chunks/，避免与入口同名造成歧义
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
