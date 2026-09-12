<script setup lang="ts">
/**
 * ExportDialog —— 四格式导出（PDF / JPG / SVG / HTML）
 *
 * 与预览共用同一份数据合成逻辑（buildTemplate + buildPreviewData），
 * 导出引擎统一以 render() 的 HTML 产物为真相来源，保证「预览 = 导出 = 打印」。
 *
 * 导出语义（见 core/export-engine）：
 * - PDF：单文件多页，思源宋体写死内联
 * - JPG：每页一个文件（多页时 name-1.jpg / name-2.jpg ...）
 * - SVG：单文件多页纵向堆叠（矢量，含 foreignObject）
 * - HTML：单文件自包含（矢量，默认内联字体，任意浏览器可打开）
 */
import { ref } from 'vue'
import {
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NRadio,
  NRadioGroup,
  useMessage,
} from 'naive-ui'
import { exportDocument, downloadBlob, type ExportFormat } from '@/core/export-engine'
import { useDesignerStore } from '@/design/stores/designer'
import { useDataSourceStore } from '@/design/stores/dataSource'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const store = useDesignerStore()
const dsStore = useDataSourceStore()
const message = useMessage()

const format = ref<ExportFormat>('pdf')
const rowCount = ref(30)
const filename = ref('销售出库单')
const exporting = ref(false)

const formatOptions = [
  { label: 'PDF（单文件 · 多页）', value: 'pdf' },
  { label: 'JPG（每页一张）', value: 'jpg' },
  { label: 'SVG（矢量 · 单文件多页）', value: 'svg' },
  { label: 'HTML（矢量 · 自包含单文件）', value: 'html' },
]

function close(): void {
  emit('update:show', false)
}

async function onExport(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const template = store.buildTemplate()
    // 与预览共用同一份数据：数据库模式用真实行，sample/ERP 用明细行数合成
    dsStore.setPreviewRowCount(rowCount.value)
    const data = dsStore.previewData
    const res = await exportDocument(
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
      format.value,
      { filename: filename.value.trim() || 'openprint-document' },
    )
    res.blobs.forEach((b, i) => downloadBlob(b, res.filenames[i]!))
    message.success(`已导出 ${res.blobs.length} 个文件（${res.filenames[0]} 等）`)
    close()
  } catch (e) {
    message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    display-directive="if"
    :mask-closable="!exporting"
    transform-origin="center"
    @update:show="emit('update:show', $event)"
  >
    <div class="export-shell">
      <header class="export-head">
        <div class="i-carbon-download text-16px" />
        <span class="text-14px font-medium">导出文档</span>
        <span class="text-12px op-60">PDF · JPG · SVG · HTML · 与预览/打印一致</span>
      </header>

      <div class="export-body">
        <!-- 格式 -->
        <div class="row">
          <span class="row-label">格式</span>
          <NRadioGroup v-model:value="format" class="flex-1">
            <div class="flex flex-wrap gap-2">
              <NRadio v-for="o in formatOptions" :key="o.value" :value="o.value" :label="o.label" />
            </div>
          </NRadioGroup>
        </div>

        <!-- 明细行数（验证多页导出） -->
        <div class="row">
          <span class="row-label">明细行数</span>
          <NInputNumber
            v-model:value="rowCount"
            size="small"
            button-placement="both"
            :min="0"
            :max="500"
            :step="10"
            style="width: 160px"
          />
          <span class="text-12px op-60">调大可验证跨页导出</span>
        </div>

        <!-- 文件名 -->
        <div class="row">
          <span class="row-label">文件名</span>
          <NInput v-model:value="filename" size="small" placeholder="openprint-document" class="flex-1" />
        </div>

        <p class="hint">
          JPG 多页时每页导出为独立文件（<code>name-1.jpg</code> …）；PDF / SVG / HTML
          为单文件多页。HTML 为矢量、字体已内联，用浏览器打开即可查看/打印。
        </p>
      </div>

      <footer class="export-foot">
        <NButton size="small" :disabled="exporting" @click="close">取消</NButton>
        <NButton size="small" type="primary" :loading="exporting" @click="onExport">
          <div class="i-carbon-download mr-1 text-14px" />
          导出
        </NButton>
      </footer>
    </div>
  </NModal>
</template>

<style scoped>
.export-shell {
  display: flex;
  flex-direction: column;
  width: 460px;
  max-width: 92vw;
  border-radius: 10px;
  background: var(--brand-surface);
  box-shadow: 0 20px 60px -10px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.export-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--brand-border);
  color: var(--brand-text-1);
}
.export-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  color: var(--brand-text-1);
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.row-label {
  flex: none;
  width: 64px;
  font-size: 13px;
  color: var(--brand-text-2);
}
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--brand-text-2);
}
.hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--brand-bg);
  padding: 0 4px;
  border-radius: 3px;
}
.export-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--brand-border);
}
</style>
