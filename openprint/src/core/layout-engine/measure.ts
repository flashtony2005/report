/**
 * 文本测量 —— 分页精度的关键模块
 * 真理源：《OpenPrint-设计方案.md》§11.3
 *
 * | 环境 | 方案 | 精度 |
 * |---|---|---|
 * | 浏览器 | 真实 DOM 排版（本文件 DomMeasurer） | 像素精确，与最终打印一致 |
 * | 无 DOM | CJK 感知估算（EstimateMeasurer） | 近似，仅作兜底 |
 *
 * §11.3 特别警告：**不要用 jsdom 估算** —— jsdom 不实现 CSS 布局引擎，
 * getBoundingClientRect 永远返回 0，任何基于它的测量都是假精度。
 * 因此这里的兜底走字符宽度估算，而不是假装有 DOM。
 */
import { mmToPx, ptToPx, pxToMm } from '@/core/units'
import { recallMeasureCache, rememberMeasureCache } from './measure-cache'

export interface TextMeasureOptions {
  /** 字号（pt，协议单位） */
  fontSize: number
  fontFamily?: string
  fontWeight?: 'normal' | 'bold'
  /** 行高倍率（默认 1.35，贴近打印排版习惯） */
  lineHeight?: number
  /** 字间距（pt） */
  letterSpacing?: number
  /** 可用宽度（mm）；<=0 表示不换行 */
  widthMm: number
  /** 是否允许自动换行（默认 true） */
  wrap?: boolean
}

export interface TextMeasureResult {
  /** 文本占用高度（mm） */
  heightMm: number
  /** 实际折行数 */
  lines: number
}

export interface TextMeasurer {
  measure(text: string, options: TextMeasureOptions): TextMeasureResult
  /** 释放底层资源（DOM 节点等） */
  dispose(): void
}


export const DEFAULT_FONT_FAMILY =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", sans-serif'
export const DEFAULT_LINE_HEIGHT = 1.35

function cacheKey(text: string, o: TextMeasureOptions): string {
  return [
    text,
    o.fontSize,
    o.fontFamily ?? '',
    o.fontWeight ?? 'normal',
    o.lineHeight ?? DEFAULT_LINE_HEIGHT,
    o.letterSpacing ?? 0,
    Math.round(o.widthMm * 100),
    o.wrap === false ? 0 : 1,
  ].join('|')
}

/* ============================ 浏览器：真实 DOM ============================ */

/**
 * 用一个离屏隐藏容器做真实排版测量。
 *
 * 关键点：
 * - 用 `visibility:hidden` + 绝对定位移出视口，**不能用 `display:none`**（不排版，高度恒 0）
 * - `contain: layout size style` 让浏览器把它当独立布局单元，避免污染主文档回流
 * - `white-space: pre-wrap` + `word-break: break-word` 与渲染器输出的 CSS 严格一致，
 *   否则"测量用一套规则、渲染用另一套"会导致分页错位
 */
class DomMeasurer implements TextMeasurer {
  private host: HTMLDivElement
  private cache = new Map<string, TextMeasureResult>()

  constructor() {
    const host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.dataset.openprint = 'measure'
    Object.assign(host.style, {
      position: 'absolute',
      left: '-99999px',
      top: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      contain: 'layout style',
      padding: '0',
      margin: '0',
      border: '0',
    } satisfies Partial<CSSStyleDeclaration>)
    document.body.appendChild(host)
    this.host = host
  }

  measure(text: string, options: TextMeasureOptions): TextMeasureResult {
    const key = cacheKey(text, options)
    const hit = recallMeasureCache(this.cache, key)
    if (hit) return hit

    const lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT
    const fontPx = ptToPx(options.fontSize)
    const el = this.host

    el.style.fontSize = `${fontPx}px`
    el.style.fontFamily = options.fontFamily || DEFAULT_FONT_FAMILY
    el.style.fontWeight = options.fontWeight ?? 'normal'
    el.style.lineHeight = String(lineHeight)
    el.style.letterSpacing = options.letterSpacing ? `${ptToPx(options.letterSpacing)}px` : 'normal'

    if (options.wrap === false || options.widthMm <= 0) {
      el.style.width = 'auto'
      el.style.whiteSpace = 'pre'
    } else {
      el.style.width = `${mmToPx(options.widthMm)}px`
      el.style.whiteSpace = 'pre-wrap'
      el.style.wordBreak = 'break-word'
      el.style.overflowWrap = 'break-word'
    }

    // 空串也要占一行高度，否则空单元格会把行压扁
    el.textContent = text === '' ? '\u00A0' : text

    const heightPx = el.getBoundingClientRect().height
    const singleLinePx = fontPx * lineHeight
    const result: TextMeasureResult = {
      heightMm: pxToMm(heightPx),
      lines: Math.max(1, Math.round(heightPx / Math.max(1, singleLinePx))),
    }

    // 缓存上限，避免超长表格把内存吃满
    rememberMeasureCache(this.cache, key, result)
    return result
  }

  dispose(): void {
    this.cache.clear()
    this.host.remove()
  }
}

/* ============================== 无 DOM 兜底 ============================== */

/**
 * 字符宽度估算：CJK / 全角按 1em，ASCII 按 0.5em（等宽近似）。
 * 精度不如 DOM，但至少不会像 jsdom 那样返回 0。
 */
class EstimateMeasurer implements TextMeasurer {
  private cache = new Map<string, TextMeasureResult>()

  private static charWidthEm(ch: string): number {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字 / 全角标点 / 假名 / 韩文
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      return 1
    }
    return 0.5
  }

  measure(text: string, options: TextMeasureOptions): TextMeasureResult {
    const key = cacheKey(text, options)
    const hit = recallMeasureCache(this.cache, key)
    if (hit) return hit

    const lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT
    const fontPx = ptToPx(options.fontSize)
    const letterPx = options.letterSpacing ? ptToPx(options.letterSpacing) : 0
    const availPx = options.wrap === false || options.widthMm <= 0 ? Infinity : mmToPx(options.widthMm)

    let lines = 1
    let cursor = 0
    for (const ch of text) {
      if (ch === '\n') {
        lines++
        cursor = 0
        continue
      }
      const w = EstimateMeasurer.charWidthEm(ch) * fontPx + letterPx
      if (cursor + w > availPx && cursor > 0) {
        lines++
        cursor = w
      } else {
        cursor += w
      }
    }

    const result: TextMeasureResult = {
      heightMm: pxToMm(lines * fontPx * lineHeight),
      lines,
    }
    rememberMeasureCache(this.cache, key, result)
    return result
  }

  dispose(): void {
    this.cache.clear()
  }
}

/* ================================ 工厂 ================================ */

let shared: TextMeasurer | null = null

/** 创建测量器：有 DOM 走真实排版，无 DOM 走估算 */
export function createMeasurer(): TextMeasurer {
  const hasDom = typeof document !== 'undefined' && typeof document.body !== 'undefined'
  return hasDom ? new DomMeasurer() : new EstimateMeasurer()
}

/**
 * 全局共享测量器（复用 DOM 节点 + 缓存，多次渲染成本近似 0）。
 * 渲染流程用这个；单测想要干净环境时自行 createMeasurer()。
 */
export function getSharedMeasurer(): TextMeasurer {
  if (!shared) shared = createMeasurer()
  return shared
}

export function disposeSharedMeasurer(): void {
  shared?.dispose()
  shared = null
}
