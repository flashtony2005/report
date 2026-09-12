<script setup lang="ts">
/**
 * SettingsModal —— 全局设置弹窗（naive-ui Modal + 左侧功能栏 + 右侧配置区）
 * 目前两个配置页：本地打印 / 远程云打印（配置存 localStorage，见 config/print-settings.ts）。
 */
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import {
  DEFAULT_PRINT_SETTINGS,
  readPrintSettings,
  writePrintSettings,
  type PrintSettings,
} from '@/config/print-settings'
import {
  buildPrinterBase,
  FACTORY_PRINTER_BASE_URL,
} from '@/config/printer'
import { checkHealth, listPrinters, describePrintError } from '@/core/print-client'
import {
  readAiSettings,
  writeAiSettings,
  AI_PROVIDER_PRESETS,
  type AiSettings,
} from '@/config/ai-settings'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const message = useMessage()

/* ------------------------------ 功能栏 ------------------------------ */

type NavKey = 'local' | 'remote' | 'ai' | 'feedback' | 'group' | 'tutorial'
const activeKey = ref<NavKey>('local')

const NAV_ITEMS: Array<{ key: NavKey; label: string; icon: string; desc: string }> = [
  { key: 'local', label: '本地打印', icon: 'i-carbon-printer', desc: '浏览器直接打印 / 静默后台打印' },
  { key: 'remote', label: '远程云打印', icon: 'i-carbon-cloud-upload', desc: '通过远程打印服务出纸' },
  { key: 'ai', label: 'AI 助手', icon: 'i-carbon-ai-status', desc: '用自然语言生成打印模板' },
  { key: 'tutorial', label: '在线教程', icon: 'i-carbon-book', desc: 'Bilibili 视频教程，点击跳转学习' },
  { key: 'feedback', label: '功能反馈', icon: 'i-carbon-chat', desc: '改进建议 / 新功能需求' },
  { key: 'group', label: '交流群', icon: 'i-carbon-group', desc: '扫码加入 QQ 交流群' },
]

/* ------------------------------ 在线教程 ------------------------------ */

/**
 * Bilibili 教程视频列表。每条会作为可点击卡片展示，点击在新标签打开对应 Bilibili 视频。
 * 用户可在此基础上自由增删条目（替换 url 为真实地址即可）。
 */
const TUTORIAL_VIDEOS: Array<{ title: string; url: string; desc: string }> = [
  {
    title: 'OpenPrint 快速上手（示例）',
    url: 'https://www.bilibili.com/video/BV1Hpby6TEJd/?vd_source=b6609163a4dfc54e5a72aa82dc425198#reply311269612161',
    desc: '从打开设计器到打印出第一张单据的完整流程。',
  },
  {
    title: '模板设计与表格排版（示例）',
    url: 'https://www.bilibili.com/video/BV1Hpby6TEJd/?vd_source=b6609163a4dfc54e5a72aa82dc425198#reply311269612161',
    desc: '讲解表格、数据源绑定与表达式的进阶用法。',
  },
  {
    title: '本地打印客户端配置（示例）',
    url: 'https://www.bilibili.com/video/BV1Hpby6TEJd/?vd_source=b6609163a4dfc54e5a72aa82dc425198#reply311269612161',
    desc: '安装 Qprint 客户端并开启静默打印。',
  },
]

/** 在新标签打开外部链接（Bilibili 视频等） */
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener')
}



/* ------------------------------ 配置模型 ------------------------------ */

const settings = ref<PrintSettings>(readPrintSettings())

watch(
  settings,
  (v) => writePrintSettings(v),
  { deep: true },
)

/* ------------------------------ AI 助手配置 ------------------------------ */

const ai = ref<AiSettings>(readAiSettings())

watch(
  ai,
  (v) => writeAiSettings(v),
  { deep: true },
)

function applyPreset(p: { baseURL: string; model: string }): void {
  ai.value.baseURL = p.baseURL
  ai.value.model = p.model
}

function resetAll(): void {
  settings.value = structuredClone(DEFAULT_PRINT_SETTINGS)
  message.success('已恢复默认设置')
}

function close(): void {
  emit('update:show', false)
}

/* ------------------------------ 交流群 ------------------------------ */

/** 在新标签打开 QQ 群二维码大图 */
function openQrLarge(): void {
  window.open('/qqgroup.jpg', '_blank', 'noopener')
}

/* --------------------------- 远程连接测试 --------------------------- */

const testing = ref(false)
async function testRemote(): Promise<void> {
  const { host, port, enabled } = settings.value.remote
  if (!enabled) {
    message.warning('请先开启「启用远程云打印」')
    return
  }
  const url = `${host.replace(/\/+$/, '')}:${port}/`
  testing.value = true
  try {
    // 主动连接探测：用户手动触发，不受"零网络依赖"约束
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) })
    message.success(`服务可达（HTTP ${res.status}）`)
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? '连接超时' : '无法连接'
    message.warning(`${reason}：${url}（请确认服务已启动，或存在 CORS 限制）`)
  } finally {
    testing.value = false
  }
}

/* --------------------------- 本地打印客户端连接测试 --------------------------- */

/** 当前设置面板里填出来的基地址（实时预览，未保存也能看到） */
const localBase = computed(() =>
  buildPrinterBase(settings.value.local.silent.host, settings.value.local.silent.port),
)

const testingLocal = ref(false)
type LocalTest = { ok: boolean; text: string }
const localTestResult = ref<LocalTest | null>(null)

/** 自测本地打印客户端：/health 拿版本 → /printers 拿数量 */
async function testLocalClient(): Promise<void> {
  const base = localBase.value || FACTORY_PRINTER_BASE_URL
  testingLocal.value = true
  localTestResult.value = null
  try {
    const health = await checkHealth(base)
    let count = health.printers
    try {
      count = (await listPrinters(base)).length
    } catch {
      /* 打印机枚举失败不影响健康判定，沿用 health.printers */
    }
    localTestResult.value = {
      ok: true,
      text: `连接正常 · ${health.app} v${health.version} · ${count} 台打印机`,
    }
    message.success(`打印客户端已连接（${count} 台打印机）`)
  } catch (e) {
    const reason = describePrintError(e)
    localTestResult.value = { ok: false, text: `${reason}（${base}）` }
    message.warning(reason)
  } finally {
    testingLocal.value = false
  }
}

/** 恢复出厂地址 127.0.0.1:18888 */
function resetLocalEndpoint(): void {
  settings.value.local.silent.host = '127.0.0.1'
  settings.value.local.silent.port = 18888
  localTestResult.value = null
  message.success('已恢复出厂地址 127.0.0.1:18888')
}

/**
 * 客户端下载：指向项目 public/Qprint.exe，点击直接下载（不跳页）。
 * 文件由用户放入 public/ 目录，Vite 会原样发布到站点根 /Qprint.exe。
 */
async function onDownloadClient(): Promise<void> {
  const url = '/Qprint.exe'
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) throw new Error('not found')
  } catch {
    message.warning('未找到客户端安装包，请确认已将 Qprint.exe 放到 public/ 目录')
    return
  }
  const a = document.createElement('a')
  a.href = url
  a.download = 'Qprint.exe'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/* ------------------------------ 功能反馈 ------------------------------ */

const FEEDBACK_EMAIL = 'haiming236@outlook.com'
const FEEDBACK_WECHAT = 'wmcxsj'
const feedbackText = ref('')
const feedbackContact = ref('')

/** 通过邮件提交反馈（纯前端 mailto，无需后端） */
function sendFeedbackMail(): void {
  const text = feedbackText.value.trim()
  if (!text) {
    message.warning('请先填写反馈内容')
    return
  }
  const contact = feedbackContact.value.trim()
  const body = `${text}${contact ? `\n\n—— 联系方式：${contact}` : ''}`
  const subject = encodeURIComponent('OpenPrint 功能反馈')
  window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${encodeURIComponent(body)}`
  feedbackText.value = ''
  feedbackContact.value = ''
  message.success('已打开邮件客户端，请发送反馈（收件人已预填）')
}

function copyToClipboard(value: string, label: string): void {
  navigator.clipboard?.writeText(value).then(
    () => message.success(`已复制${label}：${value}`),
    () => message.error('复制失败，请手动复制'),
  )
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    title="设置"
    style="width: 640px; max-width: 94vw"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="flex h-400px gap-4">
      <!-- 左侧功能栏 -->
      <div class="w-150px flex-shrink-0 border-r border-brand-border pr-3">
        <div
          v-for="item in NAV_ITEMS"
          :key="item.key"
          class="settings-nav-item"
          :class="{ 'is-active': activeKey === item.key }"
          @click="activeKey = item.key"
        >
          <div :class="item.icon" class="text-16px" />
          <span class="text-13px">{{ item.label }}</span>
        </div>
      </div>

      <!-- 右侧配置区 -->
      <div class="min-w-0 flex-1 overflow-y-auto">
        <!-- 本地打印 -->
        <div v-if="activeKey === 'local'" class="flex flex-col gap-4">
          <div>
            <div class="config-title">打印方式</div>
            <NSelect
              v-model:value="settings.local.method"
              size="small"
              :options="[
                { label: '浏览器直接打印（弹出打印对话框）', value: 'browser' },
                { label: '客户端打印（静默打印，自动出纸）', value: 'silent' },
              ]"
            />
            <NText depth="3" class="block text-12px mt-1">
              直接打印使用浏览器内置打印对话框；客户端打印自动出纸，无需手动确认。
            </NText>
          </div>

          <!-- 打印客户端服务地址（/health · /printers · /print 共用） -->
          <div class="rounded-8px border border-brand-border bg-brand-surface p-3">
            <div class="mb-2 flex items-center justify-between">
              <div class="config-title" style="margin-bottom: 0">打印客户端服务地址</div>
              <NButton text size="tiny" @click="resetLocalEndpoint">恢复出厂 18888</NButton>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="config-label">客户端 IP 地址</div>
                <NInput
                  v-model:value="settings.local.silent.host"
                  size="small"
                  placeholder="127.0.0.1"
                />
              </div>
              <div>
                <div class="config-label">端口</div>
                <NInputNumber
                  v-model:value="settings.local.silent.port"
                  size="small"
                  :min="1"
                  :max="65535"
                  placeholder="18888"
                  style="width: 100%"
                />
              </div>
            </div>

            <div class="mt-2 flex items-center gap-2">
              <NButton size="small" secondary :loading="testingLocal" @click="testLocalClient">
                <template #icon>
                  <div class="i-carbon-plug text-14px" />
                </template>
                测试连接
              </NButton>
              <NTag v-if="localTestResult" size="small" round :type="localTestResult.ok ? 'success' : 'error'">
                {{ localTestResult.text }}
              </NTag>
            </div>

            <NText depth="3" class="block text-12px mt-2">
              当前生效：<b>{{ localBase || FACTORY_PRINTER_BASE_URL }}</b>
              —— 打印机探测（/health、/printers）与任务推送（/print）都走这个地址。
            </NText>
            <NText depth="3" class="block text-12px mt-1">
              出厂默认 {{ FACTORY_PRINTER_BASE_URL }}；可手动改为局域网地址（客户端已支持局域网打印），
              手动填写的地址优先级最高。
            </NText>
          </div>

          <!-- 客户端下载：指向 public/Qprint.exe，点击直接下载 -->
          <div class="rounded-8px border border-brand-border bg-brand-surface p-3">
            <div class="config-title mb-1">本地打印客户端</div>
            <NText depth="3" class="block text-12px mb-2">
              下载并安装 Qprint 客户端后即可开启「客户端静默打印」。安装包随站点发布于 public/Qprint.exe。
            </NText>
            <NButton size="small" type="primary" secondary @click="onDownloadClient">
              <template #icon>
                <div class="i-carbon-download text-14px" />
              </template>
              下载客户端（Qprint.exe）
            </NButton>
          </div>

          <div class="flex items-center justify-between">
            <span class="config-label">副本数</span>
            <NInputNumber
              v-model:value="settings.local.copies"
              size="small"
               button-placement="both"
              :min="1"
              :max="99"
              style="width: 120px"
            />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="config-label">打印后关闭预览窗口</div>
              <NText depth="3" class="text-12px">打印完成后自动关闭预览面板</NText>
            </div>
            <NSwitch v-model:value="settings.local.closeAfterPrint" />
          </div>
        </div>

        <!-- 远程云打印 -->
        <div v-else-if="activeKey === 'remote'" class="flex flex-col gap-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="config-label">启用远程云打印</div>
              <NText depth="3" class="text-12px">通过远程打印服务把文档发送到指定打印机</NText>
            </div>
            <NSwitch v-model:value="settings.remote.enabled" />
          </div>

          <div class="grid grid-cols-1 gap-3">
            <div>
              <div class="config-label">服务地址</div>
              <NInput
                v-model:value="settings.remote.host"
                size="small"
                placeholder="http://127.0.0.1"
                :disabled="!settings.remote.enabled"
              />
            </div>
            <div class="flex gap-3">
              <div class="w-130px">
                <div class="config-label">端口</div>
                <NInputNumber
                  v-model:value="settings.remote.port"
                  size="small"
                   button-placement="both"
                  :min="1"
                  :max="65535"
                  style="width: 100%"
                  :disabled="!settings.remote.enabled"
                />
              </div>
              <div class="flex-1">
                <div class="config-label">打印机名（可选）</div>
                <NInput
                  v-model:value="settings.remote.printer"
                  size="small"
                  placeholder="留空使用服务默认打印机"
                  :disabled="!settings.remote.enabled"
                />
              </div>
            </div>
          </div>

          <div>
            <NButton
              size="small"
              secondary
              :loading="testing"
              :disabled="!settings.remote.enabled"
              @click="testRemote"
            >
              测试连接
            </NButton>
          </div>
        </div>

        <!-- AI 助手 -->
        <div v-else-if="activeKey === 'ai'" class="flex flex-col gap-4">
          <div class="rounded-8px border border-brand-border bg-brand-surface p-3">
            <div class="config-title mb-1">AI 助手（纯前端直连，零后端）</div>
            <NText depth="3" class="block text-12px">
              配置你自己的大模型服务（OpenAI 兼容格式）。Key 仅保存在本机浏览器，不会上传服务器。
            </NText>
            <div class="ai-presets mt-2 flex flex-wrap gap-2">
              <NButton
                v-for="p in AI_PROVIDER_PRESETS"
                :key="p.label"
                size="tiny"
                secondary
                @click="applyPreset(p)"
              >
                {{ p.label }}
              </NButton>
            </div>
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="config-label">启用 AI 助手</div>
              <NText depth="3" class="text-12px">关闭后顶部 AI 入口与对话将不可用</NText>
            </div>
            <NSwitch v-model:value="ai.enabled" />
          </div>

          <div>
            <div class="config-label">接口地址（baseURL）</div>
            <NInput
              v-model:value="ai.baseURL"
              size="small"
              placeholder="https://api.openai.com/v1"
            />
            <NText depth="3" class="block text-12px mt-1">
              需含 /v1；若浏览器提示跨域(CORS)，请改为你自己的代理地址。
            </NText>
          </div>

          <div>
            <div class="config-label">API Key</div>
            <NInput
              v-model:value="ai.apiKey"
              size="small"
              type="password"
              placeholder="sk-..."
              show-password-on="click"
            />
          </div>

          <div>
            <div class="config-label">模型 ID</div>
            <NInput v-model:value="ai.model" size="small" placeholder="gpt-4o-mini" />
          </div>
        </div>

      <!-- 在线教程 -->
      <div v-else-if="activeKey === 'tutorial'" class="flex flex-col gap-4">
        <div class="rounded-8px border border-brand-border bg-brand-surface p-4">
          <div class="config-title mb-1">Bilibili 视频教程</div>
          <NText depth="3" class="block text-12px mb-3">
            点击任意教程卡片，将在新标签页打开 Bilibili 视频学习如何使用 OpenPrint。
          </NText>

          <div class="flex flex-col gap-2">
            <div
              v-for="item in TUTORIAL_VIDEOS"
              :key="item.url"
              class="tutorial-card"
              @click="openExternal(item.url)"
            >
              <div class="i-carbon-play-filled tutorial-card-icon" />
              <div class="min-w-0 flex-1">
                <div class="text-13px font-medium text-brand-text-1 truncate">{{ item.title }}</div>
                <div class="text-12px text-brand-text-3 truncate">{{ item.desc }}</div>
              </div>
              <div class="i-carbon-launch text-14px text-brand-text-3" />
            </div>
          </div>
        </div>
      </div>

      <!-- 功能反馈 -->
      <div v-else-if="activeKey === 'feedback'" class="flex flex-col gap-4">
        <div class="rounded-8px border border-brand-border bg-brand-surface p-3">
          <div class="config-title mb-1">功能反馈 / 需求建议</div>
          <NText depth="3" class="block text-12px">
            欢迎对本系统的设计或功能提出改进意见，或告诉我们你需要的全新功能。提交后会通过你的邮件客户端发送，
            也可直接通过下方联系方式联系我。
          </NText>
        </div>

        <div>
          <div class="config-label">反馈内容 / 新功能需求</div>
          <NInput
            v-model:value="feedbackText"
            type="textarea"
            size="small"
            :autosize="{ minRows: 5, maxRows: 12 }"
            placeholder="例如：希望表格支持跨页重复标题、或增加某类单据模板……"
          />
        </div>

        <div>
          <div class="config-label">联系方式（可选，邮箱 / 微信皆可）</div>
          <NInput
            v-model:value="feedbackContact"
            size="small"
            placeholder="方便我们回复你，如微信 wmcxsj"
          />
        </div>

        <div class="flex items-center gap-2">
          <NButton size="small" type="primary" @click="sendFeedbackMail">
            <template #icon>
              <div class="i-carbon-email text-14px" />
            </template>
            发送邮件反馈
          </NButton>
          <NButton size="small" secondary @click="copyToClipboard(FEEDBACK_EMAIL, '邮箱')">
            复制邮箱
          </NButton>
          <NButton size="small" secondary @click="copyToClipboard(FEEDBACK_WECHAT, '微信号')">
            复制微信
          </NButton>
        </div>

        <div class="rounded-8px border border-brand-border p-3">
          <div class="config-label mb-1">直接联系</div>
          <div class="text-13px leading-6">
            邮箱：<b>{{ FEEDBACK_EMAIL }}</b>
            <NButton text size="tiny" class="ml-1" @click="copyToClipboard(FEEDBACK_EMAIL, '邮箱')">复制</NButton>
          </div>
          <div class="text-13px leading-6">
            微信：<b>{{ FEEDBACK_WECHAT }}</b>
            <NButton text size="tiny" class="ml-1" @click="copyToClipboard(FEEDBACK_WECHAT, '微信号')">复制</NButton>
          </div>
        </div>
      </div>

      <!-- 交流群 -->
      <div v-else-if="activeKey === 'group'" class="flex flex-col gap-4">
        <div class="rounded-8px border border-brand-border bg-brand-surface p-4 text-center">
          <div class="config-title mb-1">QQ 交流群</div>
          <NText depth="3" class="block text-12px mb-3">
            扫码加入 OpenPrint 用户交流群，第一时间获取更新、模板与答疑。
          </NText>
          <img
            src="/qqgroup.jpg"
            alt="QQ 交流群二维码"
            class="qq-group-qr"
            @click="openQrLarge"
          />
          <div class="mt-3 flex items-center justify-center gap-2">
            <NButton size="small" secondary @click="openQrLarge">
              <template #icon>
                <div class="i-carbon-zoom-in text-14px" />
              </template>
              查看大图
            </NButton>
          </div>
          <NText depth="3" class="block text-12px mt-3">
            若二维码失效，请联系微信 <b>{{ FEEDBACK_WECHAT }}</b> 邀您入群。
          </NText>
        </div>
      </div>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-between">
        <NButton size="small" quaternary @click="resetAll">恢复默认</NButton>
        <div class="flex gap-2">
          <NButton size="small" @click="close">取消</NButton>
          <NButton size="small" type="primary" @click="close">完成</NButton>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.config-title {
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--brand-text-1);
}
.config-label {
  font-size: 13px;
  color: var(--brand-text-2);
}
.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  margin-bottom: 2px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--brand-text-2);
  transition:
    background 0.15s,
    color 0.15s;
}
.settings-nav-item:hover {
  background: var(--brand-surface-hover, rgba(128, 128, 128, 0.08));
}
.settings-nav-item.is-active {
  background: rgba(22, 119, 255, 0.12);
  color: var(--brand-primary);
}
.qq-group-qr {
  display: block;
  width: 200px;
  max-width: 100%;
  margin: 0 auto;
  border-radius: 8px;
  border: 1px solid var(--brand-border);
  background: #fff;
  cursor: zoom-in;
}
.tutorial-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--brand-border);
  background: var(--brand-surface, #f6f7f9);
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.05s;
}
.tutorial-card:hover {
  background: rgba(22, 119, 255, 0.08);
}
.tutorial-card:active {
  transform: scale(0.99);
}
.tutorial-card-icon {
  font-size: 22px;
  color: var(--brand-primary, #1677ff);
  flex-shrink: 0;
}
</style>
