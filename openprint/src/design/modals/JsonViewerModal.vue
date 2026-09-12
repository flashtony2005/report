<script setup lang="ts">
/**
 * JsonViewerModal —— 当前画布 JSON 数据查看器（只读 CodeMirror 6 + JSON 语法高亮）
 * 数据源：store.buildTemplate() 的序列化结果。
 * 直接使用 CodeMirror 6 底层 API（EditorView + EditorState），
 * 不依赖 vue-codemirror6 包装组件（存在 Vue 3 Options/Composition ref 绑定不兼容的问题）。
 * 暗/亮主题通过 EditorView.theme() 自定义（无需 @codemirror/theme-one-dark 额外依赖）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NModal, useMessage } from 'naive-ui'
import { json as jsonLang } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { useDesignerStore } from '@/design/stores/designer'
import { useUiStore } from '@/design/stores/ui'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const store = useDesignerStore()
const uiStore = useUiStore()
const message = useMessage()

const isDark = computed(() => uiStore.effectiveTheme !== 'light')

/** CodeMirror 容器 DOM ref */
const editorContainerRef = ref<HTMLElement | null>(null)
/** CodeMirror EditorView 实例 */
let editorView: EditorView | null = null

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
function buildExtensions(jsonText: string): ReturnType<typeof EditorState.create> {
  const dark = isDark.value
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

/** 创建/重建编辑器（直接使用 DOM API 查找容器，避免 Vue template ref 时序问题） */
async function createEditor(jsonText: string): Promise<void> {
  // NModal display-directive=if 下容器在动画后才可见
  // 用 DOM 查询而非 template ref 确保拿到真实元素
  let container: HTMLElement | null = null
  let attempts = 0
  while (!container && attempts < 20) {
    container = document.querySelector('.json-viewer-body')
    if (!container) await nextTick()
    // 给 NModal 动画一点时间
    if (!container) await new Promise((r) => setTimeout(r, 50))
    attempts++
  }
  if (!container) return
  destroyEditor()
  editorView = new EditorView({
    state: buildExtensions(jsonText),
    parent: container,
  })
}

function destroyEditor(): void {
  if (editorView) {
    editorView.destroy()
    editorView = null
  }
}

/** 弹窗打开时：序列化 JSON → 等待 DOM 更新 → 创建编辑器 */
watch(
  () => props.show,
  async (open) => {
    if (open) {
      await nextTick()
      let jsonText: string
      try {
        const data = store.buildTemplate()
        jsonText = JSON.stringify(data, null, 2)
      } catch (e) {
        jsonText = `// 序列化失败：${e instanceof Error ? e.message : String(e)}`
      }
      await createEditor(jsonText)
    } else {
      destroyEditor()
    }
  },
)

function close(): void {
  emit('update:show', false)
}

/** 复制 JSON 到剪贴板，提示成功并关闭面板 */
async function copyJson(): Promise<void> {
  if (!editorView) return
  try {
    const text = editorView.state.doc.toString()
    await navigator.clipboard.writeText(text)
    message.success('已复制到剪贴板')
    close()
  } catch {
    message.error('复制失败，请手动选择文本复制')
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    title="画布 JSON 数据"
    style="width: 760px; max-width: 94vw"
    :mask-closable="true"
    display-directive="if"
    @update:show="emit('update:show', $event)"
  >
    <div ref="editorContainerRef" class="json-viewer-body" />
    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton size="small" @click="copyJson">
          <template #icon>
            <div class="i-carbon-copy text-14px" />
          </template>
          复制 JSON
        </NButton>
        <NButton size="small" @click="close">关闭</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.json-viewer-body {
  height: 480px;
  border: 1px solid var(--brand-border);
  border-radius: 8px;
  overflow: hidden;
}
.json-viewer-body :deep(.cm-editor) {
  height: 100%;
}
.json-viewer-body :deep(.cm-scroller) {
  overflow: auto;
}
.json-viewer-body :deep(.cm-editor.cm-focused) {
  outline: none;
}
</style>
