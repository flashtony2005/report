/**
 * main.tsx —— React 设计器入口
 *
 * 主题闭环对齐 Vue 版 main.tsx：
 * - ui store 是唯一真相源，html.dark/.svip 类由 syncDom() 落到 documentElement；
 * - 系统主题变化监听由 bindSystemListener() 接管（返回取消函数，开发态不取消）。
 */
// UnoCSS 原子类必须最先引入（早于 App 内的 brand/antd-reset/app.css，
// 保证项目自有 CSS 能按需覆盖工具类）。缺失它 = absolute/inset-0 等全部失效。
import 'uno.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useUiStore } from './stores/ui'

// 初始 DOM 主题同步 + 监听系统亮暗变化
useUiStore.getState().syncDom()
useUiStore.getState().bindSystemListener()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
