import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listClientDatabases,
  listClientTables,
  listClientColumns,
  fetchClientRows,
  postClientRows,
  ROWS_DEFAULT_LIMIT,
  ROWS_MAX_LIMIT,
} from './client'
import { PrintClientError, normalizeDbEngine } from './types'

const BASE = 'http://127.0.0.1:18888'

/** 模拟 fetch 返回；记录最近一次调用的 URL 便于断言 query 拼装 */
function mockFetch(response: unknown, ok = true) {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    return {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Server Error',
      json: async () => (typeof response === 'string' ? JSON.parse(response) : response),
      text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
      headers: new Headers({ 'content-type': 'application/json' }),
    } as Response
  })
  return fn as unknown as typeof fetch
}

let lastUrl = ''
function capturingFetch(response: unknown, ok = true) {
  const fn = vi.fn(async (url: string) => {
    lastUrl = url
    return mockFetch(response, ok)(url)
  })
  return fn as unknown as typeof fetch
}

beforeEach(() => {
  vi.unstubAllGlobals()
  lastUrl = ''
})

describe('listClientDatabases', () => {
  it('归一化数据库列表', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ok: true, databases: [{ name: 'main.db' }, { name: 'erp', engine: 'odbc' }] }),
    )
    const dbs = await listClientDatabases(BASE)
    expect(dbs).toHaveLength(2)
    expect(dbs[0]).toEqual({ name: 'main.db', engine: 'sqlite' })
    expect(dbs[1]!.engine).toBe('odbc')
  })

  it('兼容纯字符串库名数组（客户端真实形态 databases:["byb"]）', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true, databases: ['byb', 'erp'] }))
    const dbs = await listClientDatabases(BASE)
    expect(dbs).toEqual([
      { name: 'byb', engine: 'sqlite', label: undefined },
      { name: 'erp', engine: 'sqlite', label: undefined },
    ])
  })

  it('postgres 引擎不被降级为 sqlite（含别名写法）', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ok: true,
        databases: [
          { name: 'pg1', engine: 'postgres' },
          { name: 'pg2', engine: 'postgresql' },
          { name: 'pg3', engine: 'pgsql' },
          { name: 'pg4', engine: 'PG' },
        ],
      }),
    )
    const dbs = await listClientDatabases(BASE)
    expect(dbs.map((d) => d.engine)).toEqual(['postgres', 'postgres', 'postgres', 'postgres'])
  })

  it('缺 databases 数组 → parse 错误', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true }))
    await expect(listClientDatabases(BASE)).rejects.toThrow(/databases 数组/)
  })
})

describe('normalizeDbEngine', () => {
  it('已知引擎与别名归一，其余回落 sqlite', () => {
    expect(normalizeDbEngine('sqlite')).toBe('sqlite')
    expect(normalizeDbEngine('odbc')).toBe('odbc')
    expect(normalizeDbEngine('postgres')).toBe('postgres')
    expect(normalizeDbEngine('  PostgreSQL ')).toBe('postgres')
    expect(normalizeDbEngine('pgsql')).toBe('postgres')
    expect(normalizeDbEngine('mysql')).toBe('sqlite')
    expect(normalizeDbEngine(undefined)).toBe('sqlite')
    expect(normalizeDbEngine(42)).toBe('sqlite')
  })
})

describe('listClientTables', () => {
  it('带 database query 拼装', async () => {
    vi.stubGlobal('fetch', capturingFetch({ ok: true, tables: [{ name: 'orders' }] }))
    const tables = await listClientTables(BASE, { database: 'main.db' })
    expect(tables[0]!.name).toBe('orders')
    expect(lastUrl).toContain('/api/data/tables?')
    expect(lastUrl).toContain('database=main.db')
  })

  it('engine 透传进 query（postgres 不会被丢掉）', async () => {
    vi.stubGlobal('fetch', capturingFetch({ ok: true, tables: [{ name: 'v_export_czdetail' }] }))
    await listClientTables(BASE, { database: 'pg1', engine: 'postgres' })
    expect(lastUrl).toContain('engine=postgres')
    expect(lastUrl).toContain('database=pg1')
  })

  it('兼容纯字符串表名数组（客户端真实形态 tables:["user"]）', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true, tables: ['user', 'orders'] }))
    const tables = await listClientTables(BASE, { database: 'byb' })
    expect(tables).toEqual([
      { name: 'user', type: undefined },
      { name: 'orders', type: undefined },
    ])
  })
})

describe('listClientColumns', () => {
  it('归一化列元信息（含主键/类型）', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ok: true,
        columns: [{ name: 'id', type: 'INTEGER', primary: true }, { name: 'name', type: 'TEXT' }],
      }),
    )
    const cols = await listClientColumns(BASE, { database: 'main.db', table: 'orders' })
    expect(cols[0]).toMatchObject({ name: 'id', type: 'INTEGER', primary: true })
    expect(cols[1]!.nullable).toBe(true)
  })

  it('兼容后端 key:"PRI"/"UNI" 标记（客户端真实形态）', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ok: true,
        columns: [
          { comment: '', key: 'PRI', name: 'id', nullable: false, type: 'int' },
          { comment: '', key: 'UNI', name: 'username', nullable: false, type: 'varchar(80)' },
          { comment: '', key: '', name: 'password', nullable: false, type: 'varchar(100)' },
        ],
      }),
    )
    const cols = await listClientColumns(BASE, { database: 'byb', table: 'user' })
    expect(cols[0]).toMatchObject({ name: 'id', primary: true, key: 'PRI' })
    expect(cols[1]).toMatchObject({ name: 'username', primary: false, key: 'UNI' })
    expect(cols[2]).toMatchObject({ name: 'password', primary: false, key: undefined })
  })
})

describe('fetchClientRows', () => {
  it('返回行 + total 兜底', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ ok: true, database: 'main.db', table: 'orders', rows: [{ id: 1 }, { id: 2 }] }),
    )
    const res = await fetchClientRows(BASE, { database: 'main.db', table: 'orders', limit: 50 })
    expect(res.rows).toHaveLength(2)
    expect(res.total).toBe(2)
    expect(res.database).toBe('main.db')
  })

  it('limit 被钳制到上限', async () => {
    vi.stubGlobal('fetch', capturingFetch({ ok: true, rows: [] }))
    await fetchClientRows(BASE, { limit: 9999 })
    expect(lastUrl).toContain(`limit=${ROWS_MAX_LIMIT}`)
  })

  it('默认上限为 ROWS_DEFAULT_LIMIT', async () => {
    vi.stubGlobal('fetch', capturingFetch({ ok: true, rows: [] }))
    await fetchClientRows(BASE)
    expect(lastUrl).toContain(`limit=${ROWS_DEFAULT_LIMIT}`)
  })

  it('fields 逗号列表透传', async () => {
    vi.stubGlobal('fetch', capturingFetch({ ok: true, rows: [] }))
    await fetchClientRows(BASE, { database: 'd', table: 't', fields: 'id,name' })
    expect(lastUrl).toContain('fields=id%2Cname')
  })
})

describe('postClientRows', () => {
  it('POST + where/params 走请求体', async () => {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      lastUrl = url
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body.where).toBe('amount > ?')
      expect(body.params).toEqual([100])
      return mockFetch({ ok: true, rows: [{ id: 1 }] })(url, init)
    })
    vi.stubGlobal('fetch', fn as unknown as typeof fetch)
    const res = await postClientRows({ database: 'd', table: 't', where: 'amount > ?', params: [100] })
    expect(res.rows).toHaveLength(1)
    expect(lastUrl).toBe(`${BASE}/api/data/rows`)
  })
})

describe('错误分类', () => {
  it('ok:false → service', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, message: '库未连接' }, false))
    await expect(listClientDatabases(BASE)).rejects.toBeInstanceOf(PrintClientError)
  })
})
