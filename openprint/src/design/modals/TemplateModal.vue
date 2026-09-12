<script setup lang="ts">
/**
 * TemplateModal —— 模板管理器（Phase 6）
 *
 * 列表 / 打开 / 复制 / 删除 / 新建。直接走 designer store 的 repository（本地或云端同接口）。
 * 权限（editable/deletable）由 repository 决定：本地恒 true，云端来自后端 permissions。
 */
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NEmpty,
  NModal,
  NPopconfirm,
  NScrollbar,
  NSpin,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import { useDesignerStore } from '@/design/stores/designer'
import type { TemplateSummary } from '@/repository/types'
import { useConfirm } from '@/design/composables/useConfirm'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()

const store = useDesignerStore()
const message = useMessage()
const { confirm } = useConfirm()

const items = ref<TemplateSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const busyId = ref<string | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    items.value = await store.repository.list()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    items.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.show,
  (v) => {
    if (v) void refresh()
  },
)

const sortedItems = computed(() =>
  [...items.value].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
)

function close(): void {
  emit('update:show', false)
}

async function openTemplate(rec: TemplateSummary): Promise<void> {
  busyId.value = rec.id
  try {
    const full = await store.repository.get(rec.id)
    if (!full) {
      message.error('模板不存在或已删除')
      void refresh()
      return
    }
    store.loadTemplate(full)
    message.success(`已打开：${full.name}`)
    close()
  } catch (e) {
    message.error(`打开失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    busyId.value = null
  }
}

async function copyTemplate(rec: TemplateSummary): Promise<void> {
  busyId.value = rec.id
  try {
    const full = await store.repository.get(rec.id)
    if (!full) {
      message.error('模板不存在或已删除')
      void refresh()
      return
    }
    // 加载为当前画布，再另存为（清空 id → create 新记录）
    store.loadTemplate(full)
    await store.saveTemplateAs(`${full.name} 副本`)
    message.success(`已复制为：${full.name} 副本`)
    void refresh()
  } catch (e) {
    message.error(`复制失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    busyId.value = null
  }
}

async function deleteTemplate(rec: TemplateSummary): Promise<void> {
  busyId.value = rec.id
  try {
    await store.repository.remove(rec.id)
    if (store.currentTemplateId === rec.id) store.newBlankTemplate()
    message.success(`已删除：${rec.name}`)
    void refresh()
  } catch (e) {
    message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    busyId.value = null
  }
}

async function createNew(): Promise<void> {
  if (store.dirty && !(await confirm('当前模板有未保存改动，新建将清空画布。确定继续？'))) return
  store.newBlankTemplate()
  message.success('已新建空白模板')
  close()
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="模板管理"
    style="width: 640px; max-width: 92vw"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header-extra>
      <NButton size="small" type="primary" @click="createNew">
        <div class="i-carbon-add mr-1" />
        新建空白模板
      </NButton>
    </template>

    <NSpin :show="loading">
      <div v-if="error" class="mb-3 rounded bg-red-50 px-3 py-2 text-13px text-red-500">
        加载失败：{{ error }}
      </div>

      <NEmpty v-if="!loading && sortedItems.length === 0" description="暂无模板" class="py-8">
        <template #extra>
          <NButton size="small" @click="createNew">新建空白模板</NButton>
        </template>
      </NEmpty>

      <NScrollbar v-else style="max-height: 56vh">
        <div class="flex flex-col gap-2">
          <div
            v-for="rec in sortedItems"
            :key="rec.id"
            class="flex items-center justify-between rounded-lg border border-brand-border px-3 py-2.5 transition-colors hover:border-brand-primary"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-14px font-medium">{{ rec.name }}</span>
                <NTag v-if="!rec.editable" size="tiny" type="warning" :bordered="false">只读</NTag>
              </div>
              <NText depth="3" class="text-11px">
                {{ rec.id }}
                <span v-if="rec.updatedAt" class="ml-2">更新于 {{ rec.updatedAt }}</span>
              </NText>
            </div>

            <div class="flex items-center gap-1">
              <NButton
                size="small"
                :disabled="busyId !== null"
                @click="openTemplate(rec)"
              >
                <div class="i-carbon-launch mr-1" />
                打开
              </NButton>
              <NButton
                size="small"
                :disabled="busyId !== null || !rec.editable"
                @click="copyTemplate(rec)"
              >
                <div class="i-carbon-copy-file mr-1" />
                复制
              </NButton>
              <NPopconfirm
                :disabled="!rec.deletable"
                @positive-click="deleteTemplate(rec)"
              >
                <template #trigger>
                  <NButton
                    size="small"
                    type="error"
                    ghost
                    :disabled="busyId !== null || !rec.deletable"
                  >
                    <div class="i-carbon-trash-can mr-1" />
                    删除
                  </NButton>
                </template>
                确定删除「{{ rec.name }}」？此操作不可恢复。
              </NPopconfirm>
            </div>
          </div>
        </div>
      </NScrollbar>
    </NSpin>
  </NModal>
</template>
