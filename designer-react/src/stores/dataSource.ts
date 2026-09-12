/**
 * dataSource store —— 数据源三选一（ERP 接口 / 数据库 / 示例数据）+ 字段缓存
 *
 * 从 Vue 版 `src/design/stores/dataSource.ts` 1:1 迁移。
 *
 * 迁移要点：
 * - Vue `computed` → 导出的 selector 函数（selectFieldTree / selectFlatFields / selectPreviewData …）
 * - Vue `watch(probe.state, …)` → 不再自动监听；改为暴露 `onPrinterStateChange(s)`，
 *   由 App 层 `usePrinterProbeStore.subscribe(...)` 驱动（React 里显式订阅更可控）
 * - `shallowRef` 的 repository 实例 → 模块级变量（zustand state 会深度冻结语义不一致）
 */
import { create } from 'zustand'
import type { DataSourceRepository, DataSourceMeta, FieldDef } from '@/types/datasource'
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

/** 字段仓库实例 —— 刻意放在 store 之外（等价 Vue 版的 shallowRef，避免被深度代理） */
let repo: DataSourceRepository = createMockDataSource()

/**
 * 字段缓存 —— 同样放在 store 之外（与 repo 同理）。
 *
 * 必须放在外面的原因：`selectActiveFields` 是模块级派生函数，读不到 `create()` 闭包内的变量。
 * 若放闭包内，派生函数只能返回空数组，进而让「设计期动态配色」永远拿到空样例数据（退化成无配色）。
 */
const fieldCache = new Map<string, CacheEntry>()

interface DataSourceState {
  /* provider 三选一 */
  kind: DataSourceKind
  /** 数据库是否手动开启（连上客户端也不默认请求，必须手动开启） */
  dbEnabled: boolean
  /** 本地打印客户端是否已连接 */
  dbAvailable: boolean

  /* 数据库探索器 */
  dbDatabases: ClientDatabase[]
  dbTables: ClientTable[]
  dbColumns: ClientColumn[]
  dbRows: Array<Record<string, unknown>>
  /** 当前选择（engine 决定后续 tables/columns/rows 走哪条引擎分支） */
  dbSelection: { database?: string; table?: string; engine?: DbEngine }
  dbLoading: boolean
  dbError: string

  /* 字段仓库 */
  sources: DataSourceMeta[]
  activeSourceId: string
  loading: boolean
  /** 预览/导出的明细行数 */
  previewRowCount: number
}

interface DataSourceActions {
  selectProvider: (next: DataSourceKind) => Promise<void>
  setDbEnabled: (enabled: boolean) => Promise<void>
  setPreviewRowCount: (n: number) => void
  setRepository: (r: DataSourceRepository) => void
  init: () => Promise<void>
  fetchSources: () => Promise<void>
  fetchFields: (forceRefresh?: boolean) => Promise<void>
  refreshFields: () => Promise<void>
  selectSource: (id: string) => void

  loadDatabases: () => Promise<void>
  loadTables: (dbName?: string, engine?: DbEngine) => Promise<ClientTable[]>
  selectDatabase: (name: string, engine?: DbEngine) => Promise<void>
  selectTable: (name: string, dbName?: string) => Promise<void>
  reloadRows: () => Promise<void>

  /** 替代 Vue 版的 watch(probe.state)：由 App 层订阅 probe store 后调用 */
  setPrinterConnected: (connected: boolean) => void
  onPrinterStateChange: (s: 'idle' | 'checking' | 'connected' | 'disconnected') => void

  $reset: () => void
}

export type DataSourceStore = DataSourceState & DataSourceActions

const persisted = loadDataSourcePersisted()

const initialState: DataSourceState = {
  kind: persisted.kind,
  dbEnabled: persisted.dbEnabled,
  dbAvailable: false,
  dbDatabases: [],
  dbTables: [],
  dbColumns: [],
  dbRows: [],
  dbSelection: {},
  dbLoading: false,
  dbError: '',
  sources: [],
  activeSourceId: '',
  loading: false,
  previewRowCount: 30,
}

export const useDataSourceStore = create<DataSourceStore>((set, get) => {
  const persist = (): void => {
    const { kind, dbEnabled } = get()
    saveDataSourcePersisted({ kind, dbEnabled })
  }

  /** 非数据库模式下，按 kind 设置底层仓库（erp 已配 → http，否则 mock） */
  const setRepoToNonDb = (): void => {
    repo =
      get().kind === 'erp' && isBackendConfigured
        ? createDataSourceHttp(getBackendConfig()!.options)
        : createMockDataSource()
  }

  const buildDbRepo = (): void => {
    const { dbSelection, dbColumns, dbRows } = get()
    const { database, table } = dbSelection
    if (!database || !table || dbColumns.length === 0) return
    repo = createClientDatabaseSource({
      database,
      table,
      columns: dbColumns,
      sampleRow: dbRows[0],
    })
  }

  const clearDbState = (): void => {
    set({ dbDatabases: [], dbTables: [], dbColumns: [], dbRows: [], dbSelection: {}, dbError: '' })
  }

  const ensureDbLoaded = async (): Promise<void> => {
    const { dbSelection, dbColumns } = get()
    if (dbSelection.database && dbSelection.table && dbColumns.length > 0) {
      buildDbRepo()
      await get().fetchSources()
      await get().fetchFields(true)
      return
    }
    // 尚未选表：清空示例/ERP 字段，避免残留字段显示在下方字段树
    set({ sources: [] })
    fieldCache.clear()
    await get().loadDatabases()
  }

  const loadColumnsAndRows = async (): Promise<void> => {
    const { database, table, engine } = get().dbSelection
    if (!database || !table) return
    set({ dbLoading: true, dbError: '' })
    try {
      const base = resolvePrinterBaseUrl()
      const [cols, rowsRes] = await Promise.all([
        listClientColumns(base, { database, table, engine }),
        fetchClientRows(base, { database, table, engine, limit: ROWS_DEFAULT_LIMIT }),
      ])
      set({ dbColumns: cols, dbRows: rowsRes.rows })
      buildDbRepo()
      await get().fetchSources()
      await get().fetchFields(true)
    } catch (e) {
      set({ dbError: describePrintError(e) })
    } finally {
      set({ dbLoading: false })
    }
  }

  return {
    ...initialState,

    selectProvider: async (next) => {
      set({ kind: next })
      persist()
      if (next === 'database') {
        if (get().dbEnabled && get().dbAvailable) await ensureDbLoaded()
        else {
          set({ sources: [] })
          fieldCache.clear()
        }
        return
      }
      clearDbState()
      setRepoToNonDb()
      await get().fetchSources()
      await get().fetchFields()
    },

    setDbEnabled: async (enabled) => {
      set({ dbEnabled: enabled })
      persist()
      if (enabled) {
        set({ dbError: '' })
        if (get().dbAvailable) await ensureDbLoaded()
      } else {
        clearDbState()
        if (get().kind === 'database') {
          set({ sources: [] })
          fieldCache.clear()
        }
      }
    },

    setPreviewRowCount: (n) => set({ previewRowCount: Math.max(0, Math.floor(n)) }),

    setRepository: (r) => {
      repo = r
      fieldCache.clear()
    },

    fetchSources: async () => {
      const sources = await repo.listSources()
      const cur = get().activeSourceId
      set({
        sources,
        activeSourceId: sources.find((s) => s.id === cur) ? cur : (sources[0]?.id ?? ''),
      })
    },

    fetchFields: async (forceRefresh = false) => {
      const id = get().activeSourceId
      if (!id) return
      const cached = fieldCache.get(id)
      const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL
      if (fresh && !forceRefresh) return
      set({ loading: true })
      try {
        const fields = await repo.getFields(id)
        fieldCache.set(id, { fields, fetchedAt: Date.now() })
      } finally {
        set({ loading: false })
      }
    },

    init: async () => {
      if (get().kind === 'database') {
        if (get().dbEnabled && get().dbAvailable) await ensureDbLoaded()
        else {
          set({ sources: [] })
          fieldCache.clear()
        }
        return
      }
      setRepoToNonDb()
      await get().fetchSources()
      await get().fetchFields()
    },

    refreshFields: async () => {
      if (get().kind === 'database') {
        await get().reloadRows()
        return
      }
      await get().fetchFields(true)
    },

    selectSource: (id) => {
      set({ activeSourceId: id })
      void get().fetchFields()
    },

    loadDatabases: async () => {
      set({ dbLoading: true, dbError: '' })
      try {
        const base = resolvePrinterBaseUrl()
        set({ dbDatabases: await listClientDatabases(base) })
      } catch (e) {
        set({ dbError: describePrintError(e) })
      } finally {
        set({ dbLoading: false })
      }
    },

    loadTables: async (dbName, engine) => {
      const database = dbName ?? get().dbSelection.database
      if (!database) return []
      set({ dbLoading: true, dbError: '' })
      try {
        const base = resolvePrinterBaseUrl()
        const tables = await listClientTables(base, {
          database,
          engine: engine ?? get().dbSelection.engine,
        })
        set({ dbTables: tables })
        return tables
      } catch (e) {
        set({ dbError: describePrintError(e) })
        return []
      } finally {
        set({ dbLoading: false })
      }
    },

    selectDatabase: async (name, engine) => {
      set({
        dbSelection: { database: name, table: undefined, engine },
        dbTables: [],
        dbColumns: [],
        dbRows: [],
        dbError: '',
      })
      await get().loadTables(name)
    },

    selectTable: async (name, dbName) => {
      // 展开保留 engine：切表不能把引擎信息丢掉，否则 postgres 会退回 sqlite 分支
      set({
        dbSelection: {
          ...get().dbSelection,
          database: dbName ?? get().dbSelection.database,
          table: name,
        },
      })
      await loadColumnsAndRows()
    },

    reloadRows: async () => {
      const { database, table, engine } = get().dbSelection
      if (!database || !table) return
      set({ dbLoading: true, dbError: '' })
      try {
        const base = resolvePrinterBaseUrl()
        const res = await fetchClientRows(base, { database, table, engine, limit: ROWS_DEFAULT_LIMIT })
        set({ dbRows: res.rows })
      } catch (e) {
        set({ dbError: describePrintError(e) })
      } finally {
        set({ dbLoading: false })
      }
    },

    setPrinterConnected: (connected) => set({ dbAvailable: connected }),

    onPrinterStateChange: (s) => {
      const connected = s === 'connected'
      get().setPrinterConnected(connected)
      const { kind, dbEnabled } = get()
      if (connected && kind === 'database' && dbEnabled) {
        void ensureDbLoaded()
      }
      if (!connected && kind === 'database') {
        // 客户端断开：清空已拉取数据，避免预览展示过期行
        clearDbState()
        set({ sources: [] })
        fieldCache.clear()
      }
    },

    $reset: () => set({ ...initialState }),
  }
})

/* ------------------------------ 派生值（原 computed） ------------------------------ */

export function selectActiveFields(s: { activeSourceId: string }): FieldDef[] {
  return fieldCache.get(s.activeSourceId)?.fields ?? []
}

/* --------------------------- previewData（等价 Vue computed） --------------------------- */

/** memo 缓存：依赖指纹不变则复用上一次结果（避免渲染热路径重复计算） */
let previewCacheKey = ''
let previewCacheValue: unknown = null

/** 预览数据：数据库模式用真实行，其余用 sample 按 previewRowCount 合成。
 *  预览面板、字段选择弹窗示例值、设计期动态配色共用同一份 ——「预览 = 弹窗 = 画布」。 */
export function selectPreviewData(s: DataSourceStore): unknown {
  const fields = selectActiveFields(s)
  const dataRows = s.kind === 'database' && s.dbRows.length ? s.dbRows : undefined
  // 依赖指纹：字段数 + 首字段路径 + 行数 + 数据行数（够用且廉价）
  const key = `${fields.length}|${fields[0]?.path ?? ''}|${s.previewRowCount}|${dataRows?.length ?? 0}`
  if (key !== previewCacheKey) {
    previewCacheKey = key
    previewCacheValue = buildPreviewData(fields, { rows: s.previewRowCount, dataRows })
  }
  return previewCacheValue
}

/** 测试用：清空 previewData memo 缓存 */
export function resetPreviewDataCache(): void {
  previewCacheKey = ''
  previewCacheValue = null
}

/** 可绑定字段（过滤 hidden + 按 sort 排序）—— 等价 Vue 版 flatFields computed
 *  带 memo：zustand v5 按引用比较 selector 结果，每次返回新数组会触发无限重渲染
 *  （P4.1 修复：ExpressionModal 首个订阅此 selector 暴露了该问题）。
 *  依赖指纹：数据源 id + 过滤后字段数 + 路径/hidden/sort 拼串，不变时返回稳定引用。 */
let flatCacheKey = ''
let flatCacheValue: FieldDef[] = []

export function selectFlatFields(s: DataSourceStore): FieldDef[] {
  const all = selectActiveFields(s)
  const visible = all.filter((f) => !f.hidden)
  const key = `${s.activeSourceId}|${visible.length}|${visible
    .map((f) => `${f.path},${f.hidden ? 1 : 0},${f.sort ?? 0}`)
    .join(';')}`
  if (key !== flatCacheKey) {
    flatCacheKey = key
    flatCacheValue = [...visible].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  }
  return flatCacheValue
}

/** 按表分组的树形字段（VariableModal / DataSourceTree 渲染用）—— 等价 Vue 版 fieldTree computed
 *  带 memo：zustand v5 按引用比较 selector 结果，若每次返回新数组会触发无限重渲染，
 *  因此依赖指纹不变时返回稳定引用（与 selectPreviewData 同策略）。 */
let treeCacheKey = ''
let treeCacheValue: { table: { id: string; name: string }; fields: FieldDef[] }[] = []

export function selectFieldTree(s: DataSourceStore): {
  table: { id: string; name: string; isArray?: boolean }
  fields: FieldDef[]
}[] {
  const fields = selectActiveFields(s).filter((f) => !f.hidden)
  const tables = selectActiveSource(s)?.tables ?? []
  const key = `${s.activeSourceId}|${fields.length}|${tables.map((t) => t.id).join(',')}`
  if (key !== treeCacheKey) {
    const byTable: Record<string, FieldDef[]> = {}
    for (const t of tables) byTable[t.id] = []
    for (const f of fields) {
      const tid = f.tableId ?? ''
      ;(byTable[tid] ??= []).push(f)
    }
    treeCacheValue = tables.map((t) => ({
      table: t,
      fields: (byTable[t.id] ?? []).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    }))
    treeCacheKey = key
  }
  return treeCacheValue
}

export const selectActiveSource = (s: DataSourceStore): DataSourceMeta | null =>
  s.sources.find((x) => x.id === s.activeSourceId) ?? null

/** ERP 是否可用（代码层配置决定） */
export const selectErpAvailable = (): boolean => isErpConfigured()

/** 示例数据永远可用（内置 Mock，零后端） */
export const selectSampleAvailable = (): boolean => true

export const selectDatabaseAvailable = (s: DataSourceStore): boolean => s.dbAvailable && s.dbEnabled
