import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import unocss from 'unocss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), vueDevTools(), unocss()],
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
    // CodeMirror 6 子包必须单例，否则 instanceof 检查失败（"multiple instances of @codemirror/state"）
    dedupe: ['@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands', '@lezer/common', '@lezer/highlight', '@lezer/lr', '@lezer/json'],
  },
  optimizeDeps: {
    // 预打包，避免运行时动态 import 触发二次优化导致 dev server 重启
    // （tiptap 相关：富文本编辑器 defineAsyncComponent 懒加载，若不在 include 里，
    //  首次选中富文本时会触发 re-optimize 删除 deps_temp，被 safe-delete 守卫拦崩 dev server）
    include: [
      'ajv',
      'fabric',
      'qrcode',
      '@bwip-js/generic',
      '@tiptap/vue-3',
      '@tiptap/starter-kit',
      '@tiptap/extension-text-style',
      '@tiptap/extension-font-family',
      'codemirror',
      'vue-codemirror6',
      '@codemirror/lang-json',
    ],
  },
  build: {
    // jspdf + svg2pdf.js 走动态 import，避免进主包
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('jspdf') || id.includes('svg2pdf')) return 'pdf'
            if (id.includes('fabric')) return 'fabric'
          }
        },
      },
    },
  },
})
