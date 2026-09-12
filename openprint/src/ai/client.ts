/**
 * AI 客户端 —— 纯前端直连 OpenAI 兼容 /chat/completions（SSE 流式）。
 * 不依赖任何后端；baseURL / apiKey / model 全部由用户在前端设置里提供。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamOptions {
  baseURL: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  onToken: (delta: string) => void
  signal?: AbortSignal
}

/** LLM 调用错误（携带 HTTP 状态码，便于前端给出友好提示） */
export class AiRequestError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AiRequestError'
    this.status = status
  }
}

function friendlyError(status: number, body: string): string {
  if (status === 401) return 'API Key 无效或已过期，请检查设置中的 Key。'
  if (status === 404) return '接口地址不正确（请确认 baseURL 含 /v1 且路径为 /chat/completions）。'
  if (status === 429) return '请求过于频繁或额度不足（429）。'
  if (status >= 500) return `模型服务异常（HTTP ${status}）。`
  // 跨域 / 网络层：fetch 抛 TypeError，没有 status
  const lower = body.toLowerCase()
  if (lower.includes('cors') || lower.includes('cross-origin')) {
    return '跨域(CORS)被拦截：浏览器直连该地址受限。可将 baseURL 改为你自己的代理（如 Cloudflare Worker / Vercel Edge），或在支持浏览器直连的模型服务上使用。'
  }
  return body ? `请求失败（HTTP ${status}）：${body.slice(0, 200)}` : `请求失败（HTTP ${status}）`
}

/**
 * 流式对话（SSE）。逐 token 回调 onToken，最终返回完整文本。
 * 兼容 OpenAI / DeepSeek / 通义 等 OpenAI 格式（data: {choices:[{delta:{content}}]}）。
 */
export async function streamChat(opts: StreamOptions): Promise<string> {
  const url = `${opts.baseURL.replace(/\/+$/, '')}/chat/completions`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: 0.6,
      }),
      signal: opts.signal,
    })
  } catch (e) {
    // 网络层错误（含 CORS）：fetch 抛 TypeError，无 status
    const reason = e instanceof Error ? e.message : String(e)
    if (reason.toLowerCase().includes('cors') || reason.toLowerCase().includes('cross-origin')) {
      throw new AiRequestError(
        0,
        '跨域(CORS)被拦截：浏览器直连该地址受限。可将 baseURL 改为你自己的代理（如 Cloudflare Worker / Vercel Edge），或在支持浏览器直连的模型服务上使用。',
      )
    }
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new AiRequestError(0, `无法连接模型服务：${reason}`)
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new AiRequestError(res.status, friendlyError(res.status, txt))
  }

  if (!res.body) {
    throw new AiRequestError(0, '响应缺少流式数据体。')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line || line.startsWith(':')) continue
        if (line === 'data: [DONE]') continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          const obj = JSON.parse(payload)
          const delta: string | undefined = obj.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            opts.onToken(delta)
          }
        } catch {
          // 忽略不完整的分片
        }
      }
    }
  } finally {
    // 确保 reader 被释放（中断时也清理）
    try {
      await reader.cancel()
    } catch {
      /* noop */
    }
  }

  // 兜底：部分 OpenAI 兼容端点忽略 stream:true，直接返回单次 JSON（choices[0].message.content）。
  // 这种情况下上面没有触发 onToken，这里做一次补偿，保证仍能解析出模板文本。
  if (!full) {
    const trimmed = buffer.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const obj = JSON.parse(trimmed) as {
          choices?: Array<{ message?: { content?: string }; text?: string }>
        }
        const content = obj.choices?.[0]?.message?.content ?? obj.choices?.[0]?.text
        if (content) {
          full = content
          opts.onToken(content)
        }
      } catch {
        /* 不是纯 JSON，忽略 */
      }
    }
  }

  return full
}
