import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDataSourceStore } from './dataSource'
import { usePrinterProbe } from '@/design/composables/usePrinterProbe'

const BASE = 'http://127.0.0.1:18888'

/** 按 URL 路由返回对应 /api/data/* 响应 */
function routeFetch() {
  return vi.fn(async (url: string) => {
    let body: unknown = { ok: true, rows: [] }
    if (url.includes('/api/data/databases')) {
      body = { ok: true, databases: [{ name: 'shop.db' }, { name: 'erp', engine: 'odbc' }] }
    } else if (url.includes('/api/data/tables')) {
      body = { ok: true, tables: [{ name: 'orders' }, { name: 'customers' }] }
    } else if (url.includes('/api/data/columns')) {
      body = {
        ok: true,
        columns: [
          { name: 'id', type: 'INTEGER', primary: true },
          { name: 'customer', type: 'TEXT' },
          { name: 'amount', type: 'DECIMAL(10,2)' },
        ],
      }
    } else if (url.includes('/api/data/rows')) {
      body = {
        ok: true,
        database: 'shop.db',
        table: 'orders',
        rows: [
          { id: 1, customer: '甲', amount: 99.5 },
          { id: 2, customer: '乙', amount: 12 },
        ],
      }
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    } as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.unstubAllGlobals()
  setActivePinia(createPinia())
  localStorage.clear()
  // 强制打印客户端已连接（不自动拉取，需手动开启）
  usePrinterProbe().state.value = 'connected'
})

describe('dataSource store 三选一', () => {
  it('默认 kind=sample，初始化载入 Mock 字段', async () => {
    const store = useDataSourceStore()
    await store.init()
    expect(store.kind).toBe('sample')
    expect(store.sources.length).toBeGreaterThan(0)
    expect(store.activeFields.length).toBeGreaterThan(0)
    // 预览数据由 sample 合成
    expect(Object.keys(store.previewData).length).toBeGreaterThan(0)
  })

  it('切到 ERP（未配置时不切换仓库，回落 sample 行为）', async () => {
    const store = useDataSourceStore()
    await store.selectProvider('erp')
    // 测试环境无 VITE_OPENPRINT_API_BASE → erpAvailable=false，但 kind 仍记录为用户意图
    expect(store.kind).toBe('erp')
  })

  it('数据库：手动开启 → 四步探索 → 字段与真实行可用', async () => {
    vi.stubGlobal('fetch', routeFetch())
    const store = useDataSourceStore()
    await store.selectProvider('database')
    expect(store.kind).toBe('database')

    // 手动开启（连上客户端也不默认请求，必须这一步）
    await store.setDbEnabled(true)
    expect(store.dbEnabled).toBe(true)

    // Step1 列库（setDbEnabled 已 await 载入）
    expect(store.dbDatabases.length).toBe(2)
    expect(store.dbDatabases.map((d) => d.name)).toContain('shop.db')

    // Step2 选库 → 列表
    await store.selectDatabase('shop.db')
    expect(store.dbSelection.database).toBe('shop.db')
    expect(store.dbTables.length).toBe(2)

    // Step3/4 选表 → 列 + 行
    await store.selectTable('orders')
    expect(store.dbColumns.length).toBe(3)
    expect(store.dbRows.length).toBe(2)

    // 仓库已构造，字段树可绑定
    expect(store.fieldTree.length).toBe(1)
    const paths = store.flatFields.map((f) => f.path)
    expect(paths).toContain('items[].customer')
    expect(paths).toContain('items[].amount')

    // 预览数据用真实行（不是 sample 合成）
    const data = store.previewData as Record<string, unknown>
    const items = data.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    expect(items[0]!.customer).toBe('甲')
    expect(items[1]!.amount).toBe(12)
  })

  it('数据库：关闭开关清空已拉取数据', async () => {
    vi.stubGlobal('fetch', routeFetch())
    const store = useDataSourceStore()
    await store.selectProvider('database')
    await store.setDbEnabled(true)
    expect(store.dbDatabases.length).toBe(2)
    await store.selectDatabase('shop.db')
    expect(store.dbTables.length).toBe(2)
    await store.selectTable('orders')
    expect(store.dbColumns.length).toBe(3)

    await store.setDbEnabled(false)
    expect(store.dbEnabled).toBe(false)
    expect(store.dbDatabases.length).toBe(0)
    expect(store.dbRows.length).toBe(0)
    expect(store.flatFields.length).toBe(0)
  })

  it('导出数据一致性：sample 用 rowCount 合成，database 忽略 rowCount 用真实行', async () => {
    // sample 模式：previewData 的明细行数受 previewRowCount 控制（导出滑块的落点）
    const sampleStore = useDataSourceStore()
    await sampleStore.init()
    expect(sampleStore.kind).toBe('sample')
    sampleStore.setPreviewRowCount(5)
    const data5 = sampleStore.previewData as Record<string, unknown>
    expect((data5.items as unknown[]).length).toBe(5)
    sampleStore.setPreviewRowCount(50)
    expect((sampleStore.previewData as Record<string, unknown>).items as unknown[]).toHaveLength(50)

    // database 模式：真实行优先，previewRowCount 不应覆盖
    vi.stubGlobal('fetch', routeFetch())
    const dbStore = useDataSourceStore()
    await dbStore.selectProvider('database')
    await dbStore.setDbEnabled(true)
    await dbStore.selectDatabase('shop.db')
    await dbStore.selectTable('orders')
    dbStore.setPreviewRowCount(999)
    const dbData = dbStore.previewData as Record<string, unknown>
    const dbItems = dbData.items as Array<Record<string, unknown>>
    expect(dbItems).toHaveLength(2)
    expect(dbItems[0]!.customer).toBe('甲')
  })

  it('切到数据库（未开启/未选表）时清空字段树，不残留示例字段', async () => {
    const store = useDataSourceStore()
    await store.init()
    expect(store.kind).toBe('sample')
    expect(store.flatFields.length).toBeGreaterThan(0) // 示例字段已载入
    await store.selectProvider('database')
    expect(store.kind).toBe('database')
    // 未开启/未选表：下方字段树应清空，不应再显示示例数据字段
    expect(store.flatFields.length).toBe(0)
    expect(store.sources.length).toBe(0)
  })

  it('树形探索 loadTables 不清除已绑定表的列与字段', async () => {
    vi.stubGlobal('fetch', routeFetch())
    const store = useDataSourceStore()
    await store.selectProvider('database')
    await store.setDbEnabled(true)
    await store.selectDatabase('shop.db')
    await store.selectTable('orders')
    expect(store.dbColumns.length).toBe(3)
    expect(store.flatFields.length).toBeGreaterThan(0)

    // 树中展开另一个数据库（仅加载其表，不应清除当前绑定表）
    const otherTables = await store.loadTables('erp')
    expect(otherTables.length).toBe(2)
    expect(store.dbColumns.length).toBe(3) // 仍保留 orders 的列
    expect(store.flatFields.length).toBeGreaterThan(0)
  })

  it('postgres 引擎透传：选库/选表/列/行请求都带 engine=postgres', async () => {
    const urls: string[] = []
    const inner = routeFetch() as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url)
        return inner(url, init)
      }),
    )
    const store = useDataSourceStore()
    await store.selectProvider('database')
    await store.setDbEnabled(true)

    await store.selectDatabase('pg1', 'postgres')
    expect(store.dbSelection.engine).toBe('postgres')
    // 切表不能把引擎丢掉（否则后端会退回 sqlite 分支）
    await store.selectTable('v_export_czdetail')
    expect(store.dbSelection.engine).toBe('postgres')

    const pick = (frag: string) => urls.filter((u) => u.includes(frag))
    const tableUrls = pick('/api/data/tables')
    const colUrls = pick('/api/data/columns')
    const rowUrls = pick('/api/data/rows')
    expect(tableUrls.length).toBeGreaterThan(0)
    expect(colUrls.length).toBeGreaterThan(0)
    expect(rowUrls.length).toBeGreaterThan(0)
    for (const u of [...tableUrls, ...colUrls, ...rowUrls]) {
      expect(u).toContain('engine=postgres')
    }
  })
})
