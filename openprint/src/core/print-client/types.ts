/**
 * 本地打印机客户端服务 —— 协议类型
 *
 * 对接本机常驻的打印客户端（默认 http://127.0.0.1:18888），提供：
 *   GET  /health     服务健康与版本
 *   GET  /printers   打印机列表
 *   POST /print      提交打印任务（单页 SVG / 多页 PDF-base64）
 *   GET  /api/fonts       枚举本机/局域网电脑系统字体
 *   GET  /api/fonts/data  拉取字体字节（精确 Content-Type）
 *
 * 主任铁律：无后端全链路可用 —— 客户端不可达时设计器一切功能照常，只是不能推送打印、不能使用电脑系统字体。
 */

/* ------------------------------ /health ------------------------------ */

/** GET /health 响应体 */
export interface PrinterHealth {
  /** 客户端应用名，如 "OpenPrint" */
  app: string
  /** 服务是否正常 */
  ok: boolean
  /** 当前可用打印机数量 */
  printers: number
  /** 服务端时间（ISO 字符串） */
  time: string
  /** 已运行秒数 */
  uptimeSec: number
  /** 客户端版本号 */
  version: string
  /**
   * 服务端实际使用的报表目录（绝对路径，可选）。
   *
   * 它由**配置路径**推出，而配置路径默认是相对路径，所以「从哪个目录启动客户端」
   * 会悄悄改变它 —— 从别的目录启动时报表列表会是空的且没有任何报错。
   * 老版本客户端不回这个字段。
   */
  reportsDir?: string
}

/* ------------------------------ /printers ------------------------------ */

/** 打印机类型：虚拟打印机 / 普通打印机 / 票据打印机 */
export type PrinterKind = 'virtual' | 'common' | 'ticket'

/** 打印机运行状态 */
export type PrinterState = 'idle' | 'error'

/** 单台打印机描述 */
export interface PrinterInfo {
  /** 驱动名 */
  driver: string
  /** 默认分辨率（DPI）—— 打印弹窗分辨率字段的缺省值 */
  defaultDpi: number
  /** 是否系统默认打印机 */
  isDefault: boolean
  /** 是否在线 */
  isOnline: boolean
  /** 打印机类型 */
  kind: PrinterKind
  /** 最大分辨率（DPI），0 = 未知/无上限 */
  maxDpi: number
  /** 打印机名（提交任务时的唯一标识） */
  name: string
  /** 运行状态 */
  status: PrinterState
  /** 是否支持彩色 */
  supportsColor: boolean
  /** 是否支持双面 */
  supportsDuplex: boolean
  /** 纸盒列表 */
  trays: string[]
}

/** GET /printers 响应体 */
export interface PrinterListResponse {
  /** 服务端声明的数量（可能与 printers.length 不一致，以数组为准） */
  count: number
  ok: boolean
  printers: PrinterInfo[]
}

/* ------------------------------ /print ------------------------------ */

/**
 * 推送载荷格式：
 * - `'pdf'`：位图 PDF（base64），客户端 `QPrinter` 直打（默认，向后兼容）。
 * - `'html'`（2026-08-30 新增，推荐）：自包含 HTML 原文（utf8），客户端 Qt WebEngine
 *   `loadHtml()` → `printToPdf()` 矢量输出 —— 含文本层、体积小、清晰度与 DPI 无关。
 * - `'esc' | 'tsc' | 'zpl'`（2026-09-01 新增）：画布原始 JSON（utf8）—— Web 端不渲染，
 *   客户端解析该 JSON 自行翻译为 ESC/POS、TSC(TSPL) 或 ZPL 指令（票据/标签机）。
 * - `'svg'` 保留在枚举里仅供向后兼容（已废弃：Qt QSvgRenderer 不解析 foreignObject/HTML）。
 *   注意：`'html'` 不受该限制 —— QWebEngine 是完整 Chromium，原生解析 HTML/CSS。
 */
export type PrintPayloadFormat = 'svg' | 'pdf' | 'html' | 'esc' | 'tsc' | 'zpl'

/** 载荷编码：pdf 用 base64；html/esc/tsc/zpl 用 utf8（HTML 原文 / 画布 JSON，可直接文本处理） */
export type PrintPayloadEncoding = 'utf8' | 'base64'

/** POST /print 请求体 */
export interface PrintJobRequest {
  /** 任务号：由 Web 端生成（MMDD + 6 位随机，共 10 位）；服务端若回传则以其为准，否则沿用此值 */
  jobId?: string
  /** 任务名（用于打印队列显示） */
  taskName: string
  /** 目标打印机名（取自 /printers 的 name；留空由客户端用系统默认） */
  printer: string
  /** 载荷格式 */
  format: PrintPayloadFormat
  /** 载荷编码 */
  encoding: PrintPayloadEncoding
  /** 文档内容：pdf=PDF base64（不含 data: 前缀）；html=自包含 HTML 原文（utf8）；esc/tsc/zpl=画布原始 JSON（模板+数据，utf8）；svg=XML 原文（已废弃） */
  content: string
  /** 文档总页数 */
  pages: number
  /**
   * 页面物理宽（mm）—— 由模板 pageSetup 透传（与生成 PDF 用的 `format:[w,h]` 同一组数）。
   * 客户端据此设置纸张尺寸，避免依赖解析 PDF MediaBox / 打印机默认 A4 导致纸张不符、内容错位打不准。
   */
  width: number
  /** 页面物理高（mm） */
  height: number
  /** 尺寸单位，恒为 'mm'（与内部统一单位一致） */
  unit?: 'mm'
  /** 打印份数 */
  copies: number
  /** 纸张方向 */
  orientation: 'portrait' | 'landscape'
  /** 是否双面 */
  duplex: boolean
  /** 是否彩色（false = 黑白） */
  color: boolean
  /**
   * 渲染分辨率（DPI）：Web 端按此 DPI 栅格化 PDF（scale = dpi / 96），
   * 客户端可据此设置打印分辨率。缺省由 Web 端取打印机 defaultDpi。
   */
  dpi?: number
}

/** POST /print 响应体 */
export interface PrintJobResponse {
  ok: boolean
  /** 客户端队列任务 ID */
  jobId?: string
  /** 服务端消息（失败原因等） */
  message?: string
}

/* ------------------------------ /api/fonts ------------------------------ */

/** 单个电脑系统字体描述（来自 GET /api/fonts） */
export interface SystemFontEntry {
  /** 字体族名（直接作为 CSS font-family 用；面板展示也用它） */
  family: string
  /** 字体格式：ttf / otf / woff / woff2 */
  format: 'ttf' | 'otf' | 'woff' | 'woff2'
  /** 客户端机器上的绝对路径（作为 GET /api/fonts/data?path= 的参数） */
  path: string
  /** 字体文件大小（字节，仅用于 UI 提示） */
  size: number
}

/** GET /api/fonts 响应体 */
export interface SystemFontListResponse {
  ok: boolean
  /** 字体总数 */
  count: number
  fonts: SystemFontEntry[]
}

/* ------------------------------ /api/data/*（数据库） ------------------------------ */

/** 连接引擎类型 */
export type DbEngine = 'sqlite' | 'postgres' | 'odbc'

/** 引擎归一化：未知/缺失按 sqlite（与客户端行为一致），并兼容 postgres 的别名写法 */
export function normalizeDbEngine(raw: unknown): DbEngine {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (s === 'odbc') return 'odbc'
  if (s === 'postgres' || s === 'postgresql' || s === 'pgsql' || s === 'pg') return 'postgres'
  return 'sqlite'
}

/** 单个数据库描述（GET /api/data/databases） */
export interface ClientDatabase {
  /** 库标识（sqlite 可为文件路径，odbc 可为 DSN 名） */
  name: string
  /** 连接类型 */
  engine?: DbEngine
  /** 备注/可读名（可选） */
  label?: string
}

/** 单张表描述（GET /api/data/tables） */
export interface ClientTable {
  /** 表名 */
  name: string
  /** 类型（表 / 视图等） */
  type?: string
}

/** 单字段元信息（GET /api/data/columns） */
export interface ClientColumn {
  /** 字段名 */
  name: string
  /** 字段类型（如 INTEGER / TEXT / VARCHAR(64)） */
  type: string
  /** 是否可空 */
  nullable?: boolean
  /** 是否主键（后端用 key:"PRI" 表达时由 normalize 推导） */
  primary?: boolean
  /** 键标记原文（后端返回：PRI=主键 / UNI=唯一键 / MUL=多值索引 / ""=无） */
  key?: string
  /** 默认值（可选） */
  default?: string
}

/** /api/data/* 列表类（databases / tables / columns）通用响应包装 */
export interface ClientDataListResponse {
  ok: boolean
  databases?: ClientDatabase[]
  tables?: ClientTable[]
  columns?: ClientColumn[]
  /** 服务端消息（失败原因等） */
  message?: string
}

/** GET /api/data/rows 取数响应体 */
export interface ClientRowsResponse {
  ok: boolean
  /** 当前库（回显，便于校验） */
  database?: string
  /** 当前表（回显） */
  table?: string
  /** 命中总行数（可能大于返回行数） */
  total?: number
  /** 返回的行（上限 limit） */
  rows: Array<Record<string, unknown>>
  /** 行字段顺序（可选，前端可忽略，直接按 object keys） */
  columns?: string[]
  /** 服务端消息（失败原因等） */
  message?: string
}

/* ------------------------------ 错误 ------------------------------ */

/**
 * 错误分类：
 * - `timeout`  请求超时（客户端未响应）
 * - `network`  连接失败（服务未启动 / 端口不通 / CORS 拦截）
 * - `http`     HTTP 非 2xx
 * - `parse`    响应不是合法 JSON 或字段缺失
 * - `service`  服务端返回 ok:false
 */
export type PrintClientErrorCode = 'timeout' | 'network' | 'http' | 'parse' | 'service'

/** 打印客户端统一错误 */
export class PrintClientError extends Error {
  readonly code: PrintClientErrorCode
  readonly status?: number

  constructor(code: PrintClientErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'PrintClientError'
    this.code = code
    this.status = status
  }
}

/** 把任意异常转成人话（用于 UI 提示） */
export function describePrintError(err: unknown): string {
  if (err instanceof PrintClientError) {
    switch (err.code) {
      case 'timeout':
        return '打印客户端响应超时，请确认服务未卡死'
      case 'network':
        return '无法连接打印客户端，请确认本机打印服务已启动'
      case 'http':
        return `打印客户端返回错误（HTTP ${err.status ?? '?'}）`
      case 'parse':
        return '打印客户端返回数据格式异常'
      case 'service':
        return err.message || '打印客户端拒绝了本次请求'
    }
  }
  return err instanceof Error ? err.message : String(err)
}
