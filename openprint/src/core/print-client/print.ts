/**
 * 打印一站式入口 —— `printDocument()`
 *
 * 把「探测打印机 → 解析 DPI（清晰度预设 / 打印机自适应）→ 构建 PDF 载荷 →
 * 自动任务号 → 推送」串成一步，调用方只需：
 *
 * ```ts
 * import { printDocument } from 'openprint26/sdk'
 *
 * await printDocument({ template, data }, {
 *   baseUrl: 'http://192.168.1.50:18888',  // 局域网打印机；缺省本机 127.0.0.1:18888
 *   printer: 'TM-T20',                     // 缺省用客户端默认打印机
 *   quality: 'high',                       // 低/中/高；不传=打印机自适应(defaultDpi)
 *   mode: 'html',                          // pdf=位图PDF（默认）/ html=矢量HTML（推荐）
 *   copies: 2,
 * })
 * ```
 *
 * 设计器里的「静默打印」按钮、以及任何前端框架的打印接入，都走这一个函数。
 * 比分别调 `buildPrintPayload` + 拼 `PrintJobRequest` + `submitPrintJob` 省心，
 * 也天然满足用户三条诉求：任务号自动生成、清晰度语义化、地址可配（含局域网）。
 */
import type { RenderRequest } from '@/core/sdk'
import { buildPrintPayload, type PrintPayloadMode } from './payload'
import { listPrinters, submitPrintJob, generateJobId, DEFAULT_PRINTER_BASE_URL } from './client'
import { resolvePrintDpi, FALLBACK_PRINT_DPI } from './dpi'
import { QUALITY_DPI, type PrintQuality } from '@/core/quality'
import type { FontFaceDef } from '@/core/export-engine/fonts'
import type { PrintJobRequest, PrintJobResponse, PrinterInfo } from './types'

export type { PrintQuality } from '@/core/quality'

export interface PrintDocumentOptions {
  /**
   * 打印客户端地址。缺省 `http://127.0.0.1:18888`（本机）；
   * 局域网打印填如 `http://192.168.1.50:18888`。每个前端框架都一样传。
   */
  baseUrl?: string
  /** 目标打印机名（取自 /printers 的 name）；缺省用客户端默认打印机 */
  printer?: string
  /**
   * 清晰度预设：`low`=96dpi / `medium`=192dpi / `high`=288dpi。
   * **不传则默认「打印机自适应」**——读目标打印机的 `defaultDpi`（受 maxDpi 钳制）。
   * 显式 `dpi` 优先级最高。
   */
  quality?: PrintQuality
  /** 手动指定渲染 DPI（覆盖 quality 与打印机自适应；html 模式仅作客户端打印分辨率参考） */
  dpi?: number
  /**
   * 载荷模式（默认 `'pdf'` 向后兼容）：
   * - `'pdf'`：位图 PDF（base64），客户端 QPrinter 直打；
   * - `'html'`：自包含 HTML（utf8），客户端 Qt WebEngine `loadHtml()` → `printToPdf()`
   *   矢量输出（推荐：含文本层、体积小、清晰度与 DPI 无关）；
   * - `'esc' | 'tsc' | 'zpl'`：画布原始 JSON（utf8），**Web 端零渲染**，客户端解析后
   *   自行翻译为 ESC/POS、TSPL(TSC) 或 ZPL 指令（票据 / 标签机）。
   */
  mode?: PrintPayloadMode
  /** 字体内联清单（仅 html 模式；显式传入时优先于 embedFonts 开关） */
  fonts?: FontFaceDef[]
  /**
   * 是否内联文本字体（仅 html 模式，**默认 `false`——体积最小化**）。`false` = 不内联（~17KB/页），
   * 客户端按 CSS 兜底链回退系统字体（思源黑体→微软雅黑、宋体类→宋体，CJK 单据版式两端基本一致）；
   * 特殊字体（手写体等）需两端一致时传 `true`。KaTeX 公式字体始终强制内联。
   */
  embedFonts?: boolean
  /** 打印份数，默认 1 */
  copies?: number
  /** 双面，默认 false */
  duplex?: boolean
  /** 彩色，默认 true（false=黑白） */
  color?: boolean
  /** 纸张方向，默认 portrait */
  orientation?: 'portrait' | 'landscape'
  /** PDF 位图底图格式，默认 'png'（无损最清晰） */
  imageType?: 'jpeg' | 'png'
  /** 任务名（打印队列显示），缺省取模板名或「OpenPrint 打印任务」 */
  taskName?: string
  /** 自定义任务号；不传由内部自动生成（MMDD + 6 位随机） */
  jobId?: string
  /** 进度回调（0–100）：含渲染+PDF 生成+推送阶段 */
  onProgress?: (pct: number) => void
}

/**
 * 一站式打印：渲染 → 栅格化 PDF → 推送到本地/局域网打印客户端。
 *
 * 返回客户端队列任务号（服务端回传优先，否则内部生成的 jobId）。
 */
export async function printDocument(
  request: RenderRequest,
  options: PrintDocumentOptions = {},
): Promise<PrintJobResponse> {
  const baseUrl = options.baseUrl ?? DEFAULT_PRINTER_BASE_URL
  const onProgress = options.onProgress

  // 1. 探测打印机（用于自适应 DPI + 默认打印机名）。客户端不可达时静默降级为无打印机信息。
  let printerInfo: PrinterInfo | null = null
  try {
    const printers = await listPrinters(baseUrl)
    printerInfo =
      printers.find((p) => p.name === options.printer) ??
      printers.find((p) => p.isDefault) ??
      printers[0] ??
      null
  } catch {
    printerInfo = null
  }

  // 2. 解析 DPI：手动 > 清晰度预设 > 打印机 defaultDpi > 回退
  const targetDpi =
    options.dpi ??
    (options.quality ? QUALITY_DPI[options.quality] : undefined) ??
    resolvePrintDpi(undefined, printerInfo ?? undefined) ??
    FALLBACK_PRINT_DPI

  // 3. 构建载荷（pdf=位图 PDF base64 / html=自包含 HTML utf8 / esc|tsc|zpl=画布原始 JSON，见 payload.ts）
  const payload = await buildPrintPayload(request, {
    mode: options.mode,
    dpi: targetDpi,
    quality: options.quality,
    imageType: options.imageType ?? 'png',
    fonts: options.fonts,
    embedFonts: options.embedFonts,
    onProgress,
  })

  // 4. 组装任务（jobId 自动生成，除非显式指定）
  const job: PrintJobRequest = {
    jobId: options.jobId ?? generateJobId(),
    taskName: options.taskName ?? (request.template as { name?: string } | undefined)?.name ?? 'OpenPrint 打印任务',
    printer: options.printer ?? printerInfo?.name ?? '',
    format: payload.format,
    encoding: payload.encoding,
    content: payload.content,
    pages: payload.pages,
    width: payload.width,
    height: payload.height,
    unit: 'mm',
    copies: options.copies ?? 1,
    orientation: options.orientation ?? 'portrait',
    duplex: options.duplex ?? false,
    color: options.color ?? true,
    dpi: targetDpi,
  }

  // 5. 推送
  return submitPrintJob(job, baseUrl)
}
