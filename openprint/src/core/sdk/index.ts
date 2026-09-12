/**
 * OpenPrint SDK —— 对外唯一渲染契约
 * 真理源：《OpenPrint-设计方案.md》§6.4
 *
 * 设计器、导出器、无头服务、第三方接入都只调这里，不直接碰 layout-engine / renderer-html。
 * 这样内部三层（分页 → 渲染 → 输出）随时可换实现（SVG / PDF renderer）而不破坏调用方。
 *
 * ```ts
 * const { html, pages, warnings } = await render({ template, data })
 * ```
 */
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'
import { layout, type LayoutOptions } from '@/core/layout-engine/pagination-engine'
import type { LayoutResult, RenderWarning } from '@/core/layout-engine/types'
import { disposeSharedMeasurer } from '@/core/layout-engine/measure'
import { renderHtml, type RenderHtmlOptions } from '@/core/renderer-html'

export interface RenderRequest {
  /** 模板协议对象（designer store 的 buildTemplate() 产物） */
  template: TemplateData<AnyControl>
  /** 业务数据；表格 dataSource 从这里按路径取数组 */
  data?: Record<string, unknown>
  /** 排版选项（自定义测量器 / 页数上限） */
  layout?: LayoutOptions
  /** 输出选项（屏幕预览装饰 / 缩放 / 完整文档） */
  output?: RenderHtmlOptions
}

export interface RenderResponse {
  /** 可直接写入 iframe / 落盘 / 送打印的 HTML */
  html: string
  /** 总页数 */
  pages: number
  /** 渲染告警（绑定缺失、数据源非数组、内容溢出…），UI 应当展示而非吞掉 */
  warnings: RenderWarning[]
  /** 内部排版产物，供导出器复用（避免二次分页） */
  result: LayoutResult
}

/**
 * 模板 + 数据 → 多页 HTML。
 *
 * 注意：这是**异步**的。二维码走 `qrcode.toString()` 的 Promise API，
 * 且未来图片预加载也要在这一层完成，所以契约从一开始就定成 async，避免后续破坏性变更。
 */
export async function render(request: RenderRequest): Promise<RenderResponse> {
  const result = await renderDocument(request)
  const html = renderHtml(result, request.output)
  return {
    html,
    pages: result.pages.length,
    warnings: result.warnings,
    result,
  }
}

/** 只做排版不出 HTML —— PDF / 图片导出器直接消费页面模型 */
export async function renderDocument(request: RenderRequest): Promise<LayoutResult> {
  return layout(request.template, request.data ?? {}, request.layout ?? {})
}

/**
 * 释放共享测量器持有的离屏 DOM 节点。
 * 长期运行的 SPA 不需要调用（复用缓存收益更大）；单测或页面卸载时清一下更干净。
 */
export function dispose(): void {
  disposeSharedMeasurer()
}

export type { LayoutOptions, LayoutResult, RenderWarning, RenderHtmlOptions }
