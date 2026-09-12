<script setup lang="ts">
/**
 * PrintDialog —— 打印配置弹窗
 *
 * 本机客户端模式对接本地打印服务（默认 http://127.0.0.1:18888，地址可在设置里覆盖）：
 *   GET  /health   判活 + 版本
 *   GET  /printers 打印机列表（能力/状态/纸盒）
 *   POST /print    推送任务
 *
 * 推送格式（2026-08-13 最终定案）：**统一推 PDF（base64）**。
 * PDF 内部位图底图默认 PNG（无损·最高清），文字/线条边缘真正锐利，打印推荐。
 * 本地客户端用 `QPrinter` 打印位图 PDF。
 * 演进：SVG（Qt 不支持 foreignObject，废弃）→ 统一 PDF（最终）。
 * 载荷由 `buildPrintPayload()` 统一构建，与预览/导出共用同一条 render 链路，保证三者一致。
 *
 * 主任铁律：无后端全链路可用 —— 客户端不可达时只是不能出纸，设计器功能不受影响。
 */
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NInputNumber,
  NModal,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  NText,
  NTooltip,
  useMessage,
} from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import { useDataSourceStore } from '@/design/stores/dataSource'
import { buildPreviewData } from '@/design/preview/preview-data'
import { usePrinterProbe } from '@/design/composables/usePrinterProbe'
import {
  buildPrintPayload,
  describePrintError,
  formatPayloadSize,
  generateJobId,
  isRawPayloadMode,
  RAW_PAYLOAD_MODE_LABELS,
  resolvePrintDpi,
  resolvePrintOrientation,
  submitPrintJob,
  type OrientationPref,
  type PrintPayloadMode,
  type PrinterInfo,
} from '@/core/print-client'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const store = useDesignerStore()
const dsStore = useDataSourceStore()
const message = useMessage()

/* ------------------------------ 打印模式 ------------------------------ */
type PrintTarget = 'local' | 'cloud'
const target = ref<PrintTarget>('local')

/**
 * 推送载荷格式：html = 自包含 HTML（客户端 QWebEngine printToPdf 矢量输出，推荐、默认）；
 * pdf = 位图 PDF（客户端 QPrinter 直打，向后兼容）；
 * esc/tsc/zpl = 净化后的画布 JSON（剔除字体样式/颜色/设计器元数据；客户端自行翻译为
 * ESC/POS / TSPL / ZPL 指令，Web 端零渲染）。
 */
const payloadMode = ref<PrintPayloadMode>('html')

/**
 * 是否内联文本字体（仅 html 模式，默认 false = 不内联、体积最小化）。
 * 客户端 Qt WebEngine 按 CSS 兜底链回退系统字体（思源黑体→微软雅黑等），CJK 单据版式两端基本一致；
 * 仅模板使用手写体/特殊字体且要求两端一致时开启。KaTeX 公式字体始终强制内联，不受此开关影响。
 */
const embedFonts = ref(false)

/* ------------------------------ 本机客户端探测（共享单例） ------------------------------ */
const {
  state: probeState,
  health: probeHealth,
  printers: localPrinters,
  defaultPrinter,
  errorText: probeError,
  baseUrl: printerBase,
  probe: runProbe,
  probeIfStale: runProbeIfStale,
} = usePrinterProbe()

/* ------------------------------ 云打印探测 ------------------------------ */
type PrinterStatus = 'checking' | 'connected' | 'disconnected'
const cloudStatus = ref<PrinterStatus>('checking')
const cloudPrinters = ref<Array<{ label: string; value: string }>>([])
const cloudError = ref('')

/* ------------------------------ 统一状态 ------------------------------ */
const printerStatus = computed<PrinterStatus>(() => {
  if (target.value === 'cloud') return cloudStatus.value
  switch (probeState.value) {
    case 'connected':
      return localPrinters.value.length > 0 ? 'connected' : 'disconnected'
    case 'disconnected':
      return 'disconnected'
    default:
      return 'checking'
  }
})

const isConnected = computed(() => printerStatus.value === 'connected')
/** 未连接时禁用下方所有配置选项（参考可看但不可选） */
const formDisabled = computed(() => !isConnected.value)

const statusTagText = computed(() => {
  switch (printerStatus.value) {
    case 'checking':
      return '检测中…'
    case 'connected':
      return target.value === 'local'
        ? `已连接 · ${localPrinters.value.length} 台打印机`
        : '已连接云打印服务'
    case 'disconnected':
      return target.value === 'local' ? '客户端不可达' : '无法连接云打印服务'
  }
})

const statusTagType = computed(() => {
  switch (printerStatus.value) {
    case 'checking':
      return 'warning' as const
    case 'connected':
      return 'success' as const
    case 'disconnected':
      return 'error' as const
  }
})

/** 未连接时的详细原因 */
const disconnectedTip = computed(() => {
  if (target.value === 'cloud') {
    return cloudError.value || '无法连接云打印服务。请检查服务地址和端口配置（设置 → 远程云打印）。'
  }
  if (probeState.value === 'connected' && localPrinters.value.length === 0) {
    return `已连上客户端（${printerBase.value}），但未枚举到任何打印机，请检查系统打印机安装情况。`
  }
  return `${probeError.value || '无法连接本机打印客户端'}。当前地址 ${printerBase.value}，可在「设置 → 本地打印」修改 IP / 端口。`
})

/* ------------------------------ 打印机列表 ------------------------------ */
const KIND_LABEL: Record<PrinterInfo['kind'], string> = {
  virtual: '虚拟',
  common: '普通',
  ticket: '票据',
}

const selectedPrinter = ref<string>('')

const printerOptions = computed(() => {
  if (target.value === 'cloud') return cloudPrinters.value
  return localPrinters.value.map((p) => ({
    label: `${p.name}${p.isDefault ? ' · 默认' : ''}${p.isOnline ? '' : '（离线）'}`,
    value: p.name,
    disabled: !p.isOnline,
  }))
})

/** 当前选中的本机打印机详情 */
const currentPrinter = computed<PrinterInfo | null>(() => {
  if (target.value !== 'local') return null
  return localPrinters.value.find((p) => p.name === selectedPrinter.value) ?? null
})

/** 选中打印机后自动收敛不支持的能力（不支持双面 → 强制单面），并默认填入该机 defaultDpi */
watch(currentPrinter, (p) => {
  if (!p) return
  if (!p.supportsDuplex) duplex.value = 'single'
  if (!p.supportsColor) color.value = 'grayscale'
  // 换打印机 → 分辨率重置为该机默认档（用户仍可手动改，提交时按 maxDpi 钳制）
  dpi.value = resolvePrintDpi(null, p)
})

/* ------------------------------ 打印任务名 ------------------------------ */
// 任务名固定取模板名（无随机），直接显示在打印机队列里，所见即所得。
const taskName = computed(() => store.templateName || '未命名模板')

/* ------------------------------ 打印参数 ------------------------------ */
const copies = ref(1)
type Duplex = 'single' | 'double'
const duplex = ref<Duplex>('single')
type ColorMode = 'color' | 'grayscale'
const color = ref<ColorMode>('grayscale')
/**
 * 纸张方向：auto=跟随模板页面设置；portrait/landscape=打印时覆盖。
 * 部分打印机纸张方向"反直觉"（模板横向、打印机却纵向出纸），故打印面板提供覆盖入口；
 * 渲染仍按模板方向出 PDF，客户端按所选方向旋转，不改文档排版。
 */
const orientation = ref<OrientationPref>('auto')
/**
 * 渲染分辨率（DPI）：PDF 按此分辨率栅格化（scale = dpi / 96），与打印机一致避免「打不准」。
 * 默认取当前打印机 defaultDpi（换打印机时重置），可手动改，提交前按 maxDpi 钳制。
 */
const dpi = ref<number | null>(null)

/** 分辨率输入上限（打印机未上报 maxDpi 时放开到 2400 常见上限） */
const dpiMax = computed(() => {
  const m = currentPrinter.value?.maxDpi ?? 0
  return m > 0 ? m : 2400
})

/** 手动输入越界时立即钳回（NInputNumber 失焦触发 update） */
watch(dpi, (v) => {
  if (v === null) return
  const clamped = resolvePrintDpi(v, currentPrinter.value)
  if (clamped !== v) dpi.value = clamped
})

/** 本次打印实际生效的 DPI（手动值优先 → 打印机 defaultDpi → 300，maxDpi 钳制） */
const effectiveDpi = computed(() => resolvePrintDpi(dpi.value, currentPrinter.value))

/* ------------------------------ 探测 ------------------------------ */

/** 本机：走共享探测单例。
 *  force=false（打开弹窗/切换目标）：probeIfStale —— 已连接 15s 内复用现有状态，
 *  避免无条件重探在客户端忙时（字体加载/打印任务）超时把连接打掉；
 *  force=true（用户手动点刷新）：强制 probe 拿最新列表。 */
async function detectLocalPrinters(force = false): Promise<void> {
  if (force) await runProbe()
  else await runProbeIfStale()
  const def = defaultPrinter.value
  if (def && !localPrinters.value.some((p) => p.name === selectedPrinter.value)) {
    selectedPrinter.value = def.name
  }
}

/** 云打印探测：从 print-settings 读配置，尝试连接远程打印服务获取打印机列表。 */
async function detectCloudPrinters(): Promise<void> {
  cloudStatus.value = 'checking'
  cloudPrinters.value = []
  cloudError.value = ''

  const settings = readCloudSettings()
  if (!settings.host) {
    cloudStatus.value = 'disconnected'
    return
  }

  const url = `${settings.host.replace(/\/+$/, '')}:${settings.port}/api/printers`
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Array<{ id: string; name: string }>
    if (data && data.length > 0) {
      cloudPrinters.value = data.map((p) => ({ label: p.name, value: p.id }))
      selectedPrinter.value = cloudPrinters.value[0]?.value || ''
      cloudStatus.value = 'connected'
    } else {
      cloudError.value = '云打印服务未返回任何打印机'
      cloudStatus.value = 'disconnected'
    }
  } catch (e) {
    cloudError.value = `无法连接 ${url}（${e instanceof Error ? e.message : String(e)}）`
    cloudStatus.value = 'disconnected'
  }
}

/** 从 localStorage 读云打印配置（复用 config/print-settings.ts 结构） */
function readCloudSettings(): { host: string; port: number } {
  try {
    const raw = localStorage.getItem('openprint:print-settings')
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        host: parsed?.remote?.host || 'http://localhost',
        port: parsed?.remote?.port || 9100,
      }
    }
  } catch {
    // ignore
  }
  return { host: 'http://localhost', port: 9100 }
}

/** 重置为默认值 */
function resetDefaults(): void {
  copies.value = 1
  duplex.value = 'single'
  color.value = 'grayscale'
  orientation.value = 'auto'
  embedFonts.value = false
  // 分辨率回打印机默认档（打印机会话期间未变时 watch 不触发，这里显式重置）
  dpi.value = currentPrinter.value ? resolvePrintDpi(null, currentPrinter.value) : null
}

/* ------------------------------ 生命周期 ------------------------------ */

watch(target, (val) => {
  if (val === 'local') void detectLocalPrinters()
  else void detectCloudPrinters()
})

watch(
  () => props.show,
  (open) => {
    if (!open) return
    resetDefaults()
    progress.value = 0
    progressStage.value = ''
    progressStatus.value = 'info'
    if (target.value === 'local') void detectLocalPrinters()
    else void detectCloudPrinters()
  },
)

/** 刷新打印机列表（手动）→ 强制重探拿最新状态 */
function refreshPrinters(): void {
  if (target.value === 'local') void detectLocalPrinters(true)
  else void detectCloudPrinters()
}

/* ------------------------------ 推送打印 ------------------------------ */

const printing = ref(false)
/** 进度条百分比（0–100），由 buildPrintPayload / submitPrintJob 的回调推进 */
const progress = ref(0)
/** 当前阶段文案（渲染中 / 生成 PDF 中 / 推送中 / 完成 / 失败） */
const progressStage = ref('')
/** 进度条状态，驱动颜色：info=进行中 / success=成功 / error=失败 */
const progressStatus = ref<'default' | 'info' | 'success' | 'error' | 'warning'>('info')

async function doPrint(): Promise<void> {
  if (!isConnected.value) {
    message.warning('打印机未连接，无法打印')
    return
  }
  if (target.value === 'cloud') {
    message.info('云打印推送尚未接入，请切换到「本机客户端」')
    return
  }
  if (printing.value) return

  printing.value = true
  progress.value = 0
  progressStatus.value = 'info'
  progressStage.value = '正在排版渲染…'
  try {
    const template = store.buildTemplate()
    const data = buildPreviewData(dsStore.activeFields)
    const payload = await buildPrintPayload(
      {
        template,
        data,
        output: {
          pageDecoration: {
            backgroundColor: store.pageSetup.backgroundColor ?? '#ffffff',
            watermark: store.pageSetup.watermark,
          },
        },
      },
      {
        mode: payloadMode.value,
        // 字体内联（仅 html 模式）：默认不内联、体积最小化；特殊字体需两端一致时打开
        embedFonts: embedFonts.value,
        // dpi 仅 pdf 模式有栅格化意义；html 模式矢量输出与分辨率无关（客户端 QPrinter 分辨率另行设置）
        ...(payloadMode.value === 'pdf' ? { dpi: effectiveDpi.value, imageType: 'png' as const } : {}),
        onProgress: (p) => {
          progress.value = p
          if (p < 30) progressStage.value = '正在排版渲染…'
          else if (p < 85)
            progressStage.value = isRawPayloadMode(payloadMode.value)
              ? `正在序列化画布 JSON（${RAW_PAYLOAD_MODE_LABELS[payloadMode.value] ?? payloadMode.value}）…`
              : payloadMode.value === 'html'
                ? embedFonts.value
                  ? '正在生成矢量 HTML（内联字体）…'
                  : '正在生成矢量 HTML…'
                : `正在生成 PDF（${effectiveDpi.value} DPI）…`
          else progressStage.value = '准备推送…'
        },
      },
    )

    progressStage.value = isRawPayloadMode(payloadMode.value)
      ? `正在推送画布 JSON（${RAW_PAYLOAD_MODE_LABELS[payloadMode.value] ?? payloadMode.value}）到打印机…`
      : payloadMode.value === 'html'
        ? '正在推送 HTML 到打印机…'
        : '正在推送 PDF 到打印机…'
    progressStatus.value = 'info'
    const res = await submitPrintJob(
      {
        jobId: generateJobId(),
        taskName: taskName.value,
        printer: selectedPrinter.value,
        format: payload.format,
        encoding: payload.encoding,
        content: payload.content,
        pages: payload.pages,
        width: payload.width,
        height: payload.height,
        copies: copies.value,
        // 方向：默认跟随模板页面设置，用户可在面板覆盖（部分打印机纸张方向反直觉）
        orientation: resolvePrintOrientation(orientation.value, store.pageSetup.orientation),
        duplex: duplex.value === 'double',
        color: color.value === 'color',
        dpi: effectiveDpi.value,
      },
      printerBase.value,
      undefined,
      (p) => {
        progress.value = p
      },
    )

    progress.value = 100
    progressStatus.value = 'success'
    progressStage.value = '打印任务已提交'
    const job = res.jobId ? ` · 任务号 ${res.jobId}` : ''
    message.success(
      `已推送到「${selectedPrinter.value}」：${payload.pages} 页 · ${payload.format.toUpperCase()} · ${formatPayloadSize(payload.bytes)} · ${copies.value} 份${job}`,
    )
    // 停留 700ms 让用户看清 100%，再关闭
    setTimeout(() => emit('update:show', false), 700)
  } catch (e) {
    progressStatus.value = 'error'
    progressStage.value = '打印失败'
    message.error(`推送失败：${describePrintError(e)}`)
  } finally {
    printing.value = false
  }
}

function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    title="打印"
    style="width: 560px; max-width: 94vw"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <!-- 打印目标切换 -->
    <div class="print-target-bar">
      <NRadioGroup v-model:value="target" class="print-target-group">
        <NRadioButton value="local">
          <div class="i-carbon-printer mr-1 inline-block text-14px align-middle" />
          本机客户端
        </NRadioButton>
        <NRadioButton value="cloud">
          <div class="i-carbon-cloud mr-1 inline-block text-14px align-middle" />
          云打印
        </NRadioButton>
      </NRadioGroup>

      <!-- 连接状态 -->
      <div class="flex items-center gap-2">
        <NSpin v-if="printerStatus === 'checking'" :size="14" />
        <NTag :type="statusTagType" size="small" round>{{ statusTagText }}</NTag>
        <NTooltip>
          <template #trigger>
            <NButton quaternary size="tiny" @click="refreshPrinters">
              <div class="i-carbon-renew text-14px" />
            </NButton>
          </template>
          重新检测打印机
        </NTooltip>
      </div>
    </div>

    <!-- 服务地址（本机模式） -->
    <div v-if="target === 'local'" class="print-base-line">
      <div class="i-carbon-plug text-13px" />
      <span>服务地址 {{ printerBase }}</span>
      <span v-if="probeHealth" class="op-70">
        · {{ probeHealth.app }} v{{ probeHealth.version }}
      </span>
    </div>

    <!-- 未连接提示 -->
    <div v-if="!isConnected && printerStatus !== 'checking'" class="print-disconnected-tip">
      <div class="i-carbon-warning text-16px" style="color: var(--brand-danger, #ef4444)" />
      <NText depth="3" class="text-12px">{{ disconnectedTip }}</NText>
    </div>

    <!-- 打印配置区域 -->
    <div class="print-form" :class="{ 'is-disabled': formDisabled }">
      <!-- 打印机选择 -->
      <div class="print-field">
        <div class="print-field-label">打印机</div>
        <div class="flex-1">
          <NSelect
            v-model:value="selectedPrinter"
            :options="printerOptions"
            size="small"
            :disabled="formDisabled"
            :placeholder="isConnected ? '选择打印机' : '未连接'"
            style="width: 100%"
          />
          <!-- 打印机能力详情 -->
          <div v-if="currentPrinter" class="printer-meta">
            <NTag size="tiny" round :type="currentPrinter.status === 'idle' ? 'success' : 'error'">
              {{ currentPrinter.status === 'idle' ? '空闲' : '异常' }}
            </NTag>
            <NTag size="tiny" round>{{ KIND_LABEL[currentPrinter.kind] }}</NTag>
            <NTag size="tiny" round>
              默认 {{ currentPrinter.defaultDpi }} / 最高 {{ currentPrinter.maxDpi }} DPI
            </NTag>
            <NTag size="tiny" round :type="currentPrinter.supportsColor ? 'info' : 'default'">
              {{ currentPrinter.supportsColor ? '支持彩色' : '仅黑白' }}
            </NTag>
            <NTag size="tiny" round :type="currentPrinter.supportsDuplex ? 'info' : 'default'">
              {{ currentPrinter.supportsDuplex ? '支持双面' : '仅单面' }}
            </NTag>
            <NTag v-if="currentPrinter.trays.length" size="tiny" round>
              纸盒：{{ currentPrinter.trays.join(' / ') }}
            </NTag>
          </div>
          <div v-if="currentPrinter?.driver" class="printer-driver">
            驱动：{{ currentPrinter.driver }}
          </div>
        </div>
      </div>

      <!-- 打印任务名（固定模板名，无随机） -->
      <div class="print-field">
        <div class="print-field-label">任务名称</div>
        <div class="print-name-preview">{{ taskName }}</div>
      </div>

      <!-- 打印份数 -->
      <div class="print-field">
        <div class="print-field-label">打印份数</div>
        <NInputNumber
          v-model:value="copies"
          size="small"
          :min="1"
          :max="99"
          button-placement="both"
          :disabled="formDisabled"
          style="width: 100px"
        />
      </div>

      <!-- 载荷格式：html=矢量（QWebEngine 矢量打印，推荐默认）；pdf=位图（QPrinter 直打）；esc/tsc/zpl=指令直通 -->
      <div v-if="target === 'local'" class="print-field">
        <div class="print-field-label">载荷格式</div>
        <NRadioGroup v-model:value="payloadMode" size="small" :disabled="formDisabled">
          <NRadioButton value="html">HTML</NRadioButton>
          <NRadioButton value="pdf">PDF</NRadioButton>
          <NRadioButton value="esc">ESC/POS</NRadioButton>
          <NRadioButton value="tsc">TSC</NRadioButton>
          <NRadioButton value="zpl">ZPL</NRadioButton>
        </NRadioGroup>
        <NTooltip>
          <template #trigger>
            <div class="i-carbon-information text-13px cursor-pointer text-brand-text-3" />
          </template>
          矢量 HTML：推送自包含 HTML 给本地客户端，由 Qt WebEngine 输出矢量 PDF（含文本层、体积小约 93%、任意 DPI 清晰）。
          位图 PDF：按所选分辨率栅格化后推送（旧模式，兼容未升级 WebEngine 的客户端）。
          ESC/POS / TSC / ZPL：把净化后的画布 JSON（剔除字体样式 / 颜色 / 设计器元数据，打印机内置字库）
          推给客户端，由客户端翻译为对应指令（票据 / 标签机，Web 端不渲染）。
        </NTooltip>
      </div>

      <!-- 字体内联（仅矢量 HTML 模式）：默认不内联，体积最小化；特殊字体需两端一致时开启 -->
      <div v-if="target === 'local' && payloadMode === 'html'" class="print-field">
        <div class="print-field-label">字体嵌入</div>
        <div class="flex flex-1 items-center gap-2">
          <NSwitch v-model:value="embedFonts" size="small" :disabled="formDisabled" />
          <NText depth="3" class="text-12px">
            {{ embedFonts ? '内联模板字体（约 700KB/页）' : '不内联 · 客户端回退系统字体（约 17KB/页）' }}
          </NText>
        </div>
        <NTooltip>
          <template #trigger>
            <div class="i-carbon-information text-13px cursor-pointer text-brand-text-3" />
          </template>
          默认不内联：客户端 Qt WebEngine 用系统字体（思源黑体→微软雅黑等）渲染，CJK 单据版式基本一致、体积最小。
          仅当模板用了手写体 / 特殊字体且要求打印端与设计端一致性时才开启。公式（KaTeX）字体始终内联，不受此开关影响。
        </NTooltip>
      </div>

      <!-- 打印分辨率（DPI）：仅位图 PDF 模式生效（矢量输出与分辨率无关） -->
      <div v-if="target === 'local' && payloadMode === 'pdf'" class="print-field">
        <div class="print-field-label">分辨率</div>
        <div class="flex flex-1 items-center gap-3">
          <NInputNumber
            v-model:value="dpi"
            size="small"
            :min="72"
            :max="dpiMax"
            :disabled="formDisabled"
            style="width: 132px"
          >
            <template #suffix>DPI</template>
          </NInputNumber>
          <NText depth="3" class="text-12px">
            PDF 按此分辨率渲染
            <template v-if="currentPrinter">
              · 该机默认 {{ currentPrinter.defaultDpi }} · 上限 {{ dpiMax }}
            </template>
          </NText>
        </div>
      </div>

      <!-- 单面/双面 -->
      <div class="print-field">
        <div class="print-field-label">双面打印</div>
        <NRadioGroup
          v-model:value="duplex"
          size="small"
          :disabled="formDisabled || currentPrinter?.supportsDuplex === false"
        >
          <NRadioButton value="single">单面</NRadioButton>
          <NRadioButton value="double">双面</NRadioButton>
        </NRadioGroup>
      </div>

      <!-- 颜色 -->
      <div class="print-field">
        <div class="print-field-label">颜色</div>
        <NRadioGroup
          v-model:value="color"
          size="small"
          :disabled="formDisabled || currentPrinter?.supportsColor === false"
        >
          <NRadioButton value="grayscale">
            <div class="i-carbon-contrast mr-1 inline-block text-14px align-middle" />
            黑白
          </NRadioButton>
          <NRadioButton value="color">
            <div class="i-carbon-color-palette mr-1 inline-block text-14px align-middle" />
            彩色
          </NRadioButton>
        </NRadioGroup>
      </div>

      <!-- 方向：默认跟随模板，可手动覆盖（部分打印机纸张方向反直觉） -->
      <div class="print-field">
        <div class="print-field-label">方向</div>
        <NRadioGroup v-model:value="orientation" size="small" :disabled="formDisabled">
          <NRadioButton value="auto">跟随模板</NRadioButton>
          <NRadioButton value="portrait">纵向</NRadioButton>
          <NRadioButton value="landscape">横向</NRadioButton>
        </NRadioGroup>
        <NTooltip>
          <template #trigger>
            <div class="i-carbon-information text-13px cursor-pointer text-brand-text-3" />
          </template>
          默认跟随模板页面设置的方向。部分打印机纸张方向与预期相反（如模板横向、打印却纵向出纸），可在此手动覆盖为纵向 / 横向；不影响文档排版，打印时由客户端旋转。
        </NTooltip>
      </div>
    </div>

    <!-- 推送格式说明 -->
    <div class="print-format-note">
      <div class="i-carbon-information text-13px" />
      <span v-if="payloadMode === 'html'">
        推送规则：渲染为<b>自包含 HTML（utf8）</b>推送，本地客户端用 Qt WebEngine 输出<b>矢量 PDF</b>——
        含文本层、清晰度与分辨率无关、体积约为位图模式的 7%。
        <template v-if="embedFonts">字体已内联、零外部引用。</template>
        <template v-else>默认不内联字体（约 17KB/页），客户端按系统字体渲染，CJK 版式基本一致。</template>
      </span>
      <span v-else-if="isRawPayloadMode(payloadMode)">
        推送规则：把<b>净化后的画布 JSON（{ version, document, data }，utf8）</b>推送给客户端，由客户端解析并翻译为
        <b>{{ RAW_PAYLOAD_MODE_LABELS[payloadMode] ?? payloadMode }}</b> 指令——Web 端零渲染；
        字体样式 / 颜色已剔除（打印机内置中文字库、单色打印），只留几何、内容、绑定、字号与对齐。
      </span>
      <span v-else>
        推送规则：文档按所选分辨率（{{ effectiveDpi }} DPI）栅格化为
        <b>PDF（base64）</b> 推送，与打印机分辨率一致，本地客户端直接打印无需重采样。
      </span>
    </div>

    <!-- 打印进度（渲染 + 推送 PDF 到打印机） -->
    <div
      v-if="printing || progressStatus === 'success' || progressStatus === 'error'"
      class="print-progress"
    >
      <n-progress
        type="line"
        :percentage="progress"
        :status="progressStatus"
        :height="12"
        :processing="printing && progress < 100"
        border-radius="6"
        indicator-placement="outside"
      />
      <div class="mt-1.5 flex items-center justify-between">
        <span class="text-12px text-brand-text-2">{{ progressStage || '处理中…' }}</span>
        <span class="text-12px tabular-nums text-brand-text-3">{{ progress }}%</span>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <NButton size="small" :disabled="printing" @click="close">取消</NButton>
        <NButton
          size="small"
          type="primary"
          :loading="printing"
          :disabled="!isConnected || printing"
          @click="doPrint"
        >
          <template #icon>
            <div class="i-carbon-printer text-14px" />
          </template>
          打印
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.print-target-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.print-target-group :deep(.n-radio-button) {
  --n-button-color: var(--brand-surface);
}

.print-base-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--brand-text-3, var(--brand-text-2));
  font-family: monospace;
}

.print-disconnected-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 16px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.print-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.print-form.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}

.print-field {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.print-field-label {
  width: 72px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--brand-text-2);
  line-height: 28px;
}

.printer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.printer-driver {
  margin-top: 4px;
  font-size: 12px;
  color: var(--brand-text-3, var(--brand-text-2));
  opacity: 0.8;
}

.print-name-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.print-name-preview {
  font-size: 13px;
  color: var(--brand-text-1);
  font-family: monospace;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--brand-surface);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

.print-format-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--brand-surface);
  font-size: 12px;
  color: var(--brand-text-2);
}

.print-progress {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--brand-surface);
}
</style>
