/**
 * dataSource store —— 数据源三选一（ERP 接口 / 数据库 / 示例数据）+ 字段缓存
 *
 * 在《设计方案》§19.4.3a 字段树基础上，新增「provider 三选一」元层：
 * - ERP 接口：代码层配置（环境变量），优先级最高；未配置则不可用。
 * - 数据库：连接本机/局域网打印客户端的数据库接口（/api/data/*）。
 *   连上客户端**不默认请求**，必须用户手动开启（dbEnabled）才拉取；
 *   开启后由「库 → 表 → 列 → 行」四步探索器逐步选择。
 * - 示例数据：内置 Mock，零后端随时可用。
 *
 * 字段缓存 + 手动刷新沿用原逻辑；未注入真实仓库时回退到 createMockDataSource。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { DataSourceRepository, DataSourceMeta, FieldDef, TableMeta } from '@/types/datasource'
import { createMockDataSource } from '@/repository/mock/mock-datasource'
import { createDataSourceHttp } from '@/repository/http-datasource'
import { createClientDatabaseSource } from '@/repository/client-database-source'
import { getBackendConfig, isBackendConfigured } from '@/config/backend'
import { resolvePrinterBaseUrl } from '@/config/printer'
import {
  describePrintError,
  fetchClientRows,
  listClientColumns,
  listClientDatabases,
  listClientTables,
  ROWS_DEFAULT_LIMIT,
  type ClientColumn,
  type ClientDatabase,
  type ClientTable,
  type DbEngine,
} from '@/core/print-client'
import { usePrinterProbe } from '@/design/composables/usePrinterProbe'
import { buildPreviewData } from '@/design/preview/preview-data'
import {
  isErpConfigured,
  loadDataSourcePersisted,
  saveDataSourcePersisted,
  type DataSourceKind,
} from '@/config/data-source'

const CACHE_TTL = 10 * 60 * 1000 // 10 分钟

interface CacheEntry {
  fields: FieldDef[]
  fetchedAt: number
}

const probe = usePrinterProbe()

export const useDataSourceStore = defineStore('dataSource', () => {
  const persisted = loadDataSourcePersisted()

  /* ------------------------------ provider 三选一 ------------------------------ */
  const kind = ref<DataSourceKind>(persisted.kind)
  /** 数据库是否手动开启（连上客户端也不默认请求，必须手动开启） */
  const dbEnabled = ref<boolean>(persisted.dbEnabled)
  /** 本地打印客户端是否已连接（决定是否允许数据库取数） */
  const dbAvailable = computed(() => probe.state.value === 'connected')
  /** 当前 provider 是否可用 */
  const erpAvailable = computed(() => isErpConfigured())
  const sampleAvailable = computed(() => true)
  const databaseAvailable = computed(() => dbAvailable.value && dbEnabled.value)

  /* ------------------------------ 数据库探索器状态 ------------------------------ */
  const dbDatabases = ref<ClientDatabase[]>([])
  const dbTables = ref<ClientTable[]>([])
  const dbColumns = ref<ClientColumn[]>([])
  const dbRows = ref<Array<Record<string, unknown>>>([])
  /** 当前选择（engine 决定后续 tables/columns/rows 走哪条引擎分支） */
  const dbSelection = ref<{ database?: string; table?: string; engine?: DbEngine }>({})
  const dbLoading = ref(false)
  const dbError = ref('')

  /* ------------------------------ 字段仓库（原逻辑） ------------------------------ */
  const _repo = shallowRef<DataSourceRepository>(createMockDataSource())
  const sources = ref<DataSourceMeta[]>([])
  const activeSourceId = ref<string>('')
  const fieldCache = ref<Map<string, CacheEntry>>(new Map())
  const loading = ref(false)

  /** 预览/导出的明细行数（sample/ERP 模式合成用；数据库模式被真实行覆盖） */
  const previewRowCount = ref(30)

  const activeSource = computed(() => sources.value.find((s) => s.id === activeSourceId.value) ?? null)
  const activeFields = computed(() => fieldCache.value.get(activeSourceId.value)?.fields ?? [])
  /** 按 tableId+group 分组后的树形字段（DataSourceTree 渲染用） */
  const fieldTree = computed(() => {
    const fields = activeFields.value.filter((f) => !f.hidden)
    const tables = activeSource.value?.tables ?? []
    const byTable: Record<string, FieldDef[]> = {}
    for (const t of tables) byTable[t.id] = []
    for (const f of fields) {
      const tid = f.tableId ?? ''
      ;(byTable[tid] ??= []).push(f)
    }
    return tables.map((t) => ({
      table: t,
      fields: (byTable[t.id] ?? []).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    }))
  })

  /** 扁平字段列表（供 BindingEditor 下拉） */
  const flatFields = computed(() =>
    activeFields.value
      .filter((f) => !f.hidden)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
  )

  /** 预览数据：数据库模式用真实行，其余用 sample 按 previewRowCount 合成。
   *  预览面板与导出共用同一份，保证「预览 = 导出 = 打印」。 */
  const previewData = computed(() =>
    buildPreviewData(activeFields.value, {
      rows: previewRowCount.value,
      dataRows: kind.value === 'database' && dbRows.value.length ? dbRows.value : undefined,
    }),
  )

  /* ------------------------------ 持久化 ------------------------------ */
  function persist(): void {
    saveDataSourcePersisted({ kind: kind.value, dbEnabled: dbEnabled.value })
  }

  /** 非数据库模式下，按 kind 设置底层仓库（erp 已配 → http，否则 mock） */
  function setRepoToNonDb(): void {
    _repo.value =
      kind.value === 'erp' && isBackendConfigured
        ? createDataSourceHttp(getBackendConfig()!.options)
        : createMockDataSource()
  }

  /* ------------------------------ 数据库仓库构造 ------------------------------ */
  function buildDbRepo(): void {
    const { database, table } = dbSelection.value
    if (!database || !table || dbColumns.value.length === 0) return
    _repo.value = createClientDatabaseSource({
      database,
      table,
      columns: dbColumns.value,
      sampleRow: dbRows.value[0],
    })
  }

  /** 确保数据库数据已载入：已选表且有列 → 重建仓库；否则仅载入库列表 */
  async function ensureDbLoaded(): Promise<void> {
    if (dbSelection.value.database && dbSelection.value.table && dbColumns.value.length > 0) {
      buildDbRepo()
      await fetchSources()
      await fetchFields(true)
      return
    }
    // 尚未选表：清空示例/ERP 字段，避免残留字段显示在下方字段树
    sources.value = []
    fieldCache.value.clear()
    await loadDatabases()
  }

  /** 清空数据库探索器状态（关闭开关 / 客户端断开时调用） */
  function clearDbState(): void {
    dbDatabases.value = []
    dbTables.value = []
    dbColumns.value = []
    dbRows.value = []
    dbSelection.value = {}
    dbError.value = ''
  }

  /* ------------------------------ 操作 ------------------------------ */

  /** 注入后端仓库（保留入口，供测试/未来扩展；常规流程走 selectProvider） */
  function setRepository(repo: DataSourceRepository): void {
    _repo.value = repo
    fieldCache.value.clear()
  }

  /** 选择 provider（三选一）。ERP 未配置 / 数据库未开启时不切换底层仓库。 */
  async function selectProvider(next: DataSourceKind): Promise<void> {
    kind.value = next
    persist()
    if (next === 'database') {
      if (dbEnabled.value && dbAvailable.value) await ensureDbLoaded()
      else {
        sources.value = []
        fieldCache.value.clear()
      }
      return
    }
    clearDbState()
    setRepoToNonDb()
    await fetchSources()
    await fetchFields()
  }

  /** 手动开/关数据库数据源（连上客户端也不默认请求，必须手动开启） */
  async function setDbEnabled(enabled: boolean): Promise<void> {
    dbEnabled.value = enabled
    persist()
    if (enabled) {
      dbError.value = ''
      if (dbAvailable.value) await ensureDbLoaded()
    } else {
      clearDbState()
      if (kind.value === 'database') {
        sources.value = []
        fieldCache.value.clear()
      }
    }
  }

  /** 设置预览/导出的明细行数（仅 sample/ERP 合成生效，数据库真实行不受限） */
  function setPreviewRowCount(n: number): void {
    previewRowCount.value = Math.max(0, Math.floor(n))
  }

  async function fetchSources(): Promise<void> {
    sources.value = await _repo.value.listSources()
    if (!sources.value.find((s) => s.id === activeSourceId.value)) {
      activeSourceId.value = sources.value[0]?.id ?? ''
    }
  }

  async function fetchFields(forceRefresh = false): Promise<void> {
    const id = activeSourceId.value
    if (!id) return
    const cached = fieldCache.value.get(id)
    const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL
    if (fresh && !forceRefresh) return

    loading.value = true
    try {
      const fields = await _repo.value.getFields(id)
      fieldCache.value.set(id, { fields, fetchedAt: Date.now() })
    } finally {
      loading.value = false
    }
  }

  /** 初始化：按当前 provider 载入字段（canvas 挂载时调用） */
  async function init(): Promise<void> {
    if (kind.value === 'database') {
      if (dbEnabled.value && dbAvailable.value) await ensureDbLoaded()
      else {
        sources.value = []
        fieldCache.value.clear()
      }
      return
    }
    setRepoToNonDb()
    await fetchSources()
    await fetchFields()
  }

  /** 用户手动刷新（数据库模式 = 重新取数；其余 = 刷新字段） */
  async function refreshFields(): Promise<void> {
    if (kind.value === 'database') {
      await reloadRows()
      return
    }
    await fetchFields(true)
  }

  function selectSource(id: string): void {
    activeSourceId.value = id
    void fetchFields()
  }

  /* ------------------------------ 数据库探索器 ------------------------------ */

  async function loadDatabases(): Promise<void> {
    dbLoading.value = true
    dbError.value = ''
    try {
      const base = resolvePrinterBaseUrl()
      dbDatabases.value = await listClientDatabases(base)
    } catch (e) {
      dbError.value = describePrintError(e)
    } finally {
      dbLoading.value = false
    }
  }

  async function selectDatabase(name: string, engine?: DbEngine): Promise<void> {
    dbSelection.value = { database: name, table: undefined, engine }
    dbTables.value = []
    dbColumns.value = []
    dbRows.value = []
    dbError.value = ''
    await loadTables(name)
  }

  /** 列出某数据库的表（不改动当前已绑定表，供树形探索器按需加载） */
  async function loadTables(dbName?: string, engine?: DbEngine): Promise<ClientTable[]> {
    const database = dbName ?? dbSelection.value.database
    if (!database) return []
    dbLoading.value = true
    dbError.value = ''
    try {
      const base = resolvePrinterBaseUrl()
      const tables = await listClientTables(base, {
        database,
        engine: engine ?? dbSelection.value.engine,
      })
      dbTables.value = tables
      return tables
    } catch (e) {
      dbError.value = describePrintError(e)
      return []
    } finally {
      dbLoading.value = false
    }
  }

  async function selectTable(name: string, dbName?: string): Promise<void> {
    // 展开保留 engine：切表不能把引擎信息丢掉，否则 postgres 会退回 sqlite 分支
    dbSelection.value = {
      ...dbSelection.value,
      database: dbName ?? dbSelection.value.database,
      table: name,
    }
    await loadColumnsAndRows()
  }

  /** 选表后并行拉取列元信息与真实行，并构造仓库喂给字段树 */
  async function loadColumnsAndRows(): Promise<void> {
    const { database, table, engine } = dbSelection.value
    if (!database || !table) return
    dbLoading.value = true
    dbError.value = ''
    try {
      const base = resolvePrinterBaseUrl()
      const [cols, rowsRes] = await Promise.all([
        listClientColumns(base, { database, table, engine }),
        fetchClientRows(base, { database, table, engine, limit: ROWS_DEFAULT_LIMIT }),
      ])
      dbColumns.value = cols
      dbRows.value = rowsRes.rows
      buildDbRepo()
      await fetchSources()
      await fetchFields(true)
    } catch (e) {
      dbError.value = describePrintError(e)
    } finally {
      dbLoading.value = false
    }
  }

  /** 重新取数（保留当前库表选择） */
  async function reloadRows(): Promise<void> {
    const { database, table, engine } = dbSelection.value
    if (!database || !table) return
    dbLoading.value = true
    dbError.value = ''
    try {
      const base = resolvePrinterBaseUrl()
      const res = await fetchClientRows(base, { database, table, engine, limit: ROWS_DEFAULT_LIMIT })
      dbRows.value = res.rows
    } catch (e) {
      dbError.value = describePrintError(e)
    } finally {
      dbLoading.value = false
    }
  }

  /* ------------------------------ 客户端连接联动 ------------------------------ */
  watch(
    () => probe.state.value,
    (s) => {
      if (s === 'connected' && kind.value === 'database' && dbEnabled.value) {
        void ensureDbLoaded()
      }
      if (s !== 'connected' && kind.value === 'database') {
        // 客户端断开：清空已拉取数据，避免预览展示过期行
        clearDbState()
        sources.value = []
        fieldCache.value.clear()
      }
    },
  )

  return {
    // provider
    kind,
    dbEnabled,
    dbAvailable,
    erpAvailable,
    sampleAvailable,
    databaseAvailable,
    selectProvider,
    setDbEnabled,

    // 数据库探索器
    dbDatabases,
    dbTables,
    dbColumns,
    dbRows,
    dbSelection,
    dbLoading,
    dbError,
    loadDatabases,
    loadTables,
    selectDatabase,
    selectTable,
    reloadRows,

    // 字段仓库（原）
    sources,
    activeSourceId,
    activeSource,
    activeFields,
    fieldTree,
    flatFields,
    previewData,
    previewRowCount,
    setPreviewRowCount,
    loading,
    setRepository,
    init,
    fetchSources,
    fetchFields,
    refreshFields,
    selectSource,
  }
})
