/**
 * PrintRichText —— 富文本控件（§5.8）
 *
 * 设计期显示：把富文本 HTML 消毒后包进 SVG `<foreignObject>`，
 * 再栅格化成位图给 FabricImage 显示（与导出引擎同一技术路线，Chromium 限定）。
 * 渲染期（预览/导出/打印）走 data-binder → html-renderer 的 `kind:'html'` 链路，
 * 本类只负责画布上的"所见即所得"预览。
 */
import { FabricImage } from 'fabric'
import DOMPurify from 'dompurify'
import type { RichTextControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'
import { toXmlSafe, svgToCanvas } from '@/core/export-engine/rasterize'

/** 设计期默认字号（px，foreignObject 内继承） */
const DESIGN_FONT_PX = 14

export class PrintRichText extends FabricImage implements IPrintObject {
  controlId: string
  controlType = 'richtext' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  /** 富文本 HTML（协议字段 value） */
  htmlValue?: string

  /** 渲染序号：连续输入时只应用最新一次栅格化结果，防止旧结果覆盖新内容 */
  private renderSeq = 0

  constructor(control: RichTextControl) {
    super(document.createElement('canvas'), {
      left: mm(control.left),
      top: mm(control.top),
      angle: control.angle ?? 0,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    this.controlId = control.id
    this.htmlValue = control.value
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    // 初始尺寸（未缩放），regenerate 会按它换算 scale
    this.set({ width: mm(control.width), height: mm(control.height) })
    void this.regenerate()
  }

  /** 重新栅格化富文本位图，并按控件宽高缩放显示 */
  async regenerate(): Promise<void> {
    const w = this.width || 1
    const h = this.height || 1
    const seq = ++this.renderSeq
    const canvas = await renderRichTextToCanvas(this.htmlValue ?? '', w, h)
    if (seq !== this.renderSeq) return // 已有更新的渲染，丢弃过期结果
    if (canvas) {
      this.setElement(canvas)
      this.set({ scaleX: w / canvas.width, scaleY: h / canvas.height })
    }
    this.setCoords()
    this.canvas?.requestRenderAll()
  }

  toControl(): RichTextControl {
    return {
      ...readBaseGeometry(this),
      type: 'richtext',
      value: this.htmlValue,
      printable: this.printable,
      visibleIf: this.visibleIf,
      locked: this.lockMovementX && this.lockMovementY ? true : undefined,
      name: this.controlName,
    }
  }

  applyControlProps(control: RichTextControl): void {
    this.htmlValue = control.value
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this.set({
      lockMovementX: control.locked,
      lockMovementY: control.locked,
      scaleX: 1,
      scaleY: 1,
      width: mm(control.width),
      height: mm(control.height),
    })
    void this.regenerate()
  }
}

/* ------------------------------ 位图渲染 helpers ------------------------------ */

/** 富文本 HTML → 设计期位图 canvas（失败降级为纯文本占位） */
async function renderRichTextToCanvas(
  html: string,
  w: number,
  h: number,
): Promise<HTMLCanvasElement | null> {
  try {
    // 画布预览同样必须消毒（防模板注入），渲染期有 data-binder 二次消毒
    const safe = toXmlSafe(DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } }))
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;overflow:hidden;` +
      `box-sizing:border-box;margin:0;padding:0;font:${DESIGN_FONT_PX}px system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#000">` +
      `${safe}</div></foreignObject></svg>`
    return await svgToCanvas(svg, 1, '#ffffff')
  } catch {
    return drawFallback(stripHtml(html), w, h)
  }
}

/** 降级占位：白底 + 纯文本（SVG 光栅化失败时保证画布上仍能看到内容） */
function drawFallback(text: string, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(w))
  canvas.height = Math.max(1, Math.ceil(h))
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000000'
  ctx.font = `${DESIGN_FONT_PX}px system-ui, sans-serif`
  const lines = (text || '富文本').split('\n')
  const maxLines = Math.max(1, Math.floor(canvas.height / (DESIGN_FONT_PX + 4)))
  const step = DESIGN_FONT_PX + 4
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    ctx.fillText((lines[i] ?? '').slice(0, 80), 4, 4 + i * step)
  }
  return canvas
}

/** 剥标签 + 解码实体的纯文本提取（仅用于降级显示） */
function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
