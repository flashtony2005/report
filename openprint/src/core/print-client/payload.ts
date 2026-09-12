/**
 * 打印载荷构建 —— 模板 + 数据 → 推送给本地打印客户端的文档内容
 *
 * 推送格式（2026-09-01 起四种模式）：
 * - `mode:'pdf'`（默认，向后兼容）：浏览器内把每页栅格化成位图底图 → 位图 PDF（base64）。
 *   客户端 `QPrinter` 直打。体积大（PNG 无损 ~10MB/页）、非矢量。
 * - `mode:'html'`（推荐，矢量路径）：Web 端只渲染出自包含 HTML（零网络引用），客户端用
 *   **Qt WebEngine `loadHtml()` → `printToPdf()`** 输出真矢量 PDF（含文本层）再走原 QPrinter 流程。
 *   字体默认**不内联**——客户端按 CSS 兜底链回退系统字体（思源黑体→微软雅黑等），体积仅 ~17KB/页；
 *   需字体一致时设 `embedFonts:true`（或显式 `fonts`）。KaTeX 公式字体始终强制内联。清晰度与 DPI 无关。
 * - `mode:'esc' | 'tsc' | 'zpl'`（2026-09-01 新增，指令直通）：Web 端**不做任何渲染**，
 *   直接把画布 JSON 平铺（`{ version, document, data }`，utf8——**不包 `template` 层**，与画布保存的
 *   模板结构一致，仅追加数据）推给客户端，由客户端解析并翻译为 ESC/POS、TSC(TSPL) 或 ZPL 指令。
 *   **载荷已净化**（见 raw-sanitize.ts）：删除字体样式（打印机内置中文字库）、颜色（单色打印）、
 *   设计器元数据与渲染装饰，只留几何 / 内容 / 数据绑定 / 字号 / 对齐 / 条码规格。
 *   适用于票据 / 标签打印机（TM 系列、TSC、Zebra 等）。
 *
 * 演进历程：
 * - 早期单页走 SVG 原文 → Qt `QSvgRenderer` 不解析 foreignObject/HTML/CSS，打不出内容（已废弃）。
 *   **HTML 模式不受此限制**：QWebEngine 是完整 Chromium，原生解析 HTML/CSS。
 * - 中间试过单页走 JPG → 单张位图无页面尺寸/DPI 元数据，弃。
 * - 2026-08-13 统一 PDF-base64；2026-08-30 增加 HTML 矢量模式（QWebEngine 渲染）。
 *
 * DPI 感知（PDF 模式）：传 `dpi`（打印机 defaultDpi / maxDpi 决策，见 ./dpi.ts）
 * 即按目标打印机实际分辨率栅格化（scale = dpi / 96）；超高 DPI 会被 canvas 面积护栏
 * 自动下调。HTML 模式无需 DPI——WebEngine 按矢量输出，`dpi` 仅作为客户端打印分辨率参考。
 */
import type { RenderRequest } from '@/core/sdk'
import { renderDocument } from '@/core/sdk'
import { documentToPdf } from '@/core/export-engine'
import { embedFontsInHtml, type FontFaceDef } from '@/core/export-engine/fonts'
import { renderHtml } from '@/core/renderer-html'
import { templateUsedFonts, toExportFontDefs } from '@/core/fonts/loader'
import { KATEX_FONT_DEFS } from '@/core/mathkit/katex-css'
import { blobToBase64 } from './client'
import { buildRawPayloadObject } from './raw-sanitize'
import { QUALITY_DPI, type PrintQuality } from '@/core/quality'
import { toMm } from '@/core/units'
import type { PrintPayloadEncoding, PrintPayloadFormat } from './types'

export type PrintPayloadMode = 'pdf' | 'html' | 'esc' | 'tsc' | 'zpl'

/** 指令直通模式（Web 端不渲染，原样透传画布 JSON 由客户端翻译） */
export const RAW_PAYLOAD_MODES: readonly PrintPayloadMode[] = ['esc', 'tsc', 'zpl'] as const

/** 指令直通模式的人类可读名（UI 展示用） */
export const RAW_PAYLOAD_MODE_LABELS: Record<string, string> = {
  esc: 'ESC/POS',
  tsc: 'TSC(TSPL)',
  zpl: 'ZPL',
}

export function isRawPayloadMode(mode?: PrintPayloadMode | null): mode is 'esc' | 'tsc' | 'zpl' {
  return mode !== undefined && mode !== null && (RAW_PAYLOAD_MODES as readonly string[]).includes(mode)
}

export interface PrintPayload {
  /** 载荷格式：`pdf`=位图 PDF（base64）；`html`=自包含 HTML（utf8）；`esc/tsc/zpl`=画布原始 JSON（utf8） */
  format: PrintPayloadFormat
  /** 载荷编码：pdf 用 base64；html/esc/tsc/zpl 用 utf8 */
  encoding: PrintPayloadEncoding
  /** pdf=PDF 的 base64（不含 data: 前缀）；html=完整 HTML 文档字符串；esc/tsc/zpl=画布原始 JSON 字符串 */
  content: string
  /** 总页数 */
  pages: number
  /** 页面物理宽（mm），与 PDF 页面一致，供客户端设置纸张尺寸 */
  width: number
  /** 页面物理高（mm） */
  height: number
  /** 载荷字节数（UI 展示体积用） */
  bytes: number
}

export interface BuildPrintPayloadOptions {
  /**
   * 载荷模式（默认 `'pdf'` 向后兼容）：
   * - `'pdf'`：位图 PDF（base64），客户端 QPrinter 直打；
   * - `'html'`：自包含 HTML（utf8），客户端 Qt WebEngine `printToPdf` 矢量输出（推荐）；
   * - `'esc' | 'tsc' | 'zpl'`：画布 JSON（utf8，`{ version, document, data }` 平铺、不含
   *   `template` 包裹层，**经 raw-sanitize 净化**——剔除字体样式/颜色/设计器元数据），
   *   **Web 端零渲染**，客户端自行翻译为 ESC/POS、TSPL(TSC) 或 ZPL 指令（票据 / 标签机）。
   */
  mode?: PrintPayloadMode
  /**
   * 渲染分辨率（DPI，仅 pdf 模式栅格化用）：按目标打印机实际分辨率栅格化 PDF
   * （scale = dpi / 96），客户端不再二次重采样。通常取打印机 `defaultDpi`（需 ≤ `maxDpi`）。
   * 与 `scale` / `quality` 同时给出时 **dpi 优先**；三者都缺省回退 scale 3（288dpi）。
   * html 模式忽略（矢量输出无栅格化概念，仅随载荷下发供客户端设置打印分辨率）。
   */
  dpi?: number
  /**
   * 清晰度预设（语义化，推荐）：`low`=96dpi / `medium`=192dpi / `high`=288dpi。
   * 比裸 `scale` 更直观；被 `dpi` 覆盖，覆盖 `scale`。
   */
  quality?: PrintQuality
  /** 位图倍率，默认 3（288dpi·最高清）；被 dpi / quality 覆盖 */
  scale?: number
  /**
   * 多页 PDF 的位图底图压缩格式（仅 pdf 模式，默认 `'png'` 无损最清晰）：
   * - `'png'`：无损，文字/线条边缘锐利，打印推荐；
   * - `'jpeg'`：体积小，仅体积敏感场景。
   */
  imageType?: 'jpeg' | 'png'
  /**
   * 字体内联清单（仅 html 模式生效）。显式传入时优先于 `embedFonts` 开关。
   * 缺省 = 模板文本控件实际用到的内置字体（`templateUsedFonts`，避免全量内联）
   * + KaTeX 字体（模板含公式时自动追加）。字体会转成 data-URI `@font-face` 内联进 HTML。
   */
  fonts?: FontFaceDef[]
  /**
   * 是否内联文本字体（仅 html 模式，**默认 `false`——体积最小化**）。
   * `false`（默认）= 不内联：客户端 QWebEngine 按 CSS 兜底链回退系统字体
   *   （思源黑体→微软雅黑、宋体类→宋体），CJK 单据版式两端基本一致；
   *   载荷从 ~700KB 降到 ~17KB/页。
   * `true` = 内联模板实际用到的内置字体（避免全量内联）；模板使用手写体/特殊字体
   *   （如寒蝉正楷体）且要求两端一致时再开，或显式传 `fonts`。
   * **KaTeX 公式字体不受此开关影响，始终强制内联**——数学字形没有任何系统字体能兜底。
   */
  embedFonts?: boolean
  /**
   * 进度回调（0–100）。渲染+产物生成阶段会逐步推进：
   * 5（开始）→ 30（渲染完成）→ 30~80（pdf 逐页栅格化 / html 字体内联）→ 85（编码完成）。
   * 推送阶段由 `submitPrintJob` 的回调继续推进。
   */
  onProgress?: (pct: number) => void
}

/** html 模式缺省字体清单：模板实际用到的内置字体 + 含公式时追加 KaTeX 字体 */
function defaultHtmlPrintFonts(request: RenderRequest, html: string): FontFaceDef[] {
  const defs = toExportFontDefs(templateUsedFonts(request.template))
  const hasKatex = html.includes('katex')
  if (!hasKatex) return defs
  const seen = new Set(defs.map((d) => `${d.family}|${d.src}`))
  return [...defs, ...KATEX_FONT_DEFS.filter((d) => !seen.has(`${d.family}|${d.src}`))]
}

/** 字符串字节数（utf-8；体积展示与推送计费口径一致） */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * 构建推送载荷。
 *
 * - `mode:'pdf'`（默认）：`renderDocument()` → `documentToPdf()`（浏览器内栅格化成
 *   位图底图，默认 PNG 无损）→ `blobToBase64()`。客户端拿到可直接 `QPrinter` 打印的 PDF 字节流。
 * - `mode:'html'`：`renderDocument()` → `renderHtml({ screen:false })`（打印态 CSS：无缩放、
 *   无阴影、单页平铺）→ `embedFontsInHtml()`（字体 data-URI 内联，缺省按模板实际用到的字体）。
 *   客户端 `QWebEnginePage::loadHtml()` → `printToPdf()` 得到矢量 PDF。
 * - `mode:'esc' | 'tsc' | 'zpl'`：**跳过渲染**，`content = JSON.stringify(buildRawPayloadObject(request))`——
 *   画布 JSON 平铺 + 数据（`{ version, document, data }`，**不包 `template` 层**），经白名单净化
 *   （字体样式 / 颜色 / 设计器元数据已剔除，见 raw-sanitize.ts），客户端解析后自行翻译为对应指令。
 *   宽度/高度取模板 pageSetup（mm）。
 *
 * 不论哪种模式，载荷都带 `pages/width/height`（mm），客户端据此设置纸张尺寸。
 */
export async function buildPrintPayload(
  request: RenderRequest,
  options: BuildPrintPayloadOptions = {},
): Promise<PrintPayload> {
  const onProgress = options.onProgress
  onProgress?.(5)

  // 指令直通（esc / tsc / zpl）：Web 端零渲染，只传画布 JSON（净化版），由客户端翻译为对应指令。
  // content = 画布模板本体平铺 + 数据（{ version, document, data }）——**不含 `template` 包裹层**，
  // 与画布保存的模板 JSON 结构一致；并经 raw-sanitize 白名单净化：删除字体样式（打印机内置
  // 中文字库）、颜色（单色打印）、设计器元数据与渲染装饰，只留几何/内容/绑定/字号/对齐/条码规格。
  if (isRawPayloadMode(options.mode)) {
    const content = JSON.stringify(buildRawPayloadObject(request))
    const page = request.template.document.page
    onProgress?.(85)
    return {
      format: options.mode,
      encoding: 'utf8',
      content,
      // 标签/票据机按数据行数出票，具体页（张）数由客户端自算；这里仅给物理页尺寸作参考
      pages: 1,
      width: toMm(page.width, page.unit),
      height: toMm(page.height, page.unit),
      bytes: utf8Bytes(content),
    }
  }

  const result = await renderDocument(request)
  const pages = result.pages.length
  const deco = request.output?.pageDecoration

  if (options.mode === 'html') {
    onProgress?.(30)
    let html = renderHtml(result, { screen: false, pageDecoration: deco })
    // 字体策略（优先级）：显式 fonts > embedFonts 开关 > 缺省不内联。
    // 默认 embedFonts 为 false —— 不内联文本字体，体积最小化（~17KB/页），
    // 客户端 QWebEngine 按 CSS 兜底链回退系统字体（思源黑体→微软雅黑等）。
    // 仅当显式传 fonts 或 embedFonts=true 时才内联。KaTeX 字体始终强制内联（见下）。
    let defs: FontFaceDef[]
    if (options.fonts) {
      defs = options.fonts
    } else if (options.embedFonts) {
      defs = defaultHtmlPrintFonts(request, html)
    } else {
      defs = []
    }
    // KaTeX 字形无系统兜底（数学字形任何系统字体都渲染不了），即便不内联文本字体也强制带上
    const hasKatexFonts = defs.some((d) => d.src.includes('katex'))
    if (html.includes('katex') && !hasKatexFonts) {
      defs = [...defs, ...KATEX_FONT_DEFS]
    }
    if (defs.length) {
      html = await embedFontsInHtml(html, defs)
      onProgress?.(80)
    }
    onProgress?.(85)
    return {
      format: 'html',
      encoding: 'utf8',
      content: html,
      pages: Math.max(pages, 1),
      width: result.metrics.pageWidth,
      height: result.metrics.pageHeight,
      bytes: utf8Bytes(html),
    }
  }

  onProgress?.(30)
  const blob = await documentToPdf(result, {
    dpi: options.dpi ?? (options.quality ? QUALITY_DPI[options.quality] : undefined),
    scale: options.scale,
    imageType: options.imageType ?? 'png',
    pageDecoration: deco,
    onPage: (current, total) => {
      // 逐页栅格化：30% → 80%
      onProgress?.(30 + Math.round((current / Math.max(total, 1)) * 50))
    },
  })
  onProgress?.(85)
  const base64 = await blobToBase64(blob)
  return {
    format: 'pdf',
    encoding: 'base64',
    content: base64,
    pages: Math.max(pages, 1),
    // 透传页面物理尺寸（mm），与生成 PDF 用的 format:[w,h] 同源（result.metrics 恒为 mm），
    // 供客户端直接设置纸张大小，避免依赖解析 PDF MediaBox 导致纸张不符/打不准。
    width: result.metrics.pageWidth,
    height: result.metrics.pageHeight,
    bytes: base64.length,
  }
}

/** 人类可读体积（UI 提示用） */
export function formatPayloadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
