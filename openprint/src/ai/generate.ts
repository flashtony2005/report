/**
 * AI 生成编排 —— 组装提示词 → 流式调用 → 解析 JSON → 归一化 → 校验/修复。
 * 纯前端、一次性问答；不落库，结果由调用方决定如何应用。
 */
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'
import { validateTemplate } from '@/core/spec/validator'
import { streamChat, AiRequestError } from './client'
import { buildSystemPrompt, buildUserPrompt, getFewShot } from './schema'
import { normalizeControl, normalizeTemplate } from './normalize'
import type { AiSettings } from '@/config/ai-settings'

export interface GenerateRequest {
  prompt: string
  /** 基于当前模板修改时传入 */
  currentTemplate?: TemplateData<AnyControl>
  /** 仅针对画布中选中的控件改写（C 功能）：传入这些控件的协议 JSON */
  selectedControls?: AnyControl[]
  /** 数据字段接地（可选） */
  datasourceFields?: string[]
  settings: AiSettings
  onToken?: (delta: string) => void
  signal?: AbortSignal
}

export interface GenerateResult {
  ok: boolean
  data?: TemplateData<AnyControl>
  /** 选区改写模式：返回的新控件集合（用于替换原选中控件） */
  controls?: AnyControl[]
  error?: string
  /** 模型原始输出（用于调试 / 展示） */
  raw?: string
}

/** 从模型文本中提取 JSON（兼容 ```json 代码块 / 纯 JSON / 首尾花括号） */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1) 直接可解析
  try {
    return JSON.parse(trimmed)
  } catch {
    /* fallthrough */
  }

  // 2) ```json ... ``` 代码块
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* fallthrough */
    }
  }

  // 3) 第一个 { 到最后一个 }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1))
    } catch {
      /* fallthrough */
    }
  }
  return null
}

function fmtError(e: unknown): string {
  if (e instanceof AiRequestError) return e.message
  if (e instanceof DOMException && e.name === 'AbortError') return '已取消生成。'
  return e instanceof Error ? e.message : '未知错误'
}

/**
 * 生成模板。
 * - 普通 / 基于当前模板改：返回完整 TemplateData，失败时最多把校验错误回传模型重试一次。
 * - 选区改写（selectedControls）：模型返回控件数组，归一化后返回 controls。
 */
export async function generateTemplate(req: GenerateRequest): Promise<GenerateResult> {
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt() },
    ...getFewShot(),
    { role: 'user' as const, content: buildUserPrompt(req) },
  ]

  // —— 选区改写模式：期望模型返回控件数组 ——
  if (req.selectedControls && req.selectedControls.length) {
    let raw = ''
    try {
      raw = await streamChat({
        baseURL: req.settings.baseURL,
        apiKey: req.settings.apiKey,
        model: req.settings.model,
        messages,
        onToken: (d) => req.onToken?.(d),
        signal: req.signal,
      })
    } catch (e) {
      return { ok: false, error: fmtError(e), raw }
    }
    const json = extractJson(raw)
    const arr = Array.isArray(json) ? json : []
    const controls = arr
      .map((c) => (typeof c === 'object' && c ? normalizeControl(c as Record<string, unknown>) : null))
      .filter((c): c is AnyControl => c !== null)
    if (!controls.length) {
      return { ok: false, error: '模型未返回有效的控件 JSON（应为控件数组）。', raw }
    }
    return { ok: true, controls, raw }
  }

  // —— 完整模板模式 ——
  let raw = ''
  const MAX_ATTEMPTS = 2
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      raw = await streamChat({
        baseURL: req.settings.baseURL,
        apiKey: req.settings.apiKey,
        model: req.settings.model,
        messages,
        onToken: (d) => req.onToken?.(d),
        signal: req.signal,
      })
    } catch (e) {
      return { ok: false, error: fmtError(e), raw }
    }

    const json = extractJson(raw)
    if (!json) {
      return { ok: false, error: '模型未返回有效的模板 JSON。', raw }
    }

    const normalized = normalizeTemplate(json)
    const result = validateTemplate(normalized)
    if (result.valid) {
      return { ok: true, data: normalized, raw }
    }

    // 重试：把校验错误反馈给模型
    if (attempt < MAX_ATTEMPTS - 1) {
      const issues = result.issues
        .map((i) => `${i.path || '/'}：${i.message}`)
        .join('；')
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content: `你的输出未通过模板协议校验，请修正后只输出正确 JSON。错误：${issues}`,
      })
      raw = ''
      continue
    }
    return {
      ok: false,
      error: `模板校验失败：${result.issues
        .map((i) => `${i.path || '/'}: ${i.message}`)
        .join('；')}`,
      raw,
    }
  }
  return { ok: false, error: '生成失败（超出重试次数）。', raw }
}
