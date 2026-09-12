/**
 * 后端对接配置开关 —— 《后端对接规范》§4
 *
 * 铁律（2026-08-08 主任定）：未配置后端接口时，全部走本地存储（模板）/ Mock（数据源），
 * 一切功能不受影响。只有显式配置了 `VITE_OPENPRINT_API_BASE` 才切换为云端仓库。
 *
 * 配置方式（项目根目录 .env）：
 *   VITE_OPENPRINT_API_BASE=https://print.example.com
 *   VITE_OPENPRINT_API_TOKEN=  # 可选，Bearer 鉴权
 *
 * 基地址会被当作前缀拼接：`/api/print/templates` → `https://print.example.com/api/print/templates`
 */
import type { HttpOptions } from '@/repository/http-client'

const API_BASE = (import.meta.env.VITE_OPENPRINT_API_BASE ?? '').trim()
const API_TOKEN = (import.meta.env.VITE_OPENPRINT_API_TOKEN ?? '').trim()

export interface BackendConfig {
  mode: 'cloud'
  options: HttpOptions
}

/** 是否已配置后端（决定走云端仓库还是本地/Mock） */
export const isBackendConfigured = API_BASE.length > 0

/** 读取后端配置；未配置返回 null（调用方据此保持本地/Mock） */
export function getBackendConfig(): BackendConfig | null {
  if (!API_BASE) return null
  return {
    mode: 'cloud',
    options: {
      baseUrl: API_BASE,
      token: API_TOKEN.length > 0 ? API_TOKEN : undefined,
    },
  }
}
