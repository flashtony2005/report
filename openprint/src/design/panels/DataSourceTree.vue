<script setup lang="ts">
/**
 * DataSourceTree —— 数据源三选一 + 字段树（《设计方案》§19.4.3a 第五节）
 *
 * 顶部「三选一」切换数据源 provider：
 *   - 示例数据（零后端开箱即用）
 *   - ERP 接口（代码层配置，优先级最高；未配置则禁用）
 *   - 数据库（本地客户端 /api/data/*；需手动开启，不默认请求）
 * 选中「数据库」时展开四步探索器（库→表→列→行）；字段树在下方统一拖拽绑定。
 */
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, NRadioButton, NRadioGroup, NScrollbar, NSelect, NSpin, NTooltip } from 'naive-ui'
import { useDataSourceStore } from '@/design/stores/dataSource'
import { startFieldDrag } from '@/design/hooks/field-drag'
import DatabaseExplorer from './DatabaseExplorer.vue'
import { fieldTreeEmptyHint, type DataSourceKind } from '@/config/data-source'

const store = useDataSourceStore()
const keyword = ref('')

const sourceOptions = computed(() =>
  store.sources.map((s) => ({ label: s.name, value: s.id })),
)

function onSelectProvider(v: string | number): void {
  void store.selectProvider(v as DataSourceKind)
}

const filteredGroups = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return store.fieldTree
  return store.fieldTree
    .map((t) => ({
      table: t.table,
      fields: t.fields.filter(
        (f) => f.label.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw),
      ),
    }))
    .filter((t) => t.fields.length > 0)
})

/**
 * 空态文案：把「为什么没有字段」说清楚（共享函数，与 React 端同一份措辞）。
 * 数据库模式最常见的一句抱怨是「不能拖字段到画布」——实际是卡在开关/选库/选表某一步，
 * 光显示「暂无字段」等于没说。
 */
const emptyHint = computed(() =>
  fieldTreeEmptyHint({
    kind: store.kind,
    dbEnabled: store.dbEnabled,
    dbTable: store.dbSelection.table,
    keyword: keyword.value,
  }),
)

onMounted(() => {
  void store.init()
})

const typeColor = (type: string): string => {
  switch (type) {
    case 'number':
      return 'text-blue-500'
    case 'date':
      return 'text-green-500'
    case 'image':
      return 'text-purple-500'
    default:
      return 'text-brand-text-3'
  }
}

const typeLabel = (type: string): string => {
  switch (type) {
    case 'number':
      return 'N'
    case 'date':
      return 'D'
    case 'boolean':
      return 'B'
    case 'image':
      return 'I'
    default:
      return 'S'
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 三选一（固定） -->
    <div class="border-b border-brand-border px-3 py-2">
      <div class="mb-1 text-12px text-brand-text-3">数据源类型</div>
      <NRadioGroup
        :value="store.kind"
        size="small"
        @update:value="onSelectProvider"
      >
        <NRadioButton value="sample">示例数据</NRadioButton>
        <NRadioButton value="erp" :disabled="!store.erpAvailable">ERP</NRadioButton>
        <NRadioButton value="database">数据库</NRadioButton>
      </NRadioGroup>
    </div>

    <!-- 搜索 + 刷新（固定工具条） -->
    <div class="flex items-center gap-1 border-b border-brand-border p-2">
      <NInput v-model:value="keyword" size="small" placeholder="搜索字段" clearable />
      <NTooltip>
        <template #trigger>
          <NButton size="small" quaternary @click="store.refreshFields()">
            <div class="i-carbon-renew text-14px" />
          </NButton>
        </template>
        {{ store.kind === 'database' ? '重新取数' : '刷新字段' }}
      </NTooltip>
    </div>

    <!-- 可滚动内容区：数据库探索器/数据源选择 + 字段树 -->
    <NScrollbar class="flex-1 min-h-0">
      <div class="flex flex-col">
        <!-- 数据库：四步探索器 -->
        <DatabaseExplorer v-if="store.kind === 'database'" />

        <!-- 非数据库：数据源选择 -->
        <div v-else class="border-b border-brand-border px-3 py-2">
          <div class="mb-1 text-12px text-brand-text-3">数据源</div>
          <NSelect
            size="small"
            :value="store.activeSourceId"
            :options="sourceOptions"
            @update:value="store.selectSource($event)"
          />
        </div>

        <!-- 字段树 -->
        <NSpin :show="store.loading">
          <div class="p-2 pt-0">
            <div v-for="group in filteredGroups" :key="group.table.id" class="mb-3">
              <div class="mb-1 flex items-center gap-1 text-11px font-medium text-brand-text-3">
                <div class="i-carbon-data-table text-12px" />
                {{ group.table.name }}
                <span v-if="group.table.isArray" class="text-brand-primary">[]</span>
              </div>
              <div
                v-for="field in group.fields"
                :key="field.path"
                class="field-item group"
                draggable="true"
                :title="`拖到画布绑定：${field.path}`"
                @dragstart="(e: DragEvent) => startFieldDrag(e, field.path)"
              >
                <span class="flex-1 truncate text-12px">
                  {{ field.label }}
                  <span v-if="field.custom" class="ml-1 inline-block rounded bg-blue-50 px-1 text-9px text-blue-500">
                    自定义
                  </span>
                </span>
                <span class="text-9px" :class="typeColor(field.type)">
                  {{ typeLabel(field.type) }}
                </span>
                <span class="ml-1 truncate text-9px text-brand-text-3">{{ field.path }}</span>
              </div>
            </div>
            <div v-if="filteredGroups.length === 0" class="py-4 text-center text-12px text-brand-text-3">
              {{ emptyHint }}
            </div>
          </div>
        </NSpin>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.field-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: grab;
  transition: background 0.15s;
}
.field-item:hover {
  background: color-mix(in srgb, var(--brand-primary) 6%, transparent);
}
</style>
