/**
 * AI 助手配置 —— 纯前端、零后端、存本地（localStorage）。
 * 走 OpenAI 兼容 /chat/completions 协议：用户自己填 地址 / Key / 模型 ID。
 * 与 print-settings.ts 同套路（window.localStorage + 固定 STORAGE_KEY）。
 */
export interface AiSettings {
  /** OpenAI 兼容的 baseURL，需含 /v1（如 https://api.openai.com/v1） */
  baseURL: string
  /** 用户自己的 API Key（明文存本地，仅本地单用户场景） */
  apiKey: string
  /** 模型 ID，如 gpt-4o-mini / deepseek-chat / qwen-plus */
  model: string
  /** 是否已启用 AI 助手 */
  enabled: boolean
}

/** 常见 provider 预设（点击即填，用户仍可自行改地址） */
export interface AiProviderPreset {
  label: string
  baseURL: string
  model: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '自定义', baseURL: '', model: '' },
]

const STORAGE_KEY = 'openprint:ai:config'

const DEFAULT_AI_SETTINGS: AiSettings = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  enabled: false,
}

function safeRead(): AiSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_AI_SETTINGS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_AI_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AiSettings>
    return {
      baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL : DEFAULT_AI_SETTINGS.baseURL,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_AI_SETTINGS.model,
      enabled: !!parsed.enabled,
    }
  } catch {
    return { ...DEFAULT_AI_SETTINGS }
  }
}

function safeWrite(v: AiSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
  } catch {
    /* noop */
  }
}

export function readAiSettings(): AiSettings {
  return safeRead()
}

export function writeAiSettings(v: AiSettings): void {
  safeWrite(v)
}

/** 是否已具备发起请求的最低配置 */
export function isAiConfigured(): boolean {
  const s = safeRead()
  return s.enabled && !!s.baseURL.trim() && !!s.apiKey.trim() && !!s.model.trim()
}
