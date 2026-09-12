/**
 * JsonViewerModal —— 当前画布 JSON 数据查看器（只读 CodeMirror 6 + JSON 语法高亮）
 *
 * 数据源：store.buildTemplate() 的序列化结果。
 * CodeMirror 6 底层 API（EditorView + EditorState）是框架无关的 DOM 库，
 * Vue/React 用法完全一致；亮暗主题经 EditorView.theme() 自定义（无需 one-dark 依赖）。
 */
import { useEffect, useRef } from 'react'
import { Button, Modal, message } from 'antd'
import { json as jsonLang } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { useDesignerStore } from '../stores/designer'
import { useUiStore, resolveEffectiveTheme } from '../stores/ui'
import './json-viewer.css'

/** 暗色主题（Catppuccin Mocha 配色）—— 编辑器外观 + 语法高亮 */
const darkTheme = EditorView.theme({
  '&': { backgroundColor: '#1e1e2e', color: '#cdd6f4' },
  '.cm-content': {
    caretColor: '#89b4fa',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '13px',
  },
  '.cm-gutters': {
    backgroundColor: '#181825',
    color: '#45475a',
    borderRight: '1px solid #313244',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(89, 89, 120, 0.2)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(89, 89, 120, 0.3)', color: '#bac2de' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(89, 89, 120, 0.4)',
  },
})

const darkHighlightStyle = HighlightStyle.define([
  { tag: t.string, color: '#a6e3a1' },
  { tag: t.number, color: '#fab387' },
  { tag: t.bool, color: '#f38ba8' },
  { tag: t.null, color: '#f38ba8' },
  { tag: t.propertyName, color: '#89b4fa' },
  { tag: t.keyword, color: '#cba6f7' },
  { tag: t.comment, color: '#6c7086', fontStyle: 'italic' },
  { tag: t.punctuation, color: '#9399b2' },
  { tag: t.separator, color: '#9399b2' },
  { tag: t.bracket, color: '#9399b2' },
])

/** 亮色主题 */
const lightTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#333333' },
  '.cm-content': {
    caretColor: '#1677ff',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '13px',
  },
  '.cm-gutters': {
    backgroundColor: '#fafafa',
    color: '#bbb',
    borderRight: '1px solid #eee',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(22, 119, 255, 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(22, 119, 255, 0.1)', color: '#666' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(22, 119, 255, 0.15)',
  },
})

const lightHighlightStyle = HighlightStyle.define([
  { tag: t.string, color: '#0b7a5f' },
  { tag: t.number, color: '#c4531c' },
  { tag: t.bool, color: '#d6336c' },
  { tag: t.null, color: '#d6336c' },
  { tag: t.propertyName, color: '#1677ff' },
  { tag: t.keyword, color: '#7c3aed' },
  { tag: t.comment, color: '#999', fontStyle: 'italic' },
  { tag: t.punctuation, color: '#666' },
  { tag: t.separator, color: '#666' },
  { tag: t.bracket, color: '#666' },
])

/** 构建 CodeMirror extensions */
function buildState(jsonText: string, dark: boolean): EditorState {
  return EditorState.create({
    doc: jsonText,
    extensions: [
      basicSetup,
      jsonLang(),
      syntaxHighlighting(dark ? darkHighlightStyle : lightHighlightStyle),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      dark ? darkTheme : lightTheme,
      EditorView.lineWrapping,
    ],
  })
}

export function JsonViewerModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!open) {
      viewRef.current?.destroy()
      viewRef.current = null
      return () => {
        cancelled = true
      }
    }
    const ui = useUiStore.getState()
    const dark = resolveEffectiveTheme(ui) !== 'light'
    let jsonText: string
    try {
      const data = useDesignerStore.getState().buildTemplate()
      jsonText = JSON.stringify(data, null, 2)
    } catch (e) {
      jsonText = `// 序列化失败：${e instanceof Error ? e.message : String(e)}`
    }
    const setup = async (): Promise<void> => {
      // antd Modal 内容经 portal 挂载，effect 时容器可能尚未就绪；
      // 对齐 Vue 版的轮询等待（最多 ~1s）
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
        const container = containerRef.current
        if (!container) {
          await new Promise((r) => setTimeout(r, 50))
          continue
        }
        const view = new EditorView({ state: buildState(jsonText, dark), parent: container })
        viewRef.current = view
        return
      }
    }
    void setup()
    return () => {
      cancelled = true
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [open])

  /** 复制 JSON 到剪贴板，提示成功并关闭面板 */
  async function copyJson(): Promise<void> {
    if (!viewRef.current) return
    try {
      const text = viewRef.current.state.doc.toString()
      await navigator.clipboard.writeText(text)
      void message.success('已复制到剪贴板')
      onClose()
    } catch {
      void message.error('复制失败，请手动选择文本复制')
    }
  }

  return (
    <Modal
      title="画布 JSON 数据"
      open={open}
      onCancel={onClose}
      width={760}
      footer={
        <div className="json-viewer-footer">
          <Button size="small" onClick={() => void copyJson()}>
            复制 JSON
          </Button>
          <Button size="small" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div ref={containerRef} className="json-viewer-body" data-testid="json-viewer-body" />
    </Modal>
  )
}
