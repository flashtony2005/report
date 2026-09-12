/**
 * HttpClient —— 后端对接的底层 fetch 封装（《后端对接规范》§2.2 信封约定）
 *
 * - 统一列表信封 `{ items, total }` → 用 `list()` 直接取 items
 * - 错误信封 `{ code, message, detail, requestId }` → 抛 HttpError（带 code/status/detail）
 * - 204 No Content → 返回 null（删除接口适用）
 * - JSON 请求/响应，自动注入 Bearer 鉴权头（配置了 token 时）
 */
export interface HttpOptions {
  /** 基地址，如 https://print.example.com（结尾斜杠自动归一） */
  baseUrl: string
  /** 可选 Bearer token */
  token?: string
  /** 额外请求头（不与 Content-Type/Accept/Authorization 冲突） */
  headers?: Record<string, string>
}

export interface ApiEnvelope<T> {
  items: T[]
  total: number
}

export interface ApiErrorBody {
  code?: string
  message?: string
  detail?: unknown
  requestId?: string
}

export class HttpError extends Error {
  code?: string
  status?: number
  detail?: unknown
  requestId?: string

  constructor(message: string, init?: Partial<Omit<HttpError, 'message'>>) {
    super(message)
    this.name = 'HttpError'
    if (init) Object.assign(this, init)
  }
}

export class HttpClient {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly extraHeaders: Record<string, string>

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.extraHeaders = opts.headers ?? {}
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...this.extraHeaders,
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    return headers
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const url = `${this.baseUrl}${path}`
    let res: Response
    try {
      res = await fetch(url, { ...init, headers: this.buildHeaders() })
    } catch (e) {
      throw new HttpError(`网络请求失败：${(e as Error).message}`, { status: 0 })
    }

    // 204 无 body（删除接口）
    if (res.status === 204) return null

    const text = await res.text()
    const body = text.length > 0 ? (JSON.parse(text) as unknown) : null

    if (!res.ok) {
      const errBody = (body ?? {}) as ApiErrorBody
      throw new HttpError(errBody.message || `请求失败（HTTP ${res.status}）`, {
        code: errBody.code,
        status: res.status,
        detail: errBody.detail,
        requestId: errBody.requestId,
      })
    }
    return body as T
  }

  /** 详情 / 创建 / 更新：返回资源对象（或无内容时 null） */
  async json<T>(path: string, init?: RequestInit): Promise<T | null> {
    return this.request<T>(path, init)
  }

  /** 列表接口：解包 `{ items, total }` 信封，返回 items 数组 */
  async list<T>(path: string, init?: RequestInit): Promise<T[]> {
    const env = await this.request<ApiEnvelope<T>>(path, init)
    return env?.items ?? []
  }
}
