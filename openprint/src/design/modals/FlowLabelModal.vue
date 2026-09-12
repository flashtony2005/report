<script setup lang="ts">
/**
 * FlowLabelModal —— 流水标签批量打印工作台
 *
 * 场景：设计好一张标签模板（页面=标签尺寸，字段绑 {{no}} 等），上传 Excel/CSV/JSON
 * （每行一条数据），逐行渲染单页 → 推送打印 → 下一行。内存恒定（永远只有 1 页），
 * 不做"100 页大 PDF"，避免内存溢出。
 *
 * 数据流：Excel → parseDataFile → 行数组 → 字段映射（{{no}} ↔ 列名）→
 * 逐行 layout(模板, 单行data) → buildPrintPayload(1页PDF) → submitPrintJob → 间隔 → 下一行
 *
 * 复用：parseDataFile / buildPrintPayload / submitPrintJob / usePrinterProbe / render（预览）
 */
import { computed, ref, watch, onUnmounted } from 'vue'
import {
  NButton,
  NInputNumber,
  NModal,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpin,
  NTag,
  NText,
  NTooltip,
  NCollapse,
  NCollapseItem,
  useMessage,
} from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import { usePrinterProbe } from '@/design/composables/usePrinterProbe'
import { parseDataFile, type ParsedData } from '@/design/utils/data-import'
import { scanTemplatePlaceholders } from '@/core/layout-engine/placeholder-scan'
import {
  FLOW_PREVIEW_ROWS,
  buildMappedRowData,
  buildPrinterOptions,
  canStartBatch,
  clampPreviewIndex,
  columnOptions,
  computeFlowStats,
  computePrintTotal,
  connHint,
  filterRows,
  formatDuration,
  mergeMapping,
  pickDefaultPrinter,
  rowSummary,
  shouldWaitInterval,
  type FlowRowResult,
} from '@/design/flow-label/shared/flow-label-logic'
import { render } from '@/core/sdk'
import {
  buildPrintPayload,
  describePrintError,
  generateJobId,
  resolvePrintDpi,
  resolvePrintOrientation,
  submitPrintJob,
  type OrientationPref,
} from '@/core/print-client'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const store = useDesignerStore()
const message = useMessage()
const fileInput = ref<HTMLInputElement | null>(null)

function triggerFileInput(): void {
  fileInput.value?.click()
}

/* ------------------------------ 数据上传 + 解析 ------------------------------ */
const parsed = ref<ParsedData | null>(null)
const deletedRows = ref<Set<number>>(new Set())
const parseError = ref('')
const parsing = ref(false)

async function onFileChange(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return
  parsing.value = true
  parseError.value = ''
  try {
    const data = await parseDataFile(file)
    parsed.value = data
    deletedRows.value = new Set()
    // 数据变了 → 重新自动映射（保留已有映射中仍存在的列）
    refreshMapping()
    previewRowIndex.value = 0
  } catch (err) {
    parseError.value = err instanceof Error ? err.message : String(err)
    parsed.value = null
  } finally {
    parsing.value = false
  }
}

/** 有效行（剔除已删行） */
const rows = computed(() =>
  parsed.value ? filterRows(parsed.value.rows, deletedRows.value) : [],
)

const PREVIEW_ROWS = FLOW_PREVIEW_ROWS

/* ------------------------------ 占位符 + 字段映射 ------------------------------ */
const placeholders = ref<string[]>([])
const mapping = ref<Record<string, string | null>>({})

function refreshPlaceholders(): void {
  const tpl = store.buildTemplate()
  placeholders.value = scanTemplatePlaceholders(tpl)
}

function refreshMapping(): void {
  if (!parsed.value) {
    mapping.value = {}
    return
  }
  // 自动映射 + 保留"列仍存在"的手动映射（共享逻辑，React 端同源）
  mapping.value = mergeMapping(placeholders.value, parsed.value.columns, mapping.value)
}

/** 构造单行数据对象：把映射的列值拍平到顶层字段（{{no}} → data.no） */
function buildRowData(row: Record<string, unknown>): Record<string, unknown> {
  return buildMappedRowData(mapping.value, row)
}

/* ------------------------------ 单页预览 ------------------------------ */
const previewRowIndex = ref(0)
const previewHtml = ref('')
const previewLoading = ref(false)
let previewTimer: ReturnType<typeof setTimeout> | undefined

async function refreshPreview(): Promise<void> {
  if (!parsed.value || rows.value.length === 0) {
    previewHtml.value = ''
    return
  }
  const idx = clampPreviewIndex(previewRowIndex.value, rows.value.length)
  const row = rows.value[idx]
  if (!row) return
  previewLoading.value = true
  try {
    const tpl = store.buildTemplate()
    const data = buildRowData(row)
    const res = await render({
      template: tpl,
      data,
      output: {
        screen: true,
        scale: 2,
        pageDecoration: {
          backgroundColor: store.pageSetup.backgroundColor ?? '#ffffff',
          watermark: store.pageSetup.watermark,
        },
      },
    })
    previewHtml.value = res.html
  } catch {
    previewHtml.value = ''
  } finally {
    previewLoading.value = false
  }
}

function debouncedPreview(): void {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void refreshPreview(), 180)
}

watch(previewRowIndex, debouncedPreview)
watch(
  () => props.show,
  (open) => {
    if (open) {
      refreshPlaceholders()
      refreshMapping()
      void refreshPreview()
      // 打开时不要无条件重探（probe 会置 checking→重新打客户端，客户端忙时会 3s 超时变 disconnected，
      // 表现为"设置连接好了、一开流水标签就断开"）。改用 probeIfStale：
      // 已连接且在 15s TTL 内直接复用现有状态，零打扰；过期/未连接才探测（inflight 合并并发）。
      void probeIfStale()
    }
  },
)

/* ------------------------------ 打印机 ------------------------------ */
const {
  state: probeState,
  printers: localPrinters,
  defaultPrinter,
  errorText: probeError,
  baseUrl: printerBase,
  probe,
  probeIfStale,
} = usePrinterProbe()

const selectedPrinter = ref('')
const isConnected = computed(
  () => probeState.value === 'connected' && localPrinters.value.length > 0,
)

const printerOptions = computed(() => buildPrinterOptions(localPrinters.value))

const currentPrinter = computed(
  () => localPrinters.value.find((p) => p.name === selectedPrinter.value) ?? null,
)

const dpi = ref<number | null>(null)

type ColorMode = 'color' | 'grayscale'
/** 颜色：默认黑白；打印机不支持彩色时强制黑白 */
const color = ref<ColorMode>('grayscale')
/** 方向：默认跟随模板页面设置，可手动覆盖（部分打印机纸张方向反直觉） */
const orientation = ref<OrientationPref>('auto')

watch(currentPrinter, (p) => {
  if (p) {
    dpi.value = resolvePrintDpi(null, p)
    if (!p.supportsColor) color.value = 'grayscale'
  }
})

/**
 * 打印机列表就绪（或面板刚打开）时，自动选中默认打印机。
 * 对齐 PrintDialog.detectLocalPrinters：避免用户每次打开都得手动选一次。
 */
function ensureDefaultPrinter(): void {
  if (!isConnected.value) return
  // 已选中的还在列表里就不动，否则回落默认机（共享逻辑，React 端同源）
  selectedPrinter.value = pickDefaultPrinter(
    selectedPrinter.value,
    localPrinters.value,
    defaultPrinter.value,
  )
}

watch(localPrinters, ensureDefaultPrinter, { immediate: true })

/* ------------------------------ 打印参数 ------------------------------ */
const interval = ref(300) // 推送间隔 ms
const copies = ref(1)
/** 手动限制打印行数：0 = 全部行 */
const limitRows = ref(0)

const taskName = computed(() => store.templateName || '流水标签')

/* ------------------------------ 批量打印循环 ------------------------------ */
const results = ref<FlowRowResult[]>([])
const running = ref(false)
const paused = ref(false)
const stopped = ref(false)
const currentIndex = ref(0)
const startTime = ref(0)
const tickNow = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | undefined

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const total = computed(() => rows.value.length)
/** 本次实际打印行数：限制行数 >0 时取 min(limit, 总行数)，否则全部 */
const printTotal = computed(() => computePrintTotal(total.value, limitRows.value))
const done = computed(() => results.value.length)
const successCount = computed(() => results.value.filter((r) => r.success).length)
const failCount = computed(() => results.value.filter((r) => !r.success).length)
const elapsedMs = computed(() =>
  running.value || results.value.length > 0 ? tickNow.value - startTime.value : 0,
)
/** 进度 / 均值 / ETA 由共享逻辑统一推导（React 端同源） */
const stats = computed(() =>
  computeFlowStats({
    results: results.value,
    printTotal: printTotal.value,
    elapsedMs: elapsedMs.value,
  }),
)
const avgMs = computed(() => stats.value.avgMs)
const etaMs = computed(() => stats.value.etaMs)
const progressPct = computed(() => stats.value.progressPct)

const failedRows = computed(() => results.value.filter((r) => !r.success))

async function startBatch(): Promise<void> {
  if (!isConnected.value) {
    message.warning('打印机未连接')
    return
  }
  if (rows.value.length === 0) {
    message.warning('请先上传数据')
    return
  }
  if (placeholders.value.length === 0) {
    message.warning('模板里没有 {{字段}} 占位符，请在设计器里绑定数据')
    return
  }
  if (!selectedPrinter.value) {
    message.warning('请选择打印机')
    return
  }

  running.value = true
  paused.value = false
  stopped.value = false
  results.value = []
  startTime.value = Date.now()
  tickNow.value = Date.now()
  tickTimer = setInterval(() => {
    tickNow.value = Date.now()
  }, 200)

  const tpl = store.buildTemplate()
  const deco = {
    backgroundColor: store.pageSetup.backgroundColor ?? '#ffffff',
    watermark: store.pageSetup.watermark,
  }
  const effectiveDpi = resolvePrintDpi(dpi.value, currentPrinter.value)

  for (let i = 0; i < printTotal.value; i++) {
    // 暂停等待
    while (paused.value && !stopped.value) await sleep(100)
    if (stopped.value) break

    currentIndex.value = i
    const t0 = performance.now()
    try {
      const data = buildRowData(rows.value[i] ?? {})
      const payload = await buildPrintPayload(
        { template: tpl, data, output: { pageDecoration: deco } },
        // 矢量 HTML 载荷（客户端 QWebEngine 矢量打印）；热敏标签无栅格化概念，与 DPI 无关
        { mode: 'html' },
      )
      await submitPrintJob(
        {
          jobId: generateJobId(),
          taskName: `${taskName.value} #${i + 1}`,
          printer: selectedPrinter.value,
          format: payload.format,
          encoding: payload.encoding,
          content: payload.content,
          pages: payload.pages,
          width: payload.width,
          height: payload.height,
          copies: copies.value,
          // 方向：默认跟随模板，面板可覆盖；颜色：黑白/彩色（打印机不支持彩色时强制黑白）
          orientation: resolvePrintOrientation(orientation.value, store.pageSetup.orientation),
          duplex: false,
          color: color.value === 'color',
          dpi: effectiveDpi,
        },
        printerBase.value,
      )
      results.value.push({ index: i, success: true, durationMs: performance.now() - t0 })
    } catch (e) {
      results.value.push({
        index: i,
        success: false,
        error: describePrintError(e),
        durationMs: performance.now() - t0,
      })
    }
    // 间隔（最后一行不等）
    if (shouldWaitInterval(i, rows.value.length, interval.value, stopped.value)) {
      await sleep(interval.value)
    }
  }

  running.value = false
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = undefined
  }
  const ok = successCount.value
  const fail = failCount.value
  if (fail === 0) {
    message.success(`全部完成：${ok} 张标签已打印`)
  } else {
    message.warning(`完成：成功 ${ok} 张，失败 ${fail} 张（可在失败列表重试）`)
  }
}

function pauseBatch(): void {
  if (running.value) paused.value = true
}

function resumeBatch(): void {
  paused.value = false
}

function stopBatch(): void {
  stopped.value = true
  paused.value = false
}

async function retryRow(idx: number): Promise<void> {
  const row = rows.value[idx]
  if (!row) return
  // 找到该行的结果条目，替换为"重试中"
  const existing = results.value.find((r) => r.index === idx)
  if (existing) existing.error = '重试中…'

  const tpl = store.buildTemplate()
  const deco = {
    backgroundColor: store.pageSetup.backgroundColor ?? '#ffffff',
    watermark: store.pageSetup.watermark,
  }
  const effectiveDpi = resolvePrintDpi(dpi.value, currentPrinter.value)
  const t0 = performance.now()
  try {
    const data = buildRowData(row)
    const payload = await buildPrintPayload(
      { template: tpl, data, output: { pageDecoration: deco } },
      { mode: 'html' },
    )
    await submitPrintJob(
      {
        jobId: generateJobId(),
        taskName: `${taskName.value} #${idx + 1}（重试）`,
        printer: selectedPrinter.value,
        format: payload.format,
        encoding: payload.encoding,
        content: payload.content,
        pages: payload.pages,
        width: payload.width,
        height: payload.height,
        copies: copies.value,
        // 方向：默认跟随模板，面板可覆盖；颜色：黑白/彩色
        orientation: resolvePrintOrientation(orientation.value, store.pageSetup.orientation),
        duplex: false,
        color: color.value === 'color',
        dpi: effectiveDpi,
      },
      printerBase.value,
    )
    if (existing) {
      existing.success = true
      existing.error = undefined
      existing.durationMs = performance.now() - t0
    }
    message.success(`第 ${idx + 1} 行重试成功`)
  } catch (e) {
    if (existing) {
      existing.success = false
      existing.error = describePrintError(e)
      existing.durationMs = performance.now() - t0
    }
    message.error(`第 ${idx + 1} 行重试失败：${describePrintError(e)}`)
  }
}

function retryAllFailed(): void {
  const failed = results.value.filter((r) => !r.success)
  for (const r of failed) void retryRow(r.index)
}

/* ------------------------------ 生命周期 ------------------------------ */
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (previewTimer) clearTimeout(previewTimer)
})

function close(): void {
  if (running.value && !stopped.value) {
    message.warning('正在打印中，请先停止')
    return
  }
  emit('update:show', false)
}

const canStart = computed(() =>
  canStartBatch({
    connected: isConnected.value,
    rowCount: rows.value.length,
    placeholderCount: placeholders.value.length,
    hasPrinter: !!selectedPrinter.value,
    running: running.value,
  }),
)

/** 行简要数据（用于失败列表展示） */
function rowSummaryOf(idx: number): string {
  return rowSummary(mapping.value, rows.value[idx])
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    title="流水标签批量打印"
    style="width: 1100px; max-width: 96vw"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="flow-body">
      <!-- ===================== 左：数据源 ===================== -->
      <div class="flow-left">
        <!-- 上传区 -->
        <div v-if="!parsed" class="upload-zone">
          <NSpin v-if="parsing" size="small" />
          <template v-else>
            <div class="i-carbon-document-import text-32px text-brand-text-3" />
            <NText depth="2" class="text-13px">上传 Excel / CSV / JSON</NText>
            <NText depth="3" class="text-11px">每行一条数据，第一行作为列标题</NText>
            <NButton size="small" type="primary" @click="triggerFileInput">选择文件</NButton>
          </template>
          <NText v-if="parseError" type="error" class="text-12px">{{ parseError }}</NText>
          <input
            ref="fileInput"
            type="file"
            accept=".csv,.json,.xlsx,.xls"
            class="hidden-file"
            @change="onFileChange"
          />
        </div>

        <template v-if="parsed">
          <!-- 文件信息 -->
          <div class="file-bar">
            <div class="i-carbon-document text-14px" />
            <NText class="text-12px font-medium">{{ parsed.sourceName }}</NText>
            <NTag size="tiny" round>{{ parsed.columns.length }} 列 · {{ total }} 行</NTag>
            <NButton size="tiny" quaternary class="ml-auto" @click="triggerFileInput">重新上传</NButton>
          </div>

          <!-- 字段映射 -->
          <div class="section-title">字段映射</div>
          <div v-if="placeholders.length === 0" class="empty-hint">
            <NText depth="3" class="text-12px">
              模板里没有检测到 <code v-text="'{{字段}}'" /> 占位符。<br />
              请在设计器里给标签控件绑定数据（如 <code v-text="'{{no}}'" />），再回来。
            </NText>
          </div>
          <div v-else class="mapping-list">
            <div v-for="ph in placeholders" :key="ph" class="mapping-row">
              <code class="ph-tag" v-text="'{{' + ph + '}}'" />
              <span class="mapping-arrow">→</span>
              <NSelect
                size="tiny"
                :value="mapping[ph] || ''"
                :options="columnOptions(parsed.columns)"
                style="flex: 1"
                @update:value="(v: string) => (mapping[ph] = v || null)"
              />
            </div>
          </div>

          <!-- 数据预览 -->
          <div class="section-title">
            数据预览
            <NText depth="3" class="text-11px">（前 {{ Math.min(PREVIEW_ROWS, total) }} 行）</NText>
          </div>
          <div class="data-preview-scroll">
            <table class="data-preview-table">
              <thead>
                <tr>
                  <th class="row-idx-col">#</th>
                  <th v-for="c in parsed.columns" :key="c.key" :title="c.key">{{ c.title || c.key }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, i) in rows.slice(0, PREVIEW_ROWS)"
                  :key="i"
                  :class="{ 'is-current': i === previewRowIndex }"
                  @click="previewRowIndex = i"
                >
                  <td class="row-idx-col">{{ i + 1 }}</td>
                  <td v-for="c in parsed.columns" :key="c.key" :title="String(row[c.key] ?? '')">
                    {{ row[c.key] ?? '' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <!-- ===================== 右：预览 + 控制 + 统计 ===================== -->
      <div class="flow-right">
        <!-- 标签预览 -->
        <div class="preview-header">
          <span class="section-title-inline">标签预览</span>
          <div class="preview-nav">
            <NButton size="tiny" quaternary :disabled="previewRowIndex <= 0" @click="previewRowIndex--">‹</NButton>
            <NText class="text-12px tabular-nums">第 {{ Math.min(previewRowIndex + 1, total || 1) }} / {{ total || 0 }} 行</NText>
            <NButton size="tiny" quaternary :disabled="previewRowIndex >= total - 1" @click="previewRowIndex++">›</NButton>
          </div>
        </div>
        <div class="preview-iframe-wrap">
          <NSpin v-if="previewLoading" size="small" class="preview-spin" />
          <iframe v-if="previewHtml" :srcdoc="previewHtml" class="preview-iframe" />
          <div v-else class="preview-empty">
            <NText depth="3" class="text-12px">上传数据后显示标签预览</NText>
          </div>
        </div>

        <!-- 打印配置 -->
        <div class="config-row">
          <div class="config-field">
            <span class="config-label">打印机</span>
            <NSelect
              v-model:value="selectedPrinter"
              :options="printerOptions"
              size="small"
              :placeholder="isConnected ? '选择打印机' : '未连接'"
              :disabled="!isConnected"
              style="flex: 1"
            />
          </div>
          <NTooltip>
            <template #trigger>
              <NButton size="tiny" quaternary @click="probe">
                <div class="i-carbon-renew text-14px" />
              </NButton>
            </template>
            重新检测打印机
          </NTooltip>
        </div>
        <div v-if="!isConnected" class="conn-hint">
          <NText depth="3" class="text-11px">
            {{ connHint(probeState, probeError) }}
          </NText>
        </div>
        <div class="config-row">
          <div class="config-field">
            <span class="config-label">间隔</span>
            <NInputNumber button-placement="both" v-model:value="interval" size="small" :min="0" :max="10000" :step="50" style="width: 110px">
              <template #suffix>ms</template>
            </NInputNumber>
          </div>
          <div class="config-field">
            <span class="config-label">每张份数</span>
            <NInputNumber button-placement="both" v-model:value="copies" size="small" :min="1" :max="99" style="width: 80px" />
          </div>
          <div class="config-field">
            <span class="config-label">打印行数</span>
            <NInputNumber button-placement="both" v-model:value="limitRows" size="small" :min="0" :max="total" style="width: 90px" />
            <NText depth="3" class="text-11px" style="white-space: nowrap">
              {{ limitRows > 0 ? `共 ${printTotal} 行` : '全部行' }}
            </NText>
          </div>
          <div v-if="currentPrinter" class="config-field">
            <span class="config-label">DPI</span>
            <NInputNumber
              button-placement="both"
              v-model:value="dpi"
              size="small"
              :min="72"
              :max="currentPrinter.maxDpi || 2400"
              style="width: 90px"
            />
          </div>
        </div>
        <div class="config-row">
          <div class="config-field">
            <span class="config-label">颜色</span>
            <NRadioGroup
              v-model:value="color"
              size="small"
              :disabled="!isConnected || currentPrinter?.supportsColor === false"
            >
              <NRadioButton value="grayscale">黑白</NRadioButton>
              <NRadioButton value="color">彩色</NRadioButton>
            </NRadioGroup>
          </div>
          <div class="config-field">
            <span class="config-label">方向</span>
            <NRadioGroup v-model:value="orientation" size="small" :disabled="!isConnected">
              <NRadioButton value="auto">跟随模板</NRadioButton>
              <NRadioButton value="portrait">纵向</NRadioButton>
              <NRadioButton value="landscape">横向</NRadioButton>
            </NRadioGroup>
            <NTooltip>
              <template #trigger>
                <div class="i-carbon-information text-13px cursor-pointer text-brand-text-3" />
              </template>
              默认跟随模板页面设置的方向；若打印机纸张方向与预期相反，可在此手动覆盖为纵向 / 横向。
            </NTooltip>
          </div>
        </div>

        <!-- 打印按钮 -->
        <div class="print-controls">
          <NButton
            v-if="!running"
            size="small"
            type="primary"
            :disabled="!canStart"
            @click="startBatch"
          >
            <div class="i-carbon-play mr-1 text-14px" />
            开始批量打印
          </NButton>
          <template v-if="running">
            <NButton v-if="!paused" size="small" type="warning" @click="pauseBatch">
              <div class="i-carbon-pause mr-1 text-14px" />
              暂停
            </NButton>
            <NButton v-if="paused" size="small" type="primary" @click="resumeBatch">
              <div class="i-carbon-play mr-1 text-14px" />
              继续
            </NButton>
            <NButton size="small" type="error" @click="stopBatch">
              <div class="i-carbon-stop mr-1 text-14px" />
              停止
            </NButton>
          </template>
          <NText v-if="paused" type="warning" class="text-12px ml-2">已暂停</NText>
        </div>

        <!-- 进度 + 统计 -->
        <div v-if="running || results.length > 0" class="stats-panel">
          <NProgress
            type="line"
            :percentage="progressPct"
            :status="failCount > 0 ? 'warning' : 'success'"
            :height="14"
            :processing="running && progressPct < 100"
            border-radius="6"
            indicator-placement="inside"
          />
          <div class="stats-grid">
            <div class="stat-item">
              <span class="stat-num tabular-nums">{{ done }} / {{ printTotal }}</span>
              <span class="stat-label">已打印</span>
            </div>
            <div class="stat-item stat-success">
              <span class="stat-num tabular-nums">{{ successCount }}</span>
              <span class="stat-label">成功</span>
            </div>
            <div class="stat-item stat-fail">
              <span class="stat-num tabular-nums">{{ failCount }}</span>
              <span class="stat-label">失败</span>
            </div>
            <div class="stat-item">
              <span class="stat-num tabular-nums">{{ formatDuration(elapsedMs) }}</span>
              <span class="stat-label">总时长</span>
            </div>
            <div class="stat-item">
              <span class="stat-num tabular-nums">{{ avgMs > 0 ? (avgMs / 1000).toFixed(2) + 's' : '—' }}</span>
              <span class="stat-label">均/张</span>
            </div>
            <div class="stat-item">
              <span class="stat-num tabular-nums">{{ running && etaMs > 0 ? formatDuration(etaMs) : '—' }}</span>
              <span class="stat-label">预计剩余</span>
            </div>
          </div>
        </div>

        <!-- 失败行 -->
        <NCollapse v-if="failedRows.length > 0" class="failed-collapse">
          <NCollapseItem :title="`失败行（${failedRows.length}）`" name="failed">
            <div class="failed-toolbar">
              <NButton size="tiny" type="primary" tertiary @click="retryAllFailed">全部重试</NButton>
            </div>
            <div v-for="r in failedRows" :key="r.index" class="failed-row">
              <div class="failed-row-info">
                <NTag size="tiny" type="error">第 {{ r.index + 1 }} 行</NTag>
                <NText depth="3" class="text-11px truncate" style="max-width: 200px">{{ rowSummaryOf(r.index) }}</NText>
                <NText type="error" class="text-11px">{{ r.error }}</NText>
              </div>
              <NButton size="tiny" type="primary" tertiary @click="retryRow(r.index)">重试</NButton>
            </div>
          </NCollapseItem>
        </NCollapse>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-between">
        <NText depth="3" class="text-11px">
          流式渲染：每行单独渲染 1 页 PDF → 推送打印，内存恒定
        </NText>
        <NButton size="small" :disabled="running && !stopped" @click="close">关闭</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.flow-body {
  display: flex;
  gap: 16px;
  max-height: 72vh;
}
.flow-left {
  width: 42%;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding-right: 4px;
}
.flow-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* 上传区 */
.upload-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px 16px;
  border: 2px dashed var(--brand-border, #d4d6d9);
  border-radius: 10px;
  text-align: center;
}
.hidden-file {
  display: none;
}
.file-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--brand-surface, #f5f6f7);
}

/* 小节标题 */
.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-text-2, #4b5563);
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.section-title-inline {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-text-2, #4b5563);
}

/* 字段映射 */
.empty-hint {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--brand-surface, #f5f6f7);
  line-height: 1.6;
}
.mapping-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mapping-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ph-tag {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(37, 99, 235, 0.1);
  color: #2563eb;
  white-space: nowrap;
  font-family: monospace;
}
.mapping-arrow {
  font-size: 11px;
  color: var(--brand-text-3, #9ca3af);
}

/* 数据预览表 */
.data-preview-scroll {
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--brand-border, #e5e7eb);
  border-radius: 6px;
}
.data-preview-table {
  border-collapse: collapse;
  font-size: 11px;
  width: 100%;
}
.data-preview-table th,
.data-preview-table td {
  border-bottom: 1px solid var(--brand-border, #eceef1);
  padding: 3px 8px;
  text-align: left;
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.data-preview-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--brand-surface, #f5f6f7);
  font-weight: 600;
}
.data-preview-table .row-idx-col {
  width: 32px;
  text-align: center;
  color: var(--brand-text-3, #9ca3af);
}
.data-preview-table tbody tr {
  cursor: pointer;
}
.data-preview-table tbody tr.is-current {
  background: rgba(37, 99, 235, 0.08);
}
.data-preview-table tbody tr:hover {
  background: var(--brand-surface, rgba(128, 128, 128, 0.06));
}

/* 标签预览 */
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.preview-nav {
  display: flex;
  align-items: center;
  gap: 6px;
}
.preview-iframe-wrap {
  flex: 1;
  min-height: 180px;
  border: 1px solid var(--brand-border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
  position: relative;
  background: #f0f2f5;
  display: flex;
}
.preview-iframe {
  width: 100%;
  height: 100%;
  min-height: 180px;
  border: 0;
  flex: 1;
}
.preview-spin {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
}
.preview-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 打印配置 */
.config-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.config-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.config-label {
  font-size: 12px;
  color: var(--brand-text-2, #4b5563);
  white-space: nowrap;
}
.conn-hint {
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.06);
}

/* 打印按钮 */
.print-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}

/* 统计面板 */
.stats-panel {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--brand-surface, #f5f6f7);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
}
.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.stat-num {
  font-size: 14px;
  font-weight: 600;
  color: var(--brand-text-1, #111827);
  line-height: 1.2;
}
.stat-label {
  font-size: 10px;
  color: var(--brand-text-3, #9ca3af);
}
.stat-success .stat-num {
  color: #16a34a;
}
.stat-fail .stat-num {
  color: #ef4444;
}

/* 失败行 */
.failed-collapse {
  margin-top: 4px;
}
.failed-toolbar {
  margin-bottom: 6px;
}
.failed-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.04);
  margin-bottom: 4px;
}
.failed-row-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
</style>
