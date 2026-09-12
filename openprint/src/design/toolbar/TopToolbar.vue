<script setup lang="ts">
/**
 * TopToolbar —— 顶部工具栏（56px，亮/暗主题用 var(--brand-nav-*) 自适应跟随主题）
 * 左：Logo / 产品名 / 版本 / 文件菜单 / 后端模式徽标；中：模板名 + 保存状态；
 * 右：撤销重做 / 预览 / 保存 / 导出 / 主题切换 / 设置 / 头像。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NButton,
  NDropdown,
  NIcon,
  NInput,
  NModal,
  NText,
  NTooltip,
  useMessage,
  type DropdownOption,
} from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import { useUiStore } from '@/design/stores/ui'
import TemplateModal from '@/design/modals/TemplateModal.vue'
import SettingsModal from '@/design/modals/SettingsModal.vue'
import TemplateMarket from '@/design/modals/TemplateMarket.vue'
import DataImportModal from '@/design/modals/DataImportModal.vue'
import JsonViewerModal from '@/design/modals/JsonViewerModal.vue'
import PrintDialog from '@/design/modals/PrintDialog.vue'
import FlowLabelModal from '@/design/modals/FlowLabelModal.vue'
import PreviewPanel from '@/design/preview/PreviewPanel.vue'
import ExportDialog from '@/design/toolbar/ExportDialog.vue'
import AiAssistantPanel from '@/design/ai/AiAssistantPanel.vue'
import { useConfirm } from '@/design/composables/useConfirm'
import { usePrinterProbe } from '@/design/composables/usePrinterProbe'
import { createDemoTemplate, DEMO_TEMPLATE_NAME } from '@/repository/mock/data/demo-template'
import { exportTemplateFile, importTemplateFile } from '@/design/utils/template-file'
import { validateTemplate } from '@/core/spec/validator'
import {
  buildShortcutGroups,
  FILE_MENU_ITEMS,
  isMacPlatform,
  modOf,
  printerDotClass,
  printerTooltip,
  type ShortcutPlatform,
} from './shared/toolbar-logic'

const store = useDesignerStore()
const uiStore = useUiStore()
const message = useMessage()
const { confirm } = useConfirm()

const showTplModal = ref(false)
const showSaveAs = ref(false)
const showSettings = ref(false)
const showMarket = ref(false)
const showDataImport = ref(false)
const showJson = ref(false)
const showPrint = ref(false)
const showFlowLabel = ref(false)
const showAi = ref(false)
const showNewTemplate = ref(false)
const newTemplateName = ref('')
const saveAsName = ref('')
/** 中间模板名输入框，可随时改名 */
const templateNameRef = ref<{ focus: () => void; select?: () => void } | null>(null)

/** 快捷键指南弹窗 */
const showShortcuts = ref(false)
/** 可手动切换的查看平台；默认跟随当前系统 */
const platform = ref<ShortcutPlatform>(isMacPlatform() ? 'mac' : 'win')
const MOD = computed(() => modOf(platform.value))
const platformLabel = computed(() => (platform.value === 'mac' ? 'macOS' : 'Windows / Linux'))

/** 快捷键数据随所选平台重算（MOD 取自当前平台） */
const shortcutGroups = computed(() => buildShortcutGroups(MOD.value))

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/** 按 ? 也能打开快捷键指南（输入框内不触发） */
function onHelpKey(e: KeyboardEvent): void {
  if (e.key === '?' && !isTypingTarget(e.target)) {
    e.preventDefault()
    showShortcuts.value = true
  }
}

onMounted(() => window.addEventListener('keydown', onHelpKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onHelpKey))

/* --------------------------- 打印机连接自测 --------------------------- */

const {
  state: printerState,
  printers: printerList,
  health: printerHealth,
  errorText: printerError,
  baseUrl: printerBase,
  probe: runPrinterProbe,
  probeIfStale: runPrinterProbeIfStale,
} = usePrinterProbe()

/** 状态灯颜色：绿=已连接 / 红=不可达 / 黄=检测中 / 灰=未检测 */
const printerDotClassComputed = computed(() => printerDotClass(printerState.value))

/** 悬停提示：版本 + 打印机数量 / 失败原因 */
const printerTooltipComputed = computed(() =>
  printerTooltip(printerState.value, {
    app: printerHealth.value?.app,
    version: printerHealth.value?.version,
    printerCount: printerList.value.length,
    errorText: printerError.value,
    baseUrl: printerBase.value,
  }),
)

/** 启动后静默自测一次，让状态灯有初值（失败不打扰用户） */
onMounted(() => {
  void runPrinterProbeIfStale()
})

/** 点击打印按钮：先自测连接状态，再打开打印弹窗 */
async function onPrintClick(): Promise<void> {
  showPrint.value = true
  const ok = await runPrinterProbe()
  if (ok) {
    message.success(
      `打印客户端已连接：${printerHealth.value?.app ?? 'OpenPrint'} v${
        printerHealth.value?.version ?? '?'
      } · ${printerList.value.length} 台打印机`,
    )
  } else {
    message.warning(`打印客户端不可达：${printerError.value}`)
  }
}

function onTemplateName(v: string): void {
  store.templateName = v
  store.dirty = true
}

const isDark = computed(() => uiStore.effectiveTheme !== 'light')
/** SVIP 黑金主题激活态（版本号点击切换） */
const isSvip = computed(() => uiStore.effectiveTheme === 'svip')

const fileMenuOptions: DropdownOption[] = FILE_MENU_ITEMS.map((item) =>
  item.divider ? { type: 'divider' as const, key: item.key } : { label: item.label, key: item.key },
)

async function onSave(): Promise<void> {
  // 唯一持久化入口（主任定：编辑纯本地，手动保存才写存储；无后端走 localStorage）
  const result = await store.saveTemplate()
  if (result.ok) {
    message.success(store.backendMode === 'cloud' ? '模板已保存到云端' : '模板已保存到本地存储')
  } else {
    message.error(`保存失败：${result.error}`)
  }
}

async function onFileSelect(key: string): Promise<void> {
  if (key === 'new') {
    if (store.dirty && !(await confirm('当前模板有未保存改动，新建将清空画布。确定继续？'))) return
    // 先弹窗让用户输入模板名称
    newTemplateName.value = '未命名模板'
    showNewTemplate.value = true
  } else if (key === 'open') {
    showTplModal.value = true
  } else if (key === 'save') {
    void onSave()
  } else if (key === 'saveAs') {
    saveAsName.value = `${store.templateName} 副本`
    showSaveAs.value = true
  } else if (key === 'demo') {
    if (store.dirty && !(await confirm('载入示例模板将覆盖当前未保存的改动。确定继续？'))) return
    store.loadTemplate({ id: 'demo', name: DEMO_TEMPLATE_NAME, data: createDemoTemplate() })
    message.success(`已载入示例：${DEMO_TEMPLATE_NAME}`)
  } else if (key === 'importTpl') {
    void onImportTemplate()
  } else if (key === 'exportTpl') {
    onExportTemplate()
  } else if (key === 'importData') {
    showDataImport.value = true
  }
}

/** B：导出当前画布模板为 .json 文件 */
function onExportTemplate(): void {
  const data = store.buildTemplate()
  const res = validateTemplate(data)
  if (!res.valid) {
    message.error(`模板校验未通过，无法导出：${res.issues.map((i) => i.message).join('；')}`)
    return
  }
  exportTemplateFile(data, store.templateName)
  message.success(`已导出：${store.templateName}.json`)
}

/** B：从 .json 文件导入模板并载入画布 */
async function onImportTemplate(): Promise<void> {
  const data = await importTemplateFile()
  if (!data) {
    message.warning('未选择文件或文件读取失败')
    return
  }
  const res = validateTemplate(data)
  if (!res.valid) {
    message.error(`文件不是有效的模板：${res.issues.map((i) => i.message).join('；')}`)
    return
  }
  if (store.dirty && !(await confirm('导入将覆盖当前未保存的改动。确定继续？'))) return
  const name = (data as { name?: string }).name || store.templateName || '导入的模板'
  store.loadTemplate({ id: `import-${Date.now()}`, name, data })
  message.success(`已导入：${name}`)
}

/** 确认新建模板：创建空白模板并设置用户输入的名称 */
function confirmNewTemplate(): void {
  const name = newTemplateName.value.trim()
  if (!name) {
    message.warning('请输入模板名称')
    return
  }
  showNewTemplate.value = false
  store.newBlankTemplate()
  store.templateName = name
  store.dirty = false
  message.success(`已新建：${name}`)
}

/** 一键切换（☀ ↔ 🌙）：忽略 system，直接 light/dark 翻转 */
function onToggleTheme(): void {
  uiStore.toggleTheme()
}

/** 点击版本号：SVIP 黑金主题开关 */
function onToggleSvip(): void {
  uiStore.toggleSvip()
}

async function confirmSaveAs(): Promise<void> {
  const name = saveAsName.value.trim()
  if (!name) {
    message.warning('请输入模板名称')
    return
  }
  showSaveAs.value = false
  const result = await store.saveTemplateAs(name)
  if (result.ok) message.success(`已另存为：${name}`)
  else message.error(`另存为失败：${result.error}`)
}

function onPreview(): void {
  uiStore.previewOpen = true
}

function onExport(): void {
  uiStore.exportOpen = true
}
</script>

<script lang="ts">
import { h, type Component } from 'vue'
/** 图标本地函数，避免多一层 import 噪音 */
const IconSun: Component = () =>
  h('div', { class: 'i-carbon-sun text-16px' })
const IconMoon: Component = () =>
  h('div', { class: 'i-carbon-moon text-16px' })
const IconChevronDown: Component = () =>
  h('div', { class: 'i-carbon-chevron-down text-12px' })
</script>

<template>
  <header
    class="toolbar-root flex h-56px items-center justify-between px-4"
    :class="isDark ? 'dark' : 'light'"
  >
    <!-- 左：品牌 + 文件菜单 + 后端模式徽标 -->
    <div class="flex items-center gap-3">
      <div class="logo-circle">
        <img src="@/assets/logo.png" alt="OpenPrint" class="logo-img" />
      </div>
      <span class="product-name">OpenPrint</span>
      <NTooltip>
        <template #trigger>
          <span
            class="version-tag"
            :class="{ 'is-svip': isSvip }"
            role="button"
            tabindex="0"
            @click="onToggleSvip"
            @keydown.enter="onToggleSvip"
          >
            {{ isSvip ? 'SVIP' : 'v2.0.0' }}
          </span>
        </template>
        {{ isSvip ? 'SVIP 黑金主题 · 点击退出' : '点击切换 SVIP 黑金主题' }}
      </NTooltip>

      <NDropdown :options="fileMenuOptions" @select="onFileSelect">
        <span class="file-menu-trigger">
          <span>文件</span>
          <span class="ml-1 inline-flex items-center">
            <n-icon size="14"><IconChevronDown /></n-icon>
          </span>
        </span>
      </NDropdown>

      <!-- 模板市场 -->
      <NButton
        size="small"
        ghost
        class="toolbar-ghost-btn"
        style="margin-left: 8px"
        @click="showMarket = true"
      >
        <div class="i-carbon-store mr-1 text-14px" />
        模板市场
      </NButton>

      <!-- 流水标签批量打印 -->
      <NButton
        size="small"
        ghost
        class="toolbar-ghost-btn"
        style="margin-left: 8px"
        @click="showFlowLabel = true"
      >
        <div class="i-carbon-tag mr-1 text-14px" />
        流水标签
      </NButton>

      <NTooltip>
        <template #trigger>
          <span
            class="backend-tag"
            :class="store.backendMode === 'cloud' ? 'is-cloud' : 'is-local'"
          >
            <div :class="store.backendMode === 'cloud' ? 'i-carbon-cloud' : 'i-carbon-document'" />
            {{ store.backendMode === 'cloud' ? '云端' : '本地存储' }}
          </span>
        </template>
        {{
          store.backendMode === 'cloud'
            ? '已接入后端接口（VITE_OPENPRINT_API_BASE）'
            : '未配置后端，使用本地存储 / 内置 Mock 数据源（主任铁律）'
        }}
      </NTooltip>
    </div>

    <!-- 中：模板名（可随时编辑） -->
    <div class="flex min-w-180px items-center">
      <NInput
        ref="templateNameRef"
        size="small"
        :value="store.templateName"
        placeholder="请输入模板名称"
        :bordered="false"
        class="tpl-name-input"
        @update:value="onTemplateName"
      />
    </div>

    <!-- 右：操作区 -->
    <div class="flex items-center gap-2">
      <!-- 撤销 -->
      <NTooltip>
        <template #trigger>
          <NButton
            quaternary
            size="small"
            class="toolbar-icon-btn"
            :disabled="!store.canUndo"
            @click="store.undo()"
          >
            <div class="i-carbon-undo text-16px" />
          </NButton>
        </template>
        撤销（Ctrl+Z）
      </NTooltip>
      <!-- 重做 -->
      <NTooltip>
        <template #trigger>
          <NButton
            quaternary
            size="small"
            class="toolbar-icon-btn"
            :disabled="!store.canRedo"
            @click="store.redo()"
          >
            <div class="i-carbon-redo text-16px" />
          </NButton>
        </template>
        重做（Ctrl+Shift+Z）
      </NTooltip>

      <div class="toolbar-sep" />

      <!-- 主题一键切换（☀ / 🌙） -->
      <NTooltip>
        <template #trigger>
          <NButton quaternary size="small" class="toolbar-icon-btn" @click="onToggleTheme">
            <div v-if="isDark" class="i-carbon-sun text-16px" />
            <div v-else class="i-carbon-moon text-16px" />
          </NButton>
        </template>
        切换主题：{{ isDark ? '当前深色，点击切浅色' : '当前浅色，点击切深色' }}
      </NTooltip>

      <div class="toolbar-sep" />

      <!-- 页边距参考线开关 -->
      <NTooltip>
        <template #trigger>
          <NButton
            quaternary
            size="small"
            class="toolbar-icon-btn"
            :type="uiStore.showMarginGuides ? 'primary' : 'default'"
            @click="uiStore.toggleMarginGuides()"
          >
            <div class="i-carbon-grid text-16px" />
          </NButton>
        </template>
        页边距参考线：{{ uiStore.showMarginGuides ? '显示中' : '已隐藏' }}
      </NTooltip>

      <div class="toolbar-sep" />

      <NButton size="small" ghost class="toolbar-ghost-btn" @click="onPreview">预览</NButton>
      <NButton size="small" type="primary" @click="onSave">保存</NButton>
      <NButton size="small" ghost class="toolbar-ghost-btn" @click="onExport">导出</NButton>

      <!-- 打印按钮（右上角状态灯：绿=已连接 / 红=不可达 / 黄=检测中 / 灰=未检测） -->
      <NTooltip>
        <template #trigger>
          <NButton
            quaternary
            size="small"
            class="toolbar-icon-btn printer-btn"
            @click="onPrintClick"
          >
            <div class="i-carbon-printer text-16px" />
            <span class="printer-dot" :class="printerDotClass" />
          </NButton>
        </template>
        {{ printerTooltipComputed }}
      </NTooltip>

      <!-- JSON 查看 -->
      <NTooltip>
        <template #trigger>
          <NButton quaternary size="small" class="toolbar-icon-btn" @click="showJson = true">
            <div class="i-carbon-code text-16px" />
          </NButton>
        </template>
        查看画布 JSON
      </NTooltip>

      <!-- 快捷键指南 -->
      <NTooltip>
        <template #trigger>
          <NButton quaternary size="small" class="toolbar-icon-btn" @click="showShortcuts = true">
            <div class="i-carbon-keyboard text-16px" />
          </NButton>
        </template>
        快捷键指南（?）
      </NTooltip>

      <!-- AI 设计助手 -->
      <NTooltip>
        <template #trigger>
          <NButton quaternary size="small" class="toolbar-icon-btn" @click="showAi = true">
            <div class="i-carbon-ai-status text-16px" />
          </NButton>
        </template>
        AI 设计助手
      </NTooltip>

      <div class="toolbar-sep" />

      <NButton quaternary size="small" class="toolbar-icon-btn" @click="showSettings = true">
        <div class="i-carbon-settings text-16px" />
      </NButton>
    </div>

    <!-- 模板管理弹窗 -->
    <TemplateModal v-model:show="showTplModal" />

    <!-- 全局设置弹窗（本地打印 / 远程云打印） -->
    <SettingsModal v-model:show="showSettings" />

    <!-- 模板市场弹窗 -->
    <TemplateMarket v-model:show="showMarket" />

    <!-- 导入数据弹窗 -->
    <DataImportModal v-model:show="showDataImport" />

    <!-- 多页预览面板 -->
    <PreviewPanel v-model:show="uiStore.previewOpen" />

    <!-- 四格式导出对话框 -->
    <ExportDialog v-model:show="uiStore.exportOpen" />

    <!-- JSON 数据查看器 -->
    <JsonViewerModal v-model:show="showJson" />

    <!-- 打印对话框 -->
    <PrintDialog v-model:show="showPrint" />

    <!-- 流水标签批量打印工作台 -->
    <FlowLabelModal v-model:show="showFlowLabel" />

    <!-- AI 设计助手面板 -->
    <AiAssistantPanel v-model:show="showAi" @open-settings="showSettings = true" />

    <!-- 快捷键指南弹窗 -->
    <NModal
      v-model:show="showShortcuts"
      preset="card"
      title="快捷键指南"
      style="width: 560px; max-width: 92vw"
    >
      <template #header-extra>
        <div class="shortcuts-platform-toggle">
          <button
            type="button"
            class="platform-tab"
            :class="{ active: platform === 'mac' }"
            @click="platform = 'mac'"
          >
            macOS
          </button>
          <button
            type="button"
            class="platform-tab"
            :class="{ active: platform === 'win' }"
            @click="platform = 'win'"
          >
            Windows
          </button>
        </div>
      </template>
      <div class="shortcuts-body">
        <section v-for="group in shortcutGroups" :key="group.title" class="shortcuts-group">
          <h4 class="shortcuts-group-title">{{ group.title }}</h4>
          <ul class="shortcuts-list">
            <li v-for="(item, i) in group.items" :key="i" class="shortcuts-row">
              <span class="shortcuts-keys">
                <template v-for="(k, ki) in item.keys" :key="ki">
                  <kbd class="kbd">{{ k }}</kbd>
                  <span v-if="ki < item.keys.length - 1" class="kbd-plus">+</span>
                </template>
              </span>
              <span class="shortcuts-desc">
                {{ item.desc }}
                <span v-if="item.hint" class="shortcuts-hint">（{{ item.hint }}）</span>
              </span>
            </li>
          </ul>
        </section>
        <p class="shortcuts-foot">提示：在画布任意处按 <kbd class="kbd">?</kbd> 可随时唤起本指南。</p>
      </div>
    </NModal>

    <!-- 另存为弹窗 -->
    <NModal
      v-model:show="showSaveAs"
      preset="card"
      title="另存为"
      style="width: 420px; max-width: 92vw"
    >
      <div class="flex flex-col gap-2">
        <NText depth="3" class="text-12px">将以新名称保存一份独立副本。</NText>
        <NInput v-model:value="saveAsName" placeholder="请输入模板名称" @keyup.enter="confirmSaveAs" />
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <NButton size="small" @click="showSaveAs = false">取消</NButton>
          <NButton size="small" type="primary" @click="confirmSaveAs">保存副本</NButton>
        </div>
      </template>
    </NModal>

    <!-- 新建模板弹窗 -->
    <NModal
      v-model:show="showNewTemplate"
      preset="card"
      title="新建模板"
      style="width: 420px; max-width: 92vw"
    >
      <div class="flex flex-col gap-2">
        <NText depth="3" class="text-12px">请输入模板名称，创建空白画布。</NText>
        <NInput
          v-model:value="newTemplateName"
          placeholder="请输入模板名称"
          @keyup.enter="confirmNewTemplate"
        />
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <NButton size="small" @click="showNewTemplate = false">取消</NButton>
          <NButton size="small" type="primary" @click="confirmNewTemplate">创建</NButton>
        </div>
      </template>
    </NModal>
  </header>
</template>

<style scoped>
/* ================= 工具栏 —— 亮/暗都走 CSS 变量，跟随主题 ================= */
.toolbar-root {
  background: var(--brand-nav-bg);
  color: var(--brand-nav-text);
  border-bottom: 1px solid var(--brand-border);
}

/* 品牌 logo —— 保持图片原格式（透明就透明），不加背景色 */
.logo-circle {
  height: 28px;
  width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.logo-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.product-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--brand-nav-text-active);
}

.version-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: 0.2px;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-primary), color-mix(in srgb, var(--brand-primary) 70%, #0b1c3a));
  border: none;
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
  transition: filter 0.15s;
}
.version-tag:hover {
  filter: brightness(1.15);
}
/* SVIP 黑金激活态：金色渐变文字（#FFB95A → #E4A93C → #B87100）+ 深炭底 + 金描边 */
.version-tag.is-svip {
  color: transparent;
  background: #2b2e31;
  background-image: linear-gradient(135deg, #ffb95a 0%, #e4a93c 55%, #b87100 100%);
  background-clip: text;
  -webkit-background-clip: text;
  border: 1px solid rgba(228, 169, 60, 0.55);
  box-shadow: 0 0 8px rgba(228, 169, 60, 0.25);
  letter-spacing: 0.5px;
}
.version-tag.is-svip:hover {
  filter: brightness(1.2);
}

/* 文件菜单触发器 */
.file-menu-trigger {
  margin-left: 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--brand-nav-icon);
  transition:
    color 0.15s,
    background 0.15s;
}
.file-menu-trigger:hover {
  color: var(--brand-nav-icon-hover);
  background: var(--brand-nav-bg-hover);
}

/* 后端模式徽标 */
.backend-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
}
.backend-tag.is-cloud {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}
.backend-tag.is-local {
  background: var(--brand-nav-bg-hover);
  color: var(--brand-nav-text-muted);
}

/* 中间模板名（内联可编辑，去边框呈标题样式） */
.tpl-name-input {
  --n-color: var(--brand-nav-text-active);
  --n-text-color: var(--brand-nav-text-active);
  --n-caret-color: var(--brand-nav-text-active);
  --n-font-size: 14px;
  --n-font-weight: 500;
  --n-padding: 0;
  --n-text-align: center;
  max-width: 200px;
}
.tpl-name-input :deep(.n-input__input-el) {
  text-align: center;
  font-weight: 500;
}

/* 图标按钮（quaternary → 用 nav 配色保证在深色导航上可读） */
.toolbar-icon-btn {
  color: var(--brand-nav-icon) !important;
}
.toolbar-icon-btn:hover:not(:disabled) {
  color: var(--brand-nav-icon-hover) !important;
  background: var(--brand-nav-bg-hover) !important;
}
.toolbar-icon-btn:disabled {
  opacity: 0.4;
}

  /* 幽灵按钮（在深导航上：浅色下 white 边框/文字，暗色下边框同 muted） */
.toolbar-ghost-btn {
  --n-text-color: var(--brand-nav-icon);
  --n-text-color-hover: var(--brand-nav-icon-hover);
  --n-border: 1px solid var(--brand-nav-text-muted);
  --n-border-hover: 1px solid var(--brand-nav-icon-hover);
  --n-color-hover: var(--brand-nav-bg-hover);
}

/* 分隔线 */
.toolbar-sep {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--brand-border);
}

/* ================= 快捷键指南弹窗 ================= */
/* 平台分段切换（macOS / Windows 互看） */
.shortcuts-platform-toggle {
  display: inline-flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--brand-bg-hover, rgba(128, 128, 128, 0.12));
  border: 1px solid var(--brand-border, #e5e5e5);
}
.platform-tab {
  appearance: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 4px 10px;
  border-radius: 5px;
  color: var(--brand-text-muted, #888);
  background: transparent;
  transition:
    color 0.15s,
    background 0.15s;
}
.platform-tab:hover {
  color: var(--brand-text, #333);
}
.platform-tab.active {
  color: #fff;
  background: var(--brand-primary, #3b82f6);
  font-weight: 600;
}

.shortcuts-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.shortcuts-group-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand-text, inherit);
}

.shortcuts-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.shortcuts-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 28px;
}

.shortcuts-keys {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 168px;
}

.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1;
  color: var(--brand-text, #333);
  background: var(--brand-bg-hover, #f5f5f5);
  border: 1px solid var(--brand-border, #e0e0e0);
  border-bottom-width: 2px;
  border-radius: 5px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
}

.kbd-plus {
  font-size: 11px;
  color: var(--brand-text-muted, #aaa);
}

.shortcuts-desc {
  font-size: 13px;
  color: var(--brand-text, inherit);
}

.shortcuts-hint {
  font-size: 12px;
  color: var(--brand-text-muted, #999);
}

.shortcuts-foot {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--brand-text-muted, #999);
  border-top: 1px dashed var(--brand-border, #eee);
  padding-top: 12px;
}

/* ================= 打印按钮连接状态灯 ================= */
.printer-btn {
  position: relative;
}

.printer-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid var(--brand-nav-bg, #fff);
  background: #9ca3af;
  transition: background 0.2s;
}

.printer-dot.is-connected {
  background: #22c55e;
  box-shadow: 0 0 4px rgba(34, 197, 94, 0.7);
}

.printer-dot.is-disconnected {
  background: #ef4444;
  box-shadow: 0 0 4px rgba(239, 68, 68, 0.7);
}

.printer-dot.is-checking {
  background: #f59e0b;
  animation: printer-dot-pulse 1s ease-in-out infinite;
}

.printer-dot.is-idle {
  background: #9ca3af;
}

@keyframes printer-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
