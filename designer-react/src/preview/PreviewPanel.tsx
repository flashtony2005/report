/**
 * PreviewPanel —— 多页打印预览（与 Vue 版 PreviewPanel.vue 行为对齐）
 *
 * ## 为什么用 iframe 而不是直接挂 DOM
 *
 * 渲染产物自带一整套 `@page` / `html,body` / `.op-*` 全局样式，直接注入设计器页面会：
 * 1. 被设计器的 reset 规则污染，预览和最终打印对不上（预览就失去意义）
 * 2. 反过来把 `@page`、`print-color-adjust` 泄漏给设计器，Ctrl+P 时打出画布
 *
 * iframe 用 `srcdoc` 装载，同源可访问 contentDocument，
 * 因此缩放（改 CSS 变量）和翻页（滚动定位）都不必重新渲染 HTML。
 *
 * ## 打印一致性
 *
 * 打印走 `iframe.contentWindow.print()`，打的就是预览的同一份 DOM 与同一份 CSS，
 * 从机制上保证「预览 = 打印」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Popover, Spin, Tooltip } from 'antd'
import { render } from '@/core/sdk'
import type { RenderWarning } from '@/core/layout-engine/types'
import { mmToPx } from '@/core/units'
import { builtinFontFaceCss } from '@/core/fonts/loader'
import { systemFontFaceCss } from '../hooks/useSystemFonts'
import { useDataSourceStore, selectPreviewData } from '../stores/dataSource'
import { useDesignerStore } from '../stores/designer'
import { useUiStore } from '../stores/ui'
import { WARNING_LABEL, SCALE_MIN, SCALE_STEP, clampScale } from '@/design/preview/shared/preview-logic'
import './preview-panel.css'

/** 按固定步长（25%）缩放：dir=1 放大 / -1 缩小 */
function zoomBy(current: number, dir: 1 | -1): number {
  return clampScale(current + dir * SCALE_STEP)
}

export function PreviewPanel(): React.JSX.Element {
  const open = useUiStore((s) => s.previewOpen)
  const templateName = useDesignerStore((s) => s.templateName)

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const wheelWinRef = useRef<Window | null>(null)

  const [html, setHtml] = useState('')
  const [rendering, setRendering] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [warnings, setWarnings] = useState<RenderWarning[]>([])
  const [totalPages, setTotalPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageWidthMm, setPageWidthMm] = useState(210)
  const [scale, setScale] = useState(0.5)

  /** 把当前 scale 写入 iframe 文档的 --op-scale 变量 */
  const applyScale = useCallback((v: number): void => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    doc.documentElement.style.setProperty('--op-scale', String(v))
  }, [])

  /* ------------------------------- 渲染 ------------------------------- */

  const doRender = useCallback(async (): Promise<void> => {
    setRendering(true)
    setErrorText('')
    try {
      const s = useDesignerStore.getState()
      const template = s.buildTemplate()
      const data = selectPreviewData(useDataSourceStore.getState()) as Record<string, unknown>

      const res = await render({
        template,
        data,
        output: {
          screen: true,
          scale: 1,
          title: s.templateName,
          pageDecoration: {
            backgroundColor: s.pageSetup.backgroundColor ?? '#ffffff',
            watermark: s.pageSetup.watermark,
          },
        },
      })

      setHtml(res.html)
      setWarnings(res.warnings)
      setTotalPages(res.pages)
      setPageWidthMm(res.result.metrics.pageWidth)
      setCurrentPage(1)
      setScale(0.5)
      // srcdoc 换了内容要等 load 才能拿到 contentDocument，交给 onIframeLoad 收尾
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e))
      setHtml('')
      setTotalPages(0)
    } finally {
      setRendering(false)
    }
  }, [])

  useEffect(() => {
    if (open) void doRender()
  }, [open, doRender])

  /* ------------------------------- 缩放 ------------------------------- */

  useEffect(() => {
    applyScale(scale)
  }, [scale, applyScale])

  /** 适应宽度：按可视宽度反推缩放比（留 40px 给滚动条与留白） */
  const fitWidth = useCallback((): void => {
    const host = iframeRef.current
    if (!host) return
    const avail = host.clientWidth - 40
    const pagePx = mmToPx(pageWidthMm)
    if (avail > 0 && pagePx > 0) {
      setScale(clampScale(Math.max(SCALE_MIN, Math.round((avail / pagePx) * 100) / 100)))
    }
  }, [pageWidthMm])

  /** Ctrl / ⌘ + 滚轮缩放：在 iframe 内容窗口上捕获，阻止浏览器页面缩放 */
  const onPreviewWheel = useCallback((e: WheelEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    e.stopPropagation()
    setScale((cur) => zoomBy(cur, e.deltaY > 0 ? -1 : 1))
  }, [])

  const attachPreviewWheel = useCallback((): void => {
    const win = iframeRef.current?.contentWindow
    if (!win || win === wheelWinRef.current) return
    wheelWinRef.current = win
    win.addEventListener('wheel', onPreviewWheel, { passive: false })
  }, [onPreviewWheel])

  /* ------------------------------- 翻页 ------------------------------- */

  const pageEls = useCallback((): HTMLElement[] => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return []
    return Array.from(doc.querySelectorAll<HTMLElement>('.op-page-wrap'))
  }, [])

  const gotoPage = useCallback(
    (n: number): void => {
      const target = Math.min(Math.max(1, n), Math.max(1, totalPages))
      const el = pageEls()[target - 1]
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setCurrentPage(target)
    },
    [totalPages, pageEls],
  )

  const syncCurrentPage = useCallback((): void => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    const top = win.scrollY + 60
    const els = pageEls()
    let idx = 0
    for (let i = 0; i < els.length; i++) {
      if ((els[i]?.offsetTop ?? 0) <= top) idx = i
      else break
    }
    setCurrentPage(idx + 1)
  }, [pageEls])

  /** 向 iframe head 注入内置字体与打印客户端系统字体的 @font-face */
  const injectFonts = useCallback((): void => {
    const doc = iframeRef.current?.contentDocument
    if (!doc || typeof window === 'undefined') return
    if (doc.getElementById('op-fonts')) return
    const style = doc.createElement('style')
    style.id = 'op-fonts'
    const sys = systemFontFaceCss()
    style.textContent =
      builtinFontFaceCss(window.location.origin) + (sys ? `\n/* 电脑系统字体（来自打印客户端）*/\n${sys}` : '')
    doc.head.appendChild(style)
  }, [])

  const onIframeLoad = useCallback((): void => {
    applyScale(scale)
    injectFonts()
    attachPreviewWheel()
    const win = iframeRef.current?.contentWindow
    win?.addEventListener('scroll', syncCurrentPage, { passive: true })
  }, [applyScale, injectFonts, attachPreviewWheel, syncCurrentPage, scale])

  /* ------------------------------- 打印 ------------------------------- */

  function doPrint(): void {
    const win = iframeRef.current?.contentWindow
    if (!win) {
      void import('antd').then(({ message }) => message.warning('预览尚未就绪'))
      return
    }
    // 打印时强制 1:1，否则浏览器会把预览缩放一起打进去
    iframeRef.current?.contentDocument?.documentElement.style.setProperty('--op-scale', '1')
    win.focus()
    win.print()
    applyScale(scale)
  }

  function close(): void {
    useUiStore.getState().setPreviewOpen(false)
  }

  const warningCount = warnings.length

  return (
    <Modal
      // 自带工具条（含标题与关闭 ✕），不复用 antd 的标题栏，避免双标题
      title={null}
      closable={false}
      open={open}
      onCancel={close}
      mask={{ closable: false }}
      centered
      width={880}
      // antd v6 的内边距在 .ant-modal-container 上（默认 20px 24px），
      // 只清 styles.body 不生效——预览要满幅 iframe，必须同时清 container
      styles={{ body: { padding: 0 }, container: { padding: 0 } }}
      footer={null}
      data-testid="preview-panel"
      wrapClassName="preview-panel-modal"
    >
      <div className="preview-shell">
        {/* 工具条 */}
        <header className="preview-bar">
          <div className="preview-bar-left">
            <span className="preview-title">打印预览</span>
            <span className="preview-subtitle">{templateName}</span>
          </div>

          <div className="preview-bar-right">
            {/* 翻页 */}
            <Button type="text" size="small" disabled={currentPage <= 1} aria-label="上一页" onClick={() => gotoPage(currentPage - 1)}>
              ↑
            </Button>
            <span className="preview-page-indicator" data-testid="preview-page-indicator">
              第 {currentPage} / {totalPages || 1} 页
            </span>
            <Button type="text" size="small" disabled={currentPage >= totalPages} aria-label="下一页" onClick={() => gotoPage(currentPage + 1)}>
              ↓
            </Button>

            <div className="bar-sep" />

            {/* 告警 */}
            {warningCount > 0 && (
              <Popover
                placement="bottom"
                trigger="click"
                content={
                  <div className="warn-list">
                    {warnings.map((w, i) => (
                      <div key={i} className="warn-item">
                        <span className="warn-code">{WARNING_LABEL[w.code] ?? w.code}</span>
                        <span className="warn-msg">{w.message}</span>
                      </div>
                    ))}
                  </div>
                }
              >
                <Button size="small" type="text" danger data-testid="preview-warnings">
                  ⚠ {warningCount} 条告警
                </Button>
              </Popover>
            )}

            <Button size="small" onClick={() => void doRender()}>
              重新渲染
            </Button>
            <Tooltip title="走 iframe.contentWindow.print()，与预览同一份 DOM/CSS">
              <Button size="small" type="primary" disabled={!totalPages} onClick={doPrint}>
                浏览器打印
              </Button>
            </Tooltip>
            <Button type="text" size="small" aria-label="关闭预览" onClick={close}>
              ✕
            </Button>
          </div>
        </header>

        {/* 预览区 */}
        <div className="preview-body">
          <Spin spinning={rendering} wrapperClassName="preview-spin">
            {errorText ? (
              <div className="preview-error">
                <div className="preview-error-title">渲染失败</div>
                <div className="preview-error-msg">{errorText}</div>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                className="preview-frame"
                title="打印预览"
                sandbox="allow-same-origin allow-modals"
                srcDoc={html}
                onLoad={onIframeLoad}
              />
            )}
          </Spin>

          {/* 右下角缩放：适应宽度 / − / 百分比 / +（步长 25%，Ctrl+滚轮同样生效） */}
          <div className="preview-zoom">
            <button type="button" className="zoom-btn" title="适应宽度" onClick={fitWidth}>
              ⇔
            </button>
            <button type="button" className="zoom-btn" title="缩小 25%" onClick={() => setScale((s) => zoomBy(s, -1))}>
              −
            </button>
            <span className="zoom-value" data-testid="preview-zoom-value">
              {Math.round(scale * 100)}%
            </span>
            <button type="button" className="zoom-btn" title="放大 25%" onClick={() => setScale((s) => zoomBy(s, 1))}>
              +
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
