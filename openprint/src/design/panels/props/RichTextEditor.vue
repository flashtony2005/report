<script setup lang="ts">
/**
 * RichTextEditor —— 富文本编辑器（tiptap v3 + StarterKit + 字体扩展，懒加载）
 * 由 RichTextProps 通过 defineAsyncComponent 引入，未选中富文本时不加载 tiptap。
 */
import { onBeforeUnmount, ref, computed, watch } from 'vue'
import { NButton, NSelect } from 'naive-ui'
import type { SelectOption, SelectGroupOption } from 'naive-ui'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { FontFamily } from '@tiptap/extension-font-family'
import { FONT_CATALOG } from '@/core/fonts/catalog'
import { useSystemFonts } from '@/design/composables/useSystemFonts'

const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const editor = new Editor({
  extensions: [StarterKit, TextStyle, FontFamily],
  content: props.modelValue ?? '',
  onUpdate: ({ editor }) => emit('update:modelValue', editor.getHTML()),
})

/** 外部改动（撤销/加载模板/重置）→ 回写编辑器；emitUpdate:false 避免触发 onUpdate 死循环 */
watch(
  () => props.modelValue,
  (v) => {
    if (editor && v !== editor.getHTML()) {
      editor.commands.setContent(v ?? '', { emitUpdate: false })
    }
  },
)

onBeforeUnmount(() => {
  editor.destroy()
})

/* ------------------------------ 字体选择 ------------------------------ */

/** 编辑器当前字体族（textStyle mark 上） */
const currentFont = ref('')
const refreshFont = (): void => {
  currentFont.value = (editor.getAttributes('textStyle').fontFamily as string | undefined) ?? ''
}
editor.on('selectionUpdate', refreshFont)
editor.on('transaction', refreshFont)
watch(
  () => props.modelValue,
  () => refreshFont(),
)

const sysFonts = useSystemFonts()

const FONT_OPTIONS = computed<(SelectOption | SelectGroupOption)[]>(() => {
  const builtin: SelectOption[] = [
    { label: '系统默认', value: '' },
    ...FONT_CATALOG.map((f) => ({ label: f.label, value: f.family })),
  ]
  if (!sysFonts.ready.value) return builtin
  const sysOpts: SelectOption[] = sysFonts.grouped.value.map((g) => ({ label: g.family, value: g.family }))
  return [
    { type: 'group', label: '预设字体', key: 'builtin', children: builtin.filter((o) => o.value !== '') },
    { type: 'group', label: `电脑系统字体（${sysFonts.count.value}）`, key: 'system', children: sysOpts },
    { label: '系统默认', value: '' },
  ]
})

function onFontChange(family: string): void {
  if (!family) {
    editor.chain().focus().unsetFontFamily().run()
  } else {
    editor.chain().focus().setFontFamily(family).run()
  }
  refreshFont()
}

type ToolButton = {
  key: string
  label?: string
  icon?: string
  title: string
  active: () => boolean
  run: () => void
}

const tools: ToolButton[] = [
  {
    key: 'bold',
    icon: 'i-carbon-text-bold',
    title: '加粗',
    active: () => editor.isActive('bold'),
    run: () => editor.chain().focus().toggleBold().run(),
  },
  {
    key: 'italic',
    icon: 'i-carbon-text-italic',
    title: '斜体',
    active: () => editor.isActive('italic'),
    run: () => editor.chain().focus().toggleItalic().run(),
  },
  {
    key: 'underline',
    icon: 'i-carbon-text-underline',
    title: '下划线',
    active: () => editor.isActive('underline'),
    run: () => editor.chain().focus().toggleUnderline().run(),
  },
  {
    key: 'h2',
    label: 'H2',
    title: '二级标题',
    active: () => editor.isActive('heading', { level: 2 }),
    run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    key: 'h3',
    label: 'H3',
    title: '三级标题',
    active: () => editor.isActive('heading', { level: 3 }),
    run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    key: 'ul',
    icon: 'i-carbon-list-bulleted',
    title: '无序列表',
    active: () => editor.isActive('bulletList'),
    run: () => editor.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'ol',
    icon: 'i-carbon-list-numbered',
    title: '有序列表',
    active: () => editor.isActive('orderedList'),
    run: () => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    key: 'blockquote',
    label: '❝',
    title: '引用',
    active: () => editor.isActive('blockquote'),
    run: () => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    key: 'undo',
    icon: 'i-carbon-undo',
    title: '撤销',
    active: () => false,
    run: () => editor.chain().focus().undo().run(),
  },
  {
    key: 'redo',
    icon: 'i-carbon-redo',
    title: '重做',
    active: () => false,
    run: () => editor.chain().focus().redo().run(),
  },
]
</script>

<template>
  <div class="rt-editor">
    <div class="rt-toolbar">
      <NSelect
        size="tiny"
        :value="currentFont"
        :options="FONT_OPTIONS"
        class="rt-font-select"
        placeholder="字体"
        @update:value="onFontChange"
      />
      <NButton
        v-for="t in tools"
        :key="t.key"
        size="tiny"
        quaternary
        :type="t.active() ? 'primary' : 'default'"
        :title="t.title"
        @click="t.run()"
      >
        <div v-if="t.icon" :class="t.icon" class="text-13px" />
        <span v-else class="text-12px font-bold">{{ t.label }}</span>
      </NButton>
    </div>
    <div class="rt-body">
      <EditorContent :editor="editor" class="rt-content" />
    </div>
  </div>
</template>

<style scoped>
.rt-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rt-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
}
.rt-font-select {
  width: 108px;
  margin-right: 4px;
}
.rt-body {
  border: 1px solid var(--brand-border);
  border-radius: 6px;
  background: var(--brand-surface);
}
.rt-body:focus-within {
  border-color: var(--brand-primary);
}
/* tiptap 内部 DOM 无 scoped 属性，需 :deep 命中 */
.rt-content :deep(.tiptap) {
  min-height: 160px;
  max-height: 260px;
  overflow-y: auto;
  padding: 8px 10px;
  outline: none;
  font-size: 13px;
  line-height: 1.6;
  color: var(--brand-text-1);
}
.rt-content :deep(.tiptap p) {
  margin: 0.4em 0;
}
.rt-content :deep(.tiptap h1),
.rt-content :deep(.tiptap h2),
.rt-content :deep(.tiptap h3) {
  margin: 0.5em 0 0.3em;
  font-weight: 600;
}
.rt-content :deep(.tiptap ul),
.rt-content :deep(.tiptap ol) {
  padding-left: 1.4em;
  margin: 0.4em 0;
}
.rt-content :deep(.tiptap blockquote) {
  margin: 0.4em 0;
  padding-left: 0.8em;
  border-left: 3px solid var(--brand-border);
  color: var(--brand-text-3);
}
.rt-content :deep(.tiptap:focus) {
  outline: none;
}
</style>
