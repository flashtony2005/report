<script setup lang="ts">
/**
 * AiAssistantPanel —— 纯前端 AI 设计助手对话面板（右侧抽屉）。
 * 一次性问答、零后端；配置来自本地（ai-settings）。生成的模板可直接「应用到画布」。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NInput, useDialog, useMessage } from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import { isAiConfigured, readAiSettings } from '@/config/ai-settings'
import { generateTemplate } from '@/ai/generate'
import {
  REVEAL_TICK_MS,
  computeRevealStep,
  diffSelectedControls,
  parseDatasourceFields,
  resolveMode,
  templateMeta,
} from '@/design/ai/shared/ai-assistant-logic'
import type { TemplateData } from '@/types/template'
import type { AnyControl } from '@/types/control'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'open-settings'): void
}>()

const store = useDesignerStore()
const message = useMessage()
const dialog = useDialog()

interface ChatMsg {
  id: number
  role: 'user' | 'assistant'
  text: string
  template?: TemplateData<AnyControl>
  /** 选区改写模式：AI 返回的替换控件集合 */
  controls?: AnyControl[]
  error?: string
  streaming?: boolean
}

const messages = ref<ChatMsg[]>([])
const input = ref('')
const mode = ref<'create' | 'modify' | 'selected'>('create')
const dsOpen = ref(false)
const dsFields = ref('')
const streaming = ref(false)
const bodyRef = ref<HTMLElement | null>(null)
const abortRef = ref<AbortController | null>(null)
let seq = 0
let lastPrompt = ''
/** 选区改写模式：发起请求时锁定的选中控件 id，用于回包时定位替换目标 */
let lockedSelectedIds: string[] = []

/** 画布当前选中的正文控件（仅 body 控件，用于 C 选区改写） */
const selectedControls = computed<AnyControl[]>(() =>
  store.selectedIds
    .map((id) => store.controls.find((c) => c.id === id))
    .filter((c): c is AnyControl => !!c),
)
const hasSelection = computed(() => selectedControls.value.length > 0)
// 渐进呈现用的定时器句柄（流式或缓冲端点都走同一套打字动画）
let revealTimer: ReturnType<typeof setInterval> | 0 = 0

// 组件卸载（关闭抽屉）时强制清理：中止未完成的请求 + 清掉打字定时器，
// 否则流式进行中关闭面板会让 setInterval 与 fetch 泄漏、持续占用资源。
onBeforeUnmount(() => {
  abortRef.value?.abort()
  streaming.value = false
  if (revealTimer) {
    clearInterval(revealTimer)
    revealTimer = 0
  }
})

const configured = computed(() => isAiConfigured())
const currentTemplate = computed<TemplateData<AnyControl> | undefined>(() =>
  mode.value === 'modify' ? (store.buildTemplate() as TemplateData<AnyControl>) : undefined,
)
const canSend = computed(() => configured.value && !!input.value.trim() && !streaming.value)

const examples = [
  '生成一个竖向快递面单，100×150mm，标题居中，含收件人信息和条码二维码',
  '做一个 A4 销售发票，顶部公司信息，中间客户与商品表格，底部合计',
  '做一个横向会员卡，90×54mm，左侧品牌、右侧会员姓名和卡号',
]

function scrollToBottom(): void {
  nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function controlCount(tpl?: TemplateData<AnyControl>): number {
  if (!tpl) return 0
  return tpl.document.sections.reduce(
    (n, s) => n + (s.components?.length ?? 0),
    0,
  )
}
function pageSize(tpl?: TemplateData<AnyControl>): string {
  return templateMeta(tpl)
}

async function run(prompt: string): Promise<void> {
  if (!prompt.trim() || !configured.value || streaming.value) return
  // 选区丢失时回退到「新建」，避免误生成整份模板（共享逻辑）
  mode.value = resolveMode(mode.value, hasSelection.value)
  lastPrompt = prompt.trim()
  messages.value.push({ id: ++seq, role: 'user', text: lastPrompt })
  const assistant: ChatMsg = { id: ++seq, role: 'assistant', text: '', streaming: true }
  messages.value.push(assistant)
  streaming.value = true
  scrollToBottom()

  const abort = new AbortController()
  abortRef.value = abort

  // 渐进式「打字」呈现：onToken 把增量放进缓冲，由定时器按固定节奏逐段刷到可见文本。
  // 关键：即使中转/代理把 SSE 缓冲成一块（一次性吐出），也保证至少 1.6s 的可见逐字动画，
  // 不会出现「卡一下整段蹦出」；真流式端点则近乎实时跟随。
  const revealBuf = { q: '' }
  const revealTick = (): void => {
    if (revealBuf.q.length) {
      const step = computeRevealStep(revealBuf.q.length)
      assistant.text += revealBuf.q.slice(0, step)
      revealBuf.q = revealBuf.q.slice(step)
      scrollToBottom()
    }
    if (!revealBuf.q.length && !streaming.value) {
      if (revealTimer) {
        clearInterval(revealTimer)
        revealTimer = 0
      }
    }
  }
  revealTimer = setInterval(revealTick, REVEAL_TICK_MS)
  const res = await generateTemplate({
    prompt: lastPrompt,
    currentTemplate: currentTemplate.value,
    selectedControls: mode.value === 'selected' ? selectedControls.value : undefined,
    datasourceFields: dsOpen.value ? parseDatasourceFields(dsFields.value) : undefined,
    settings: readAiSettings(),
    signal: abort.signal,
    onToken: (d) => {
      revealBuf.q += d
    },
  })

  assistant.streaming = false
  if (res.ok && res.data) {
    assistant.template = res.data
  } else if (res.ok && res.controls) {
    assistant.controls = res.controls
    lockedSelectedIds = mode.value === 'selected' ? [...store.selectedIds] : []
  } else {
    assistant.error = res.error || '生成失败，请重试。'
  }
  streaming.value = false
  abortRef.value = null
  // 残留缓冲交给上面的 tick 收尾（streaming=false 后会把 buf 排空再停）
  scrollToBottom()
}

function send(): void {
  if (!canSend.value) return
  void run(input.value)
  input.value = ''
}

function sendWith(text: string): void {
  if (streaming.value || !configured.value) return
  void run(text)
}

function stop(): void {
  abortRef.value?.abort()
  streaming.value = false
  if (revealTimer) {
    clearInterval(revealTimer)
    revealTimer = 0
  }
}

function clearChat(): void {
  if (!messages.value.length) return
  dialog.warning({
    title: '清空聊天记录',
    content: '确定要清空当前对话吗？此操作不可撤销，但已应用到画布的模板不会受影响。',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: () => {
      abortRef.value?.abort()
      if (revealTimer) {
        clearInterval(revealTimer)
        revealTimer = 0
      }
      streaming.value = false
      messages.value = []
      lastPrompt = ''
    },
  })
}

function retryLast(): void {
  if (!lastPrompt) return
  void run(lastPrompt)
}

function applyTemplate(tpl: TemplateData<AnyControl>): void {
  store.loadTemplate({
    id: `ai-${Date.now()}`,
    name: 'AI 生成模板',
    data: tpl,
  })
  message.success('已应用到画布，可在编辑器中继续调整')
  emit('update:show', false)
}

/** C：把 AI 返回的控件集合替换掉原选中控件（原位改 id 的，新增的加进来，消失的删掉） */
function applySelected(controls: AnyControl[]): void {
  const diff = diffSelectedControls(controls, lockedSelectedIds)
  for (const ctrl of diff.inPlace) {
    // 原位替换：保留 id/type，合并其余字段
    store.updateControl(ctrl.id, ctrl)
  }
  for (const ctrl of diff.added) {
    // 新增控件：携带原几何 addControlOfType 会保留 left/top/width/height
    store.addControlOfType(ctrl.type, { leftMm: ctrl.left, topMm: ctrl.top }, ctrl)
  }
  // 选中集合里被 AI 删掉的控件：移除
  for (const id of diff.removedIds) {
    store.removeControl(id)
  }
  message.success(`已应用到选中控件（${diff.summary}），可在编辑器中继续微调`)
  emit('update:show', false)
}

function tryDemo(): void {
  store.loadTemplate({
    id: 'ai-demo',
    name: 'AI 示例模板',
    data: createDemoTemplate(),
  })
  message.success('已载入示例模板（无需配置即可体验）')
  emit('update:show', false)
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    send()
  }
}

watch(
  () => props.show,
  (v) => {
    if (v) scrollToBottom()
  },
)
</script>

<template>
  <NDrawer
    :show="props.show"
    :width="440"
    placement="right"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <NDrawerContent :native-scrollbar="false" :body-content-style="{ padding: 0 }">
      <template #header>
        <div class="ai-header">
          <div class="ai-header-icon"><div class="i-carbon-ai-status text-20px" /></div>
          <div class="ai-header-text">
            <div class="ai-header-title">AI 设计助手</div>
            <div class="ai-header-sub">用一句话生成精美打印模板</div>
          </div>
          <NButton
            quaternary
            size="small"
            class="ai-clear-btn"
            :disabled="!messages.length"
            @click="clearChat"
          >
            <div class="i-carbon-trash-can text-15px" />
            <span>清空</span>
          </NButton>
        </div>
      </template>

      <!-- 对话区 -->
      <div ref="bodyRef" class="ai-body">
        <!-- 空状态 -->
        <div v-if="messages.length === 0" class="ai-empty">
          <div class="ai-empty-icon"><div class="i-carbon-ai-status text-40px" /></div>
          <div class="ai-empty-title">想设计点什么？</div>
          <div class="ai-empty-desc">描述你想要的排版，我会直接画出模板布局。</div>
          <div class="ai-chips">
            <button
              v-for="ex in examples"
              :key="ex"
              class="ai-chip"
              :disabled="!configured"
              @click="sendWith(ex)"
            >
              {{ ex }}
            </button>
          </div>
        </div>

        <!-- 消息流 -->
        <div v-for="m in messages" :key="m.id" class="ai-row" :class="m.role">
          <div v-if="m.role === 'assistant'" class="ai-avatar"><div class="i-carbon-ai-status" /></div>
          <div class="ai-bubble" :class="m.role">
            <template v-if="m.role === 'user'">{{ m.text }}</template>
            <template v-else>
              <!-- 流式/思考中 -->
              <div v-if="m.streaming && !m.text" class="ai-typing">
                <span></span><span></span><span></span>
              </div>
              <div v-else class="ai-md">{{ m.text }}</div>

              <!-- 模板预览卡 -->
              <div v-if="m.template" class="ai-tpl-card">
                <div class="ai-tpl-head">
                  <div class="i-carbon-document text-16px" />
                  <span>模板已生成</span>
                  <span class="ai-tpl-meta">{{ pageSize(m.template) }} · {{ controlCount(m.template) }} 个控件</span>
                </div>
                <div class="ai-tpl-actions">
                  <NButton size="small" type="primary" @click="applyTemplate(m.template!)">应用到画布</NButton>
                  <NButton size="small" tertiary @click="retryLast">重新生成</NButton>
                </div>
              </div>

              <!-- 选区改写结果卡 -->
              <div v-if="m.controls" class="ai-tpl-card">
                <div class="ai-tpl-head">
                  <div class="i-carbon-warning-alt text-16px" />
                  <span>已生成选中部分</span>
                  <span class="ai-tpl-meta">{{ m.controls.length }} 个控件</span>
                </div>
                <div class="ai-tpl-actions">
                  <NButton size="small" type="primary" @click="applySelected(m.controls!)">替换选中控件</NButton>
                  <NButton size="small" tertiary @click="retryLast">重新生成</NButton>
                </div>
              </div>

              <div v-if="m.error" class="ai-error">
                <div class="i-carbon-warning-alt text-14px" />
                <span>{{ m.error }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 底部输入区 -->
      <template #footer>
        <div class="ai-footer">
          <div v-if="!configured" class="ai-notice">
            <div class="ai-notice-text">尚未配置 AI：在设置里填入模型地址 / Key / 模型 ID 后即可对话。</div>
            <div class="ai-notice-actions">
              <NButton size="small" type="primary" @click="emit('open-settings')">去设置</NButton>
              <NButton size="small" tertiary @click="tryDemo">试用示例</NButton>
            </div>
          </div>

          <div v-else class="ai-compose">
            <div class="ai-mode">
              <button class="ai-mode-btn" :class="{ active: mode === 'create' }" @click="mode = 'create'">
                新建
              </button>
              <button class="ai-mode-btn" :class="{ active: mode === 'modify' }" @click="mode = 'modify'">
                基于当前模板改
              </button>
              <button
                v-if="hasSelection"
                class="ai-mode-btn"
                :class="{ active: mode === 'selected' }"
                @click="mode = 'selected'"
              >
                选中部分
                <span class="ai-mode-count">{{ selectedControls.length }}</span>
              </button>
              <button class="ai-ds-btn" :class="{ active: dsOpen }" @click="dsOpen = !dsOpen">
                <div class="i-carbon-data-base text-13px" /> 数据字段
              </button>
            </div>
            <div v-if="mode === 'selected' && hasSelection" class="ai-sel-hint">
              将只改写画布上选中的 {{ selectedControls.length }} 个控件（重排 / 对齐 / 换风格）。
            </div>

            <div v-if="dsOpen" class="ai-ds-box">
              <NInput
                v-model:value="dsFields"
                type="textarea"
                size="small"
                :autosize="{ minRows: 2, maxRows: 4 }"
                placeholder="可选：填数据字段名，用逗号分隔（如 customer.name, order.total），让绑定指向真实字段"
              />
            </div>

            <div class="ai-input-row">
              <NInput
                v-model:value="input"
                type="textarea"
                size="small"
                :autosize="{ minRows: 1, maxRows: 4 }"
                placeholder="描述你想要的模板，例如：做一个 A4 收货单，顶部公司名，中间表格…"
                @keydown="onInputKey"
              />
              <NButton
                v-if="!streaming"
                type="primary"
                :disabled="!canSend"
                @click="send"
              >
                <template #icon><div class="i-carbon-send text-15px" /></template>
                发送
              </NButton>
              <NButton v-else type="error" @click="stop">
                <template #icon><div class="i-carbon-stop-filled text-14px" /></template>
                停止
              </NButton>
            </div>
            <div class="ai-hint">Enter 发送 · ⌘/Ctrl + Enter 也可 · 生成内容建议在编辑器中二次微调</div>
          </div>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.ai-header {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}
.ai-clear-btn {
  margin-left: auto;
  color: var(--brand-text-3, #8a919f);
}
.ai-clear-btn:hover:not(:disabled) {
  color: #d4380d;
}
.ai-header-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-primary, #1677ff), #6aa6ff);
}
.ai-header-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 5px;
  color: var(--brand-text-1, #1f2329);
}
.ai-header-sub {
  font-size: 12px;
  color: var(--brand-text-3, #8a919f);
}

.ai-body {
  height: 100%;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* 统一的聊天表面底色：与白色气泡形成对比，避免「只有提问才变色、上下不一致」的观感 */
  background: var(--brand-chat-bg, linear-gradient(180deg, #eef2f7 0%, #f5f8fc 100%));
}

/* 空状态 */
.ai-empty {
  margin: auto;
  text-align: center;
  max-width: 320px;
}
.ai-empty-icon {
  color: var(--brand-primary, #1677ff);
  opacity: 0.85;
}
.ai-empty-title {
  margin-top: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--brand-text-1, #1f2329);
}
.ai-empty-desc {
  margin-top: 4px;
  font-size: 13px;
  color: var(--brand-text-3, #8a919f);
}
.ai-chips {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-chip {
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--brand-border, #e5e6eb);
  background: var(--brand-surface, #fff);
  color: var(--brand-text-2, #4e5969);
  font-size: 12.5px;
  line-height: 1.4;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    transform 0.1s;
}
.ai-chip:hover:not(:disabled) {
  border-color: var(--brand-primary, #1677ff);
  color: var(--brand-primary, #1677ff);
}
.ai-chip:active:not(:disabled) {
  transform: scale(0.99);
}
.ai-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 消息行 */
.ai-row {
  display: flex;
  gap: 8px;
  max-width: 100%;
}
.ai-row.user {
  justify-content: flex-end;
}
.ai-avatar {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--brand-primary, #1677ff);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.ai-bubble {
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 86%;
}
.ai-bubble.user {
  background: var(--brand-primary, #1677ff);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.ai-bubble.assistant {
  background: var(--brand-surface, #fff);
  color: var(--brand-text-1, #1f2329);
  border: 1px solid var(--brand-border, #e5e6eb);
  border-bottom-left-radius: 4px;
}
.ai-md {
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
}

/* 打字指示器 */
.ai-typing {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  height: 18px;
}
.ai-typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand-text-3, #b0b6c0);
  animation: ai-blink 1.2s infinite ease-in-out;
}
.ai-typing span:nth-child(2) {
  animation-delay: 0.2s;
}
.ai-typing span:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes ai-blink {
  0%,
  60%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

/* 模板卡 */
.ai-tpl-card {
  margin-top: 10px;
  border: 1px solid var(--brand-border, #e5e6eb);
  border-radius: 10px;
  overflow: hidden;
  background: var(--brand-surface, #fff);
}
.ai-tpl-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: rgba(22, 119, 255, 0.06);
  color: var(--brand-text-1, #1f2329);
  font-size: 13px;
  font-weight: 500;
}
.ai-tpl-meta {
  margin-left: auto;
  font-weight: 400;
  font-size: 11.5px;
  color: var(--brand-text-3, #8a919f);
}
.ai-tpl-actions {
  display: flex;
  gap: 8px;
  padding: 10px;
}

.ai-error {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #d4380d;
  font-size: 12.5px;
}

/* 底部 */
.ai-footer {
  border-top: 1px solid var(--brand-border, #e5e6eb);
  background: var(--brand-surface, #fff);
}
.ai-notice {
  padding: 12px 14px;
}
.ai-notice-text {
  font-size: 12.5px;
  color: var(--brand-text-2, #4e5969);
  margin-bottom: 8px;
}
.ai-notice-actions {
  display: flex;
  gap: 8px;
}
.ai-compose {
  padding: 12px 14px 10px;
}
.ai-mode {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.ai-mode-btn,
.ai-ds-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--brand-border, #e5e6eb);
  background: var(--brand-surface, #fff);
  color: var(--brand-text-2, #4e5969);
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s,
    background 0.15s;
}
.ai-mode-btn.active {
  border-color: var(--brand-primary, #1677ff);
  color: var(--brand-primary, #1677ff);
  background: rgba(22, 119, 255, 0.08);
}
.ai-mode-count {
  margin-left: 4px;
  min-width: 16px;
  padding: 0 4px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  font-size: 11px;
  border-radius: 8px;
  background: var(--brand-primary, #1677ff);
  color: #fff;
}
.ai-sel-hint {
  margin: -2px 0 6px;
  font-size: 11.5px;
  color: var(--brand-text-3, #8a919f);
}
.ai-ds-btn.active {
  border-color: var(--brand-primary, #1677ff);
  color: var(--brand-primary, #1677ff);
}
.ai-ds-box {
  margin-bottom: 8px;
}
.ai-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.ai-input-row :deep(.n-input) {
  flex: 1;
}
.ai-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--brand-text-3, #a9aeb8);
}
</style>
