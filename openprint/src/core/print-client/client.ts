/**
 * 本地打印机客户端 HTTP 客户端 —— 纯 TypeScript，零框架依赖
 *
 * 所有方法都显式接收 baseUrl（由 `@/config/printer` 解析），
 * 便于 headless / 单测直接注入，不隐式读全局配置。
 */
import {
  PrintClientError,
  normalizeDbEngine,
  type ClientColumn,
  type ClientDatabase,
  type ClientDataListResponse,
  type ClientRowsResponse,
  type ClientTable,
  type DbEngine,
  type PrinterHealth,
  type PrinterInfo,
  type PrinterListResponse,
  type PrintJobRequest,
  type PrintJobResponse,
  type SystemFontEntry,
  type SystemFontListResponse,
} from './types'

/** 出厂默认地址（用户未配置时使用） */
export const DEFAULT_PRINTER_BASE_URL = 'http://127.0.0.1:18888'

/**
 * 探测类请求默认超时（ms）。
 * 3s → 6s：本地客户端在字体加载 / 打印机枚举期间可能短暂忙碌（Qt 单连接服务排队），
 * 太短会把正常的探测误判为超时，导致"连接好了却显示断开"。
 */
export const PROBE_TIMEOUT_MS = 6000

/** 提交打印任务默认超时（ms）—— 大文档 base64 传输留足时间 */
export const SUBMIT_TIMEOUT_MS = 30000

/** 去掉尾部斜杠，拼接路径 */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * 带超时 + 错误分类的 fetch。
 * 用手工 AbortController 而非 AbortSignal.timeout，才能区分「超时」与「连不上」。
 */
async function request<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)

  let res: Response
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal })
  } catch {
    if (timedOut) {
      throw new PrintClientError('timeout', `请求超时（${timeoutMs}ms）：${url}`)
    }
    throw new PrintClientError('network', `无法连接打印客户端：${url}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new PrintClientError('http', `HTTP ${res.status} ${res.statusText}`, res.status)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new PrintClientError('parse', '响应不是合法 JSON')
  }
  if (json === null || typeof json !== 'object') {
    throw new PrintClientError('parse', '响应结构异常')
  }
  return json as T
}

/* ------------------------------ GET /health ------------------------------ */

/**
 * 健康检查。成功返回服务版本、打印机数量、运行时长。
 * @throws PrintClientError 连接失败 / 超时 / ok:false
 */
export async function checkHealth(
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PrinterHealth> {
  const data = await request<Partial<PrinterHealth>>(
    joinUrl(baseUrl, '/health'),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
  )
  if (data.ok !== true) {
    throw new PrintClientError('service', '打印客户端报告服务异常（ok=false）')
  }
  return {
    app: data.app ?? 'Unknown',
    ok: true,
    printers: typeof data.printers === 'number' ? data.printers : 0,
    time: data.time ?? '',
    uptimeSec: typeof data.uptimeSec === 'number' ? data.uptimeSec : 0,
    version: data.version ?? '',
  }
}

/* ------------------------------ GET /printers ------------------------------ */

/** 单台打印机字段归一化（服务端字段缺失时给安全默认，避免 UI 崩） */
function normalizePrinter(raw: Partial<PrinterInfo>, index: number): PrinterInfo {
  const maxDpi = typeof raw.maxDpi === 'number' && raw.maxDpi > 0 ? Math.floor(raw.maxDpi) : 0
  // defaultDpi 缺失/非法时回退 300（≈旧固定 scale 3 = 288dpi 的清晰度档位）；
  // 若 maxDpi 已知且更小，再钳到 maxDpi 内，保证默认值永远可打
  let defaultDpi =
    typeof raw.defaultDpi === 'number' && raw.defaultDpi > 0 ? Math.floor(raw.defaultDpi) : 300
  if (maxDpi > 0 && defaultDpi > maxDpi) defaultDpi = maxDpi
  return {
    driver: raw.driver ?? '',
    defaultDpi,
    isDefault: raw.isDefault === true,
    isOnline: raw.isOnline !== false,
    kind: raw.kind === 'virtual' || raw.kind === 'ticket' ? raw.kind : 'common',
    maxDpi,
    name: raw.name ?? `未命名打印机 ${index + 1}`,
    status: raw.status === 'error' ? 'error' : 'idle',
    supportsColor: raw.supportsColor === true,
    supportsDuplex: raw.supportsDuplex === true,
    trays: Array.isArray(raw.trays) ? raw.trays.filter((t): t is string => typeof t === 'string') : [],
  }
}

/**
 * 获取打印机列表。
 * 注意：**以 `printers` 数组长度为准**，服务端的 `count` 字段仅供参考（实测可能不一致）。
 */
export async function listPrinters(
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PrinterInfo[]> {
  const data = await request<Partial<PrinterListResponse>>(
    joinUrl(baseUrl, '/printers'),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
  )
  if (data.ok === false) {
    throw new PrintClientError('service', '打印客户端未能枚举打印机')
  }
  if (!Array.isArray(data.printers)) {
    throw new PrintClientError('parse', '响应缺少 printers 数组')
  }
  return data.printers.map((p, i) => normalizePrinter(p ?? {}, i))
}

/* ------------------------------ GET /api/fonts ------------------------------ */

/** 字体格式 → CSS format() 描述符 */
export function fontFormatToCss(format: SystemFontEntry['format']): string {
  switch (format) {
    case 'ttf':
      return 'truetype'
    case 'otf':
      return 'opentype'
    case 'woff':
      return 'woff'
    case 'woff2':
      return 'woff2'
  }
}

/** 字体格式 → HTTP Content-Type */
export function fontContentType(format: SystemFontEntry['format']): string {
  switch (format) {
    case 'ttf':
      return 'font/ttf'
    case 'otf':
      return 'font/otf'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
  }
}

/**
 * 枚举本机/局域网客户端的电脑系统字体。
 * 字体字节本身不在此返回 —— 用 systemFontDataUrl() 拼装按需加载的 URL。
 */
export async function listSystemFonts(
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SystemFontEntry[]> {
  const data = await request<Partial<SystemFontListResponse>>(
    joinUrl(baseUrl, '/api/fonts'),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
  )
  if (data.ok === false) {
    throw new PrintClientError('service', '打印客户端未能枚举系统字体')
  }
  if (!Array.isArray(data.fonts)) {
    throw new PrintClientError('parse', '响应缺少 fonts 数组')
  }
  return data.fonts.map((f) => normalizeSystemFont(f ?? {}))
}

/** 字体条目字段归一化（缺字段给安全默认） */
function normalizeSystemFont(raw: Partial<SystemFontEntry>): SystemFontEntry {
  const format: SystemFontEntry['format'] =
    raw.format === 'otf' || raw.format === 'woff' || raw.format === 'woff2' ? raw.format : 'ttf'
  return {
    family: typeof raw.family === 'string' ? raw.family : '',
    format,
    path: typeof raw.path === 'string' ? raw.path : '',
    size: typeof raw.size === 'number' ? raw.size : 0,
  }
}

/**
 * 构造按需加载某个字体字节的完整 URL（GET /api/fonts/data?path=…）。
 * path 编码后作为 query；浏览器直接以这个 URL 作为 @font-face src / FontFace url。
 */
export function systemFontDataUrl(
  entry: Pick<SystemFontEntry, 'path'>,
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
): string {
  return `${joinUrl(baseUrl, '/api/fonts/data')}?path=${encodeURIComponent(entry.path)}`
}

/* ------------------------------ /api/data/*（数据库） ------------------------------ */

/** 数据库相关请求的可选参数（与客户端路由的可选 query 对应） */
export interface ClientDataQuery {
  /** 已保存连接 ID，覆盖活动连接 */
  connId?: string
  /** sqlite | postgres | odbc（内联配置时填） */
  engine?: DbEngine
  /** 库名（缺省取客户端当前选中库） */
  database?: string
  /** 表名（缺省取客户端当前选中表） */
  table?: string
  /** 字段名逗号分隔，如 id,name（仅 rows） */
  fields?: string
  /** 返回行数（仅 rows；默认 100，上限 1000） */
  limit?: number
}

/** POST /api/data/rows 的请求体（支持 where 参数化筛选，避免 GET 拼接 SQL） */
export interface ClientRowsPostBody extends ClientDataQuery {
  /** WHERE 子句（不含 WHERE 关键字，占位符用 ?） */
  where?: string
  /** 与 where 占位符对应的参数（按序） */
  params?: unknown[]
}

/** 取数默认/上限行数 */
export const ROWS_DEFAULT_LIMIT = 100
export const ROWS_MAX_LIMIT = 1000

/** 拼装数据库路由的可选 query 串（无参数返回空串） */
function buildDataQuery(q?: ClientDataQuery): string {
  if (!q) return ''
  const p = new URLSearchParams()
  if (q.connId) p.set('connId', q.connId)
  if (q.engine) p.set('engine', q.engine)
  if (q.database) p.set('database', q.database)
  if (q.table) p.set('table', q.table)
  if (q.fields) p.set('fields', q.fields)
  if (typeof q.limit === 'number') {
    const clamped = Math.max(1, Math.min(ROWS_MAX_LIMIT, Math.floor(q.limit)))
    p.set('limit', String(clamped))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/**
 * 库条目归一化：兼容两种返回形态——
 * - 纯字符串：`databases: ["byb"]`（客户端常见形态，与 tables 同构）
 * - 对象：`databases: [{ name: "byb", engine: "sqlite" }]`
 * 注意：若后端按字符串返回而此处只读 raw.name，会得到空串 → 下拉选项 label 全空。
 * engine 经 normalizeDbEngine 归一（sqlite / postgres / odbc），别把 postgres 降级成 sqlite。
 */
function normalizeClientDatabase(raw: string | Partial<ClientDatabase>): ClientDatabase {
  if (typeof raw === 'string') {
    return { name: raw, engine: 'sqlite', label: undefined }
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    engine: normalizeDbEngine(raw.engine),
    label: typeof raw.label === 'string' ? raw.label : undefined,
  }
}

/**
 * 表条目归一化：兼容两种返回形态——
 * - 纯字符串：`tables: ["user"]`（客户端常见形态）
 * - 对象：`tables: [{ name: "user", type: "table" }]`
 */
function normalizeClientTable(raw: string | Partial<ClientTable>): ClientTable {
  if (typeof raw === 'string') {
    return { name: raw, type: undefined }
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type: typeof raw.type === 'string' ? raw.type : undefined,
  }
}

function normalizeClientColumn(raw: Partial<ClientColumn>): ClientColumn {
  // 后端主键标记是 key:"PRI"（部分实现也直接给 primary:true），两者都认
  const key = typeof raw.key === 'string' ? raw.key : ''
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type: typeof raw.type === 'string' ? raw.type : 'TEXT',
    nullable: raw.nullable !== false,
    primary: raw.primary === true || key === 'PRI',
    key: key || undefined,
    default: typeof raw.default === 'string' ? raw.default : undefined,
  }
}

/** 列库（GET /api/data/databases） */
export async function listClientDatabases(
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  q?: ClientDataQuery,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ClientDatabase[]> {
  const data = await request<Partial<ClientDataListResponse>>(
    joinUrl(baseUrl, `/api/data/databases${buildDataQuery(q)}`),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
  )
  if (data.ok === false) throw new PrintClientError('service', data.message || '列库失败')
  if (!Array.isArray(data.databases)) throw new PrintClientError('parse', '响应缺少 databases 数组')
  return data.databases.map((d) => normalizeClientDatabase(d ?? {}))
}

/** 列表（GET /api/data/tables） */
export async function listClientTables(
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  q?: ClientDataQuery,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ClientTable[]> {
  const data = await request<Partial<ClientDataListResponse>>(
    joinUrl(baseUrl, `/api/data/tables${buildDataQuery(q)}`),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
  )
  if (data.ok === false) throw new PrintClientError('service', data.message || '列表失败')
  if (!Array.isArray(data.tables)) throw new PrintClientError('parse', '响应缺少 tables 数组')
  return data.tables.map((t) => normalizeClientTable(t ?? {}))
}

/** 列字段（GET /api/data/columns） */
export async function listClientColumns(
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  q?: ClientDataQuery,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ClientColumn[]> {
  const data = await request<Partial<ClientDataListResponse>>(
    joinUrl(baseUrl, `/api/data/columns${buildDataQuery(q)}`),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
  )
  if (data.ok === false) throw new PrintClientError('service', data.message || '列字段失败')
  if (!Array.isArray(data.columns)) throw new PrintClientError('parse', '响应缺少 columns 数组')
  return data.columns.map((c) => normalizeClientColumn(c ?? {}))
}

/** 取数（GET /api/data/rows）。limit 缺省补 ROWS_DEFAULT_LIMIT 并钳制上限，确保行为明确。 */
export async function fetchClientRows(
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  q?: ClientDataQuery,
  timeoutMs: number = SUBMIT_TIMEOUT_MS,
): Promise<ClientRowsResponse> {
  const merged: ClientDataQuery = { limit: ROWS_DEFAULT_LIMIT, ...(q ?? {}) }
  const data = await request<Partial<ClientRowsResponse>>(
    joinUrl(baseUrl, `/api/data/rows${buildDataQuery(merged)}`),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
  )
  if (data.ok === false) throw new PrintClientError('service', data.message || '取数失败')
  if (!Array.isArray(data.rows)) throw new PrintClientError('parse', '响应缺少 rows 数组')
  return {
    ok: true,
    database: data.database,
    table: data.table,
    total: typeof data.total === 'number' ? data.total : data.rows.length,
    rows: data.rows,
    columns: Array.isArray(data.columns) ? data.columns : undefined,
  }
}

/** 取数（POST /api/data/rows，支持 where/参数化筛选）。limit 同上默认处理。 */
export async function postClientRows(
  body: ClientRowsPostBody,
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  timeoutMs: number = SUBMIT_TIMEOUT_MS,
): Promise<ClientRowsResponse> {
  const merged: ClientDataQuery = { limit: ROWS_DEFAULT_LIMIT, ...body }
  const data = await request<Partial<ClientRowsResponse>>(
    joinUrl(baseUrl, '/api/data/rows'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(merged),
    },
    timeoutMs,
  )
  if (data.ok === false) throw new PrintClientError('service', data.message || '取数失败')
  if (!Array.isArray(data.rows)) throw new PrintClientError('parse', '响应缺少 rows 数组')
  return {
    ok: true,
    database: data.database,
    table: data.table,
    total: typeof data.total === 'number' ? data.total : data.rows.length,
    rows: data.rows,
    columns: Array.isArray(data.columns) ? data.columns : undefined,
  }
}

/* ------------------------------ 任务号生成 ------------------------------ */

/**
 * 生成打印任务号（Web 端生成，随请求下发给本地客户端）。
 * 格式：`MMDD`（今日月日，如 0813）+ 6 位随机数字，共 10 位。
 * 例：`0813` + `482913` → `0813482913`。
 * @param now 可选，默认当前时间（便于单测注入）
 */
export function generateJobId(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `${mm}${dd}${rand}`
}

/* ------------------------------ POST /print ------------------------------ */

/**
 * 提交打印任务。
 * 载荷约定（见《打印机数据交互文档》）：
 * - `format:'pdf'` + `encoding:'base64'`：位图 PDF（content 为 base64，无 data: 前缀），
 *   底图默认 PNG 无损，客户端 `QPrinter` 直打（默认，向后兼容）。
 * - `format:'html'` + `encoding:'utf8'`：自包含 HTML 原文（字体 data-URI 内联、零网络引用），
 *   客户端 Qt WebEngine `loadHtml()` → `printToPdf()` 矢量输出（推荐）。
 * - `'svg'` 已废弃（Qt QSvgRenderer 不支持 foreignObject/HTML/CSS），类型保留仅作向后兼容。
 * - `job.jobId` 缺省由本函数自动生成；服务端若回传自己的 jobId 则以服务端为准。
 */
export async function submitPrintJob(
  job: PrintJobRequest,
  baseUrl: string = DEFAULT_PRINTER_BASE_URL,
  timeoutMs: number = SUBMIT_TIMEOUT_MS,
  onProgress?: (pct: number) => void,
): Promise<PrintJobResponse> {
  // 任务号缺省自动生成（MMDD + 6 位随机）；服务端若回传自己的 jobId 则以服务端为准。
  // 调用方一般不必再手动 generateJobId —— 仅在想自定义编号规则时传 job.jobId。
  const finalJob: PrintJobRequest = job.jobId ? job : { ...job, jobId: generateJobId() }
  onProgress?.(90)
  const data = await request<Partial<PrintJobResponse>>(
    joinUrl(baseUrl, '/print'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(finalJob),
    },
    timeoutMs,
  )
  if (data.ok !== true) {
    onProgress?.(100)
    throw new PrintClientError('service', data.message || '打印客户端拒绝了本次任务')
  }
  onProgress?.(100)
  return { ok: true, jobId: data.jobId ?? finalJob.jobId, message: data.message }
}

/* ------------------------------ 工具 ------------------------------ */

/**
 * Blob → base64（不含 `data:*;base64,` 前缀）。
 * 用于把 PDF 二进制转成可 JSON 传输的字符串。
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取导出文件失败'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(blob)
  })
}

/** Blob → utf8 文本（用于 SVG 载荷） */
export function blobToText(blob: Blob): Promise<string> {
  return blob.text()
}
