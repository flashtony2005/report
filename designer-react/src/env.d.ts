/// <reference types="vite/client" />

/**
 * React 端引用 Vue 项目引擎层源码时缺失的环境声明。
 * 这些类型在 Vue 项目里由它自己的 env.d.ts / tsconfig 提供，
 * React 项目通过 alias 跨项目引用后需要在此补齐。
 */

/** opentype.js 无官方类型（引擎层自己有 opentype.d.ts，但路径解析不到） */
declare module 'opentype.js'

/** Vite 的 ?raw 资源导入 */
declare module '*?raw' {
  const content: string
  export default content
}
