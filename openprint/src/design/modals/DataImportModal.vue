<script setup lang="ts">
/**
 * DataImportModal —— 顶部「导入数据」入口弹窗
 *
 * 流程：选文件（CSV / JSON / Excel）→ 解析 → 预览（首行为标题、表头悬浮 × 直接删列、行可删）
 * → 确认后由 designer.importTable 在画布生成「内嵌数据表格」（自动居中、自动分页）。
 * 数据直接长进表格控件（control.data），与 dataSource 字段绑定解耦。
 */
import { computed, ref } from 'vue'
import { NButton, NCheckbox, NModal, NSpin, NText, useMessage } from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import { parseDataFile, type ParsedData } from '@/design/utils/data-import'
import type { ImportColumn } from '@/types/data-import'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const store = useDesignerStore()
const message = useMessage()

const fileInput = ref<HTMLInputElement | null>(null)
const parsed = ref<ParsedData | null>(null)
const sourceName = ref('')
/** 当前保留的列（删列即从此数组 splice，不可恢复，需重新选文件才能找回） */
const columns = ref<ImportColumn[]>([])
const deletedRows = ref<Set<number>>(new Set())
const loading = ref(false)
const error = ref('')

/** 预览最多渲染的行数（其余行仍会完整导入，只是不全部渲染到 DOM） */
const PREVIEW_ROWS = 200

/** 预览里展示的行：剔除已删行，最多 PREVIEW_ROWS 条（保留原始下标用于删行映射） */
const previewRows = computed<Array<{ index: number; cells: string[] }>>(() => {
  if (!parsed.value) return []
  const cols = columns.value
  const out: Array<{ index: number; cells: string[] }> = []
  parsed.value.rows.forEach((row, i) => {
    if (deletedRows.value.has(i)) return
    if (out.length >= PREVIEW_ROWS) return
    out.push({ index: i, cells: cols.map((c) => String(row[c.key] ?? '')) })
  })
  return out
})

const stats = computed(() => {
  if (!parsed.value) return ''
  const totalRows = parsed.value.rows.length - deletedRows.value.size
  return `${columns.value.length} 列 · ${totalRows} 行${
    deletedRows.value.size ? `（已删 ${deletedRows.value.size} 行）` : ''
  }`
})

const modalTitle = computed(() =>
  parsed.value ? `导入数据 · ${sourceName.value}` : '导入数据',
)

function triggerFile(): void {
  fileInput.value?.click()
}

async function onFileChange(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = '' // 允许重复选同一文件
  if (!file) return
  loading.value = true
  error.value = ''
  try {
    const data = await parseDataFile(file)
    parsed.value = data
    sourceName.value = data.sourceName
    columns.value = data.columns.map((c) => ({ ...c }))
    deletedRows.value = new Set()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    parsed.value = null
  } finally {
    loading.value = false
  }
}

/** 表头 × ：直接删除该列（splice，不可恢复；要找回需重新选文件） */
function removeColumn(key: string): void {
  columns.value = columns.value.filter((c) => c.key !== key)
}

function toggleRow(index: number, keep: boolean): void {
  const next = new Set(deletedRows.value)
  if (keep) next.delete(index)
  else next.add(index)
  deletedRows.value = next
}

function setAllRows(keep: boolean): void {
  deletedRows.value = keep
    ? new Set()
    : new Set(parsed.value ? parsed.value.rows.map((_, i) => i) : [])
}

function confirmImport(): void {
  if (!parsed.value) return
  const cols = columns.value
  if (cols.length === 0) {
    message.error('至少保留一列')
    return
  }
  const records = parsed.value.rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => !deletedRows.value.has(i))
    .map(({ row }) => {
      const o: Record<string, unknown> = {}
      for (const c of cols) o[c.key] = row[c.key] ?? ''
      return o
    })
  store.importTable({
    columns: cols.map((c) => ({ key: c.key, title: c.title })),
    records,
    sourceName: sourceName.value,
  })
  message.success(`已导入 ${records.length} 行 / ${cols.length} 列，自动生成居中的分页表格`)
  close()
}

function close(): void {
  emit('update:show', false)
  parsed.value = null
  sourceName.value = ''
  columns.value = []
  deletedRows.value = new Set()
  error.value = ''
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    display-directive="if"
    :title="modalTitle"
    :mask-closable="false"
    style="width: 880px; max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="flex flex-col gap-4">
      <!-- 文件选择 -->
      <div v-if="!parsed" class="flex flex-col items-center gap-3 py-8">
        <NButton type="primary" size="large" @click="triggerFile">
          <div class="i-carbon-document-import mr-1 text-16px" />
          选择文件（CSV / JSON / Excel）
        </NButton>
        <NText depth="3" class="text-12px">
          支持 .csv / .json / .xlsx / .xls，第一行作为列标题，表名取自文件名
        </NText>
        <NSpin v-if="loading" />
        <NText v-if="error" type="error" class="text-12px">{{ error }}</NText>
        <input
          ref="fileInput"
          type="file"
          accept=".csv,.json,.xlsx,.xls"
          style="display: none"
          @change="onFileChange"
        />
      </div>

      <!-- 预览与编辑 -->
      <template v-else>
        <!-- 顶部信息条 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="i-carbon-document text-16px" />
            <NText class="text-13px font-medium">{{ sourceName }}</NText>
            <NText depth="3" class="text-12px">{{ stats }}</NText>
          </div>
          <NButton size="small" tertiary @click="triggerFile">重新选择</NButton>
        </div>

        <!-- 数据预览：固定显示区，上下左右滚动；表头悬浮 × 直接删列 -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <NText depth="2" class="text-12px">
              数据预览（表头悬浮显示 × 可删除该列；勾选行可删除；仅渲染前 {{ PREVIEW_ROWS }} 行，其余行仍会完整导入）
            </NText>
            <div class="flex gap-2">
              <NButton size="tiny" tertiary @click="setAllRows(true)">保留全部行</NButton>
              <NButton size="tiny" tertiary @click="setAllRows(false)">删除全部行</NButton>
            </div>
          </div>
          <div class="preview-scroll">
            <table class="import-preview-table">
              <thead>
                <tr>
                  <th class="row-check-col"></th>
                  <th v-for="c in columns" :key="c.key" class="col-th">
                    <input
                      class="th-title-input"
                      :value="c.title"
                      :title="c.title"
                      @input="(e: Event) => (c.title = (e.target as HTMLInputElement).value)"
                    />
                    <button
                      type="button"
                      class="th-del"
                      title="删除该列"
                      @click="removeColumn(c.key)"
                    >
                      <div class="i-carbon-close" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in previewRows" :key="row.index">
                  <td class="row-check-col">
                    <NCheckbox
                      :checked="!deletedRows.has(row.index)"
                      @update:checked="(v: boolean) => toggleRow(row.index, v)"
                    />
                  </td>
                  <td v-for="(cell, ci) in row.cells" :key="ci" :title="cell">{{ cell }}</td>
                </tr>
                <tr v-if="previewRows.length === 0">
                  <td :colspan="columns.length + 1" class="text-center op-60 text-12px py-3">
                    没有可显示的行（可能已全部删除）
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton size="small" @click="close">取消</NButton>
        <NButton v-if="parsed" size="small" type="primary" @click="confirmImport">确认导入</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
/* 数据预览：固定合适显示区域，原生双向滚动（表头吸顶） */
.preview-scroll {
  height: 340px;
  overflow: auto;
  border: 1px solid var(--brand-border, #e5e7eb);
  border-radius: 6px;
  scrollbar-width: thin;
}
.preview-scroll::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.preview-scroll::-webkit-scrollbar-thumb {
  background: var(--brand-border, #d4d6d9);
  border-radius: 6px;
}
.preview-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--brand-text-3, #b0b3b8);
}

.import-preview-table {
  border-collapse: collapse;
  font-size: 12px;
  min-width: 100%;
}
.import-preview-table th,
.import-preview-table td {
  border: 1px solid var(--brand-border, #eceef1);
  padding: 4px 10px;
  text-align: left;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.import-preview-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--brand-bg-hover, #f5f6f7);
  font-weight: 600;
  white-space: nowrap;
}
.import-preview-table .row-check-col {
  width: 44px;
  min-width: 44px;
  text-align: center;
}
.import-preview-table tbody tr:hover {
  background: var(--brand-bg-hover, rgba(128, 128, 128, 0.08));
}

/* 表头列：标题可编辑 + 悬浮显示删除按钮 */
.col-th {
  position: relative;
  padding-right: 22px !important;
}
.th-title-input {
  width: 100%;
  min-width: 48px;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-weight: 600;
  color: var(--brand-text-1, #111827);
  padding: 0;
  cursor: text;
}
.th-title-input:focus {
  outline: 1px solid var(--brand, #2563eb);
  border-radius: 2px;
}
.th-del {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--brand-text-3, #6b7280);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.col-th:hover .th-del,
.th-del:focus-visible {
  opacity: 1;
}
.th-del:hover {
  background: var(--brand-danger, #ef4444);
  color: #fff;
}
</style>
