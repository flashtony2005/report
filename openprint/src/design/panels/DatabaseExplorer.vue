<script setup lang="ts">
/**
 * DatabaseExplorer —— 数据库数据源探索器（《数据源三选一·数据库》）
 *
 * 交互流程（用户要求）：
 *   1. 顶部「下拉选择」单选一个数据库（只能选其中一个）；
 *   2. 下方列出该库的表，点击表可展开其「列（字段）」；
 *   3. 展开某表即将其设为当前绑定表（仓库被构造，字段流入下方字段树）。
 *
 * 连上本地打印客户端**不默认请求**，必须用户手动开启开关（dbEnabled）才开始拉取。
 *
 * 列节点**本身可拖**（与下方字段树同一口径 `items[].列名`）：提示语写着「点击表展开字段」，
 * 用户看到列名就会直接往画布拖 —— 早先树节点没实现 dragstart，拖了毫无反应。
 *
 * 配色统一用语义化 CSS 变量（--brand-*），保证在亮/暗主题下文字都能看清。
 */
import { computed, h, onMounted, ref, watch, type VNodeChild } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NSelect,
  NSpin,
  NSwitch,
  NTree,
  type TreeOption,
} from 'naive-ui'
import { useDataSourceStore } from '@/design/stores/dataSource'
import { usePrinterProbe } from '@/design/composables/usePrinterProbe'
import { ROWS_DEFAULT_LIMIT } from '@/core/print-client'
import { startFieldDrag } from '@/design/hooks/field-drag'
import { DB_ARRAY_PREFIX } from '@/repository/client-database-source'

const store = useDataSourceStore()
const probe = usePrinterProbe()

// 进入数据库面板时若尚未探测到客户端，主动探活一次（仅 /health 连接检查，不取数据），
// 以便「手动开启」开关在客户端实际在线时自动可用。
onMounted(() => {
  if (!store.dbAvailable) void probe.probeIfStale()
})

const dbOptions = computed(() =>
  store.dbDatabases.map((d) => ({ label: d.label || d.name, value: d.name })),
)

/** 选库：把该库的 engine 一并带给 store（postgres 若丢引擎会退回 sqlite 分支） */
function onSelectDatabase(name: string): void {
  const picked = store.dbDatabases.find((d) => d.name === name)
  void store.selectDatabase(name, picked?.engine)
}

/* 树数据：仅一层「表」，展开表 → 列（字段） */
const tableTree = ref<TreeOption[]>([])
watch(
  () => store.dbTables,
  (tables) => {
    tableTree.value = tables.map((t) => ({
      key: `tbl::${t.name}`,
      label: t.name,
      isLeaf: false,
    }))
  },
  { immediate: true },
)

/** 展开某表 → 拉列并绑定为当前表 */
async function onLoadTable(node: TreeOption): Promise<void> {
  const tableName = String(node.key).replace('tbl::', '')
  await store.selectTable(tableName)
  node.children = store.dbColumns.map((c) => ({
    key: `col::${tableName}::${c.name}`,
    // key 标记原文：PRI=主键、UNI=唯一键；兼容旧版 primary:true
    label:
      c.primary || c.key === 'PRI'
        ? `${c.name} ·PK`
        : c.key === 'UNI'
          ? `${c.name} ·UNIQUE`
          : c.name,
    isLeaf: true,
    // 与下方字段树同口径（明细数组前缀），列节点直接拖到画布即可绑定
    fieldPath: `${DB_ARRAY_PREFIX}[].${c.name}`,
  }))
  // naive-ui 异步树：修改 children 后强制刷新数组引用
  tableTree.value = [...tableTree.value]
}

/**
 * 显式着色：表名用主文字色、列名用次级文字色，确保亮/暗下都清晰可见。
 * 列节点额外挂 draggable —— 拖到画布即绑定 `items[].列名`，与下方字段树行为一致。
 */
function renderLabel(info: { option: TreeOption }): VNodeChild {
  const isCol = String(info.option.key).startsWith('col::')
  const color = isCol ? 'var(--brand-text-2)' : 'var(--brand-text-1)'
  const path = (info.option as { fieldPath?: string }).fieldPath
  if (isCol && path) {
    return h(
      'span',
      {
        // 与 React 端同名：跨端探针/自动化用同一测试锚点，不必区分 antd / naive
        class: 'db-explorer-col',
        style: `color:${color};font-size:12px;cursor:grab`,
        draggable: true,
        title: `拖到画布绑定：${path}`,
        onDragstart: (e: DragEvent) => startFieldDrag(e, path),
      },
      String(info.option.label),
    )
  }
  return h('span', { style: `color:${color};font-size:12px` }, String(info.option.label))
}

/**
 * NSelect 选项文字显式着色（与树 render-label 同思路）：
 * 下拉菜单被 naive teleport 到 <body>，主题 token 在 portal 场景可能失效
 * （表现为浅灰/浅色盖住文字），内联颜色直接钉死文字色，不受主题 token 影响。
 */
function renderSelectLabel(option: { label?: string | number }): VNodeChild {
  return h(
    'span',
    { style: 'color: var(--brand-text-1); font-size: 12px; line-height: 1.5' },
    String(option.label ?? ''),
  )
}
</script>

<template>
  <div class="db-explorer flex flex-col gap-2 p-3">
    <!-- 未连接客户端：提示 + 开关禁用 -->
    <NAlert v-if="!store.dbAvailable" type="warning" :show-icon="false">
      <div class="text-12px leading-relaxed">
        未连接本地打印客户端，无法启用数据库数据源。<br />
        请在「设置 → 本地打印」连接本机/局域网客户端。
      </div>
    </NAlert>

    <!-- 手动开启开关：始终显示（未连接时禁用并提示） -->
    <div class="flex items-center justify-between">
      <div class="text-12px text-brand-text-2">
        启用数据库数据源<small class="op-60">（需手动开启）</small>
      </div>
      <NSwitch
        :value="store.dbEnabled"
        :disabled="!store.dbAvailable"
        @update:value="(v: boolean) => store.setDbEnabled(v)"
      />
    </div>

    <template v-if="store.dbAvailable && store.dbEnabled">
      <NSpin :show="store.dbLoading && !store.dbDatabases.length">
        <NEmpty
          v-if="!store.dbDatabases.length && !store.dbError"
          size="small"
          description="暂无数据库"
        />
        <NAlert v-else-if="store.dbError" type="error" :show-icon="false">
          <div class="text-12px">{{ store.dbError }}</div>
        </NAlert>

        <template v-else>
          <!-- Step1：单选一个数据库 -->
          <div class="explorer-field">
            <div class="field-label">
              <div class="i-carbon-data-base text-13px" />
              <span>选择数据库</span>
            </div>
            <NSelect
              :value="store.dbSelection.database"
              :options="dbOptions"
              :render-label="renderSelectLabel"
              placeholder="选择数据库"
              size="small"
              :disabled="!store.dbDatabases.length"
              @update:value="(v: string) => store.selectDatabase(v)"
            />
          </div>

          <!-- Step2：表 → 展开列 -->
          <div v-if="store.dbSelection.database" class="explorer-field">
            <div class="field-label">
              <div class="i-carbon-data-table text-13px" />
              <span>数据表（点击表展开字段）</span>
            </div>
            <NSpin :show="store.dbLoading && !!store.dbDatabases.length">
              <NEmpty
                v-if="!store.dbTables.length"
                size="small"
                description="该库暂无数据表"
              />
              <div class="tree-box">
                <NTree
                  :data="tableTree"
                  :on-load="onLoadTable"
                  :render-label="renderLabel"
                  block-line
                  expand-on-click
                />
              </div>
            </NSpin>
          </div>
        </template>
      </NSpin>

      <!-- 已绑定表的信息与操作 -->
      <div
        v-if="store.dbSelection.database && store.dbSelection.table"
        class="rounded bg-brand-bg p-2"
      >
        <div class="text-12px op-70">
          {{ store.dbColumns.length }} 个字段 · 已载入 {{ store.dbRows.length }} 行（预览取前
          {{ ROWS_DEFAULT_LIMIT }} 行）
        </div>
        <div class="mt-1 flex items-center gap-2">
          <NButton size="small" tertiary @click="store.reloadRows()">
            <div class="i-carbon-renew mr-1 text-12px" />
            重新取数
          </NButton>
          <span class="text-11px op-60">拖字段到画布即可绑定</span>
        </div>
        <div class="mt-1 text-11px op-60">
          拖到表格列上 → <code>items[].字段名</code>（逐行取值）；拖到表格外的单值控件上 → 自动用
          <code>items[0].字段名</code>（取首条记录）；拖到空白处 → 新建绑定该字段的文本控件。
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.explorer-field {
  margin-bottom: 10px;
}
.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-text-2);
}
/* 树容器显式用表面色打底，配合 render-label 的语义化文字色，
   保证亮/暗主题下「库/表/列」名字都清晰可读（不依赖 naive 默认树文字色）。 */
.tree-box {
  background: var(--brand-surface);
  border: 1px solid var(--brand-border);
  border-radius: 6px;
  padding: 4px;
}
</style>
