/**
 * RichTextEditor —— 富文本编辑器（tiptap v3 + StarterKit + 字体扩展，React.lazy 懒加载）
 * 由 RichTextProps 通过 React.lazy 引入，未选中富文本时不加载 tiptap。
 * 对齐 Vue 版 RichTextEditor.vue：字体下拉（预设 + 电脑系统字体分组）+ 工具条 + 编辑区。
 */
import { useEffect, useMemo, useState } from 'react'
import { Editor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { FontFamily } from '@tiptap/extension-font-family'
import { Button, Select } from 'antd'
import { FONT_CATALOG } from '@/core/fonts/catalog'
import { useSystemFonts } from '../../hooks/useSystemFonts'
import './rich-text-editor.css'

interface Props {
  value?: string
  onChange: (html: string) => void
}

interface ToolButton {
  key: string
  label?: string
  title: string
  active: (editor: Editor) => boolean
  run: (editor: Editor) => void
}

const TOOLS: ToolButton[] = [
  { key: 'bold', label: 'B', title: '加粗', active: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
  { key: 'italic', label: 'I', title: '斜体', active: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
  { key: 'underline', label: 'U', title: '下划线', active: (e) => e.isActive('underline'), run: (e) => e.chain().focus().toggleUnderline().run() },
  { key: 'h2', label: 'H2', title: '二级标题', active: (e) => e.isActive('heading', { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { key: 'h3', label: 'H3', title: '三级标题', active: (e) => e.isActive('heading', { level: 3 }), run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { key: 'ul', label: '• 列表', title: '无序列表', active: (e) => e.isActive('bulletList'), run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: 'ol', label: '1. 列表', title: '有序列表', active: (e) => e.isActive('orderedList'), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: 'blockquote', label: '❝', title: '引用', active: (e) => e.isActive('blockquote'), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { key: 'undo', label: '↩', title: '撤销', active: () => false, run: (e) => e.chain().focus().undo().run() },
  { key: 'redo', label: '↪', title: '重做', active: () => false, run: (e) => e.chain().focus().redo().run() },
]

export default function RichTextEditor({ value, onChange }: Props) {
  const sysFonts = useSystemFonts()

  const editor = useMemo(
    () =>
      new Editor({
        extensions: [StarterKit, TextStyle, FontFamily],
        content: value ?? '',
        // 外部改动与内部编辑统一走 onUpdate；防死循环靠 setContent emitUpdate:false
        onUpdate: ({ editor: ed }) => onChange(ed.getHTML()),
      }),
    // 编辑器实例只随挂载创建一次（对齐 Vue 版行为）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /** 外部改动（撤销/加载模板/重置）→ 回写编辑器；emitUpdate:false 避免触发 onUpdate 死循环 */
  useEffect(() => {
    if (value !== undefined && value !== editor.getHTML()) {
      editor.commands.setContent(value ?? '', { emitUpdate: false })
    }
  }, [value, editor])

  useEffect(() => {
    return () => editor.destroy()
  }, [editor])

  /** 编辑器当前字体族（textStyle mark 上）；transaction/selectionUpdate 后刷新 */
  const [currentFont, setCurrentFont] = useState('')
  useEffect(() => {
    const refresh = (): void => {
      setCurrentFont((editor.getAttributes('textStyle').fontFamily as string | undefined) ?? '')
    }
    editor.on('selectionUpdate', refresh)
    editor.on('transaction', refresh)
    refresh()
    return () => {
      editor.off('selectionUpdate', refresh)
      editor.off('transaction', refresh)
    }
  }, [editor, value])

  const fontOptions = useMemo(() => {
    const builtin = [
      ...FONT_CATALOG.map((f) => ({ label: f.label, value: f.family })),
    ]
    if (!sysFonts.ready) return [{ label: '系统默认', value: '' }, ...builtin]
    return [
      { label: '预设字体', title: 'group', options: builtin } as const,
      {
        label: `电脑系统字体（${sysFonts.count}）`,
        title: 'group',
        options: sysFonts.grouped.map((g) => ({ label: g.family, value: g.family })),
      } as const,
      { label: '系统默认', value: '' },
    ]
  }, [sysFonts.ready, sysFonts.count, sysFonts.grouped])

  const onFontChange = (family: string): void => {
    if (!family) {
      editor.chain().focus().unsetFontFamily().run()
    } else {
      editor.chain().focus().setFontFamily(family).run()
    }
    setCurrentFont((editor.getAttributes('textStyle').fontFamily as string | undefined) ?? '')
  }

  return (
    <div className="rt-editor">
      <div className="rt-toolbar">
        <Select
          size="small"
          value={currentFont}
          options={fontOptions as never}
          className="rt-font-select"
          placeholder="字体"
          popupMatchSelectWidth={false}
          onChange={onFontChange}
        />
        {TOOLS.map((t) => (
          <Button
            key={t.key}
            size="small"
            type={t.active(editor) ? 'primary' : 'text'}
            title={t.title}
            className="rt-tool-btn"
            onClick={() => t.run(editor)}
          >
            <span className="rt-tool-label">{t.label}</span>
          </Button>
        ))}
      </div>
      <div className="rt-body">
        <EditorContent editor={editor} className="rt-content" />
      </div>
    </div>
  )
}
