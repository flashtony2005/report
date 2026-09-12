/**
 * Headless 无头静默模式 —— 《OpenPrint-实施指南》Phase 9 / 《设计方案》§19.4.4
 *
 * ## 定位
 * `createHeadless({ repository, dataSource, fonts })` 是一个**零 UI、不挂载任何可见 DOM** 的
 * 编程式渲染/导出/打印入口。它直接复用 `sdk.render()` + `export-engine`，
 * 因此与「设计器预览」「浏览器打印」三者视觉完全一致（同一份 HTML/CSS 真相源）。
 *
 * ## 与 Vue 解耦
 * 本文件是纯 TypeScript，不 import 任何 Vue / designer-vue 代码，
 * 可直接被使用者的脚本、Node 参考渲染器或自动化测试调用。
 *
 * ## 零隐藏 DOM 的保证
 * - 不往页面挂载任何隐藏预览节点（对比：设计器预览面板用独立 iframe）。
 * - `print()` 仅在打印瞬间创建一个 0 尺寸 iframe、注入 srcdoc、调用 `print()`，
 *   打印完成（或用户取消）后立即移除，页面不留残留 DOM。
 * - 导出走 canvas/Blob，完全在内存与离屏 canvas 中完成。
 */
import { render as sdkRender, type RenderRequest, type RenderResponse } from '@/core/sdk'
import { renderHtml } from '@/core/renderer-html'
import {
  exportDocument,
  type ExportFormat,
  type ExportOptions,
  type ExportOutcome,
  type FontFaceDef,
} from '@/core/export-engine'
import { embedFontsInHtml, loadFonts } from './loader'
import type { TemplateRepository } from '@/repository/types'
import type { TemplateData } from '@/types/template'
import type { AnyControl } from '@/types/control'

export interface HeadlessOptions {
  /** 模板仓库（取模板用）。不传则 `buildRequest` 抛错，但 `render/exportXxx` 仍可手动传 template。 */
  repository?: TemplateRepository
  /** 数据源仓库（保留位，当前用于约定签名；自动合成数据由调用方用 buildPreviewData 组合）。 */
  dataSource?: unknown
  /** 同源自定义字体，导出 / 打印时嵌入，避免栅格化丢字体。 */
  fonts?: FontFaceDef[]
}

/** 渲染/导出请求：模板 + 可选数据（未给数据则由调用方保证模板无 dataSource 依赖） */
export interface HeadlessRequest {
  template: TemplateData<AnyControl>
  data?: Record<string, unknown>
  layout?: RenderRequest['layout']
  output?: RenderRequest['output']
}

export interface HeadlessExportOptions {
  /** 高清倍率 1/2/3，默认 2；被 quality 覆盖 */
  scale?: number
  /**
   * 清晰度预设（语义化，推荐）：`low`=96dpi / `medium`=192dpi / `high`=288dpi。
   * 比裸 `scale` 更直观；被显式 `scale` 覆盖。
   */
  quality?: import('@/core/quality').PrintQuality
  /** 文件名（不含扩展名） */
  filename?: string
  /** 位图背景色，默认白 */
  background?: string
}

export interface HeadlessInstance {
  /** 仅排版，返回 HTML 产物 + 页面模型 + 告警 */
  render(req: HeadlessRequest): Promise<RenderResponse>
  /** 导出 PDF（单文件多页，思源宋体写死内联） */
  exportPdf(req: HeadlessRequest, opts?: HeadlessExportOptions): Promise<ExportOutcome>
  /** 导出 JPG（多页每页一个文件） */
  exportJpg(req: HeadlessRequest, opts?: HeadlessExportOptions): Promise<ExportOutcome>
  /** 导出 SVG（单文件多页纵向堆叠矢量） */
  exportSvg(req: HeadlessRequest, opts?: HeadlessExportOptions): Promise<ExportOutcome>
  /** 静默浏览器打印（弹出系统打印对话框，零 UI 残留） */
  print(req: HeadlessRequest): Promise<void>
  /** 按模板 id 从 repository 取出模板，组装成 RenderRequest（默认 output.screen=false） */
  buildRequest(templateId: string, data?: Record<string, unknown>): Promise<RenderRequest>
  /** 释放资源（反注册字体等） */
  dispose(): void
}

export function createHeadless(options: HeadlessOptions = {}): HeadlessInstance {
  const fonts = options.fonts ?? []
  let teardownFonts: (() => void) | null = null

  // 浏览器环境：把字体注册到文档，供同源预览/打印使用
  if (fonts.length && typeof document !== 'undefined') {
    loadFonts(fonts)
      .then((t) => {
        teardownFonts = t
      })
      .catch(() => {
        /* 字体加载失败不影响其余功能，栅格化会走系统字体兜底 */
      })
  }

  const toRequest = (req: HeadlessRequest): RenderRequest => ({
    template: req.template,
    data: req.data,
    layout: req.layout,
    output: { screen: false, ...req.output },
  })

  async function buildRequest(templateId: string, data?: Record<string, unknown>): Promise<RenderRequest> {
    if (!options.repository) throw new Error('createHeadless 未配置 repository，无法按 id 取模板')
    const rec = await options.repository.get(templateId)
    if (!rec) throw new Error(`模板不存在：${templateId}`)
    return { template: rec.data, data, output: { screen: false } }
  }

  async function render(req: HeadlessRequest): Promise<RenderResponse> {
    return sdkRender(toRequest(req))
  }

  async function exportFormat(
    req: HeadlessRequest,
    format: ExportFormat,
    opts?: HeadlessExportOptions,
  ): Promise<ExportOutcome> {
    const expOpts: ExportOptions = {
      fonts,
      scale: opts?.scale,
      quality: opts?.quality,
      filename: opts?.filename,
      background: opts?.background,
    }
    return exportDocument(toRequest(req), format, expOpts)
  }

  async function print(req: HeadlessRequest): Promise<void> {
    const res = await render(toRequest(req))
    const pageDecoration = toRequest(req).output?.pageDecoration
    let html = renderHtml(res.result, { screen: false, pageDecoration })
    if (fonts.length) html = await embedFontsInHtml(html, fonts)
    await silentPrint(html)
  }

  function dispose(): void {
    if (teardownFonts) {
      try {
        teardownFonts()
      } catch {
        /* noop */
      }
      teardownFonts = null
    }
  }

  return {
    render,
    exportPdf: (r, o) => exportFormat(r, 'pdf', o),
    exportJpg: (r, o) => exportFormat(r, 'jpg', o),
    exportSvg: (r, o) => exportFormat(r, 'svg', o),
    print,
    buildRequest,
    dispose,
  }
}
function silentPrint(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('silentPrint 需要浏览器环境'))
      return
    }
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
    let removed = false
    let printed = false  // 🔥 加防重复标志
    const cleanup = () => {
      if (removed) return
      removed = true
      setTimeout(() => iframe.remove(), 300)
    }
    iframe.onload = () => {
      if (printed) return  // 🔥 已打印过，跳过
      const cw = iframe.contentWindow
      if (!cw) {
        cleanup()
        reject(new Error('iframe 无 contentWindow'))
        return
      }
      // 🔥 检查内容是否完整
      try {
        const htmlContent = cw.document?.body?.innerHTML || ''
        if (htmlContent.length < 50) return
      } catch {
        return
      }
      printed = true  // 🔥 标记已打印
      cw.onafterprint = () => {
        cleanup()
        resolve()
      }
      try {
        cw.focus()
        cw.print()
      } catch (e) {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    document.body.appendChild(iframe)
    iframe.srcdoc = html
  })
}