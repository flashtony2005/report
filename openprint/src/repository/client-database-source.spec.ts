import { describe, it, expect } from 'vitest'
import { createClientDatabaseSource, DB_ARRAY_PREFIX } from './client-database-source'
import type { ClientColumn } from '@/core/print-client'

const COLUMNS: ClientColumn[] = [
  { name: 'id', type: 'INTEGER', primary: true },
  { name: 'name', type: 'TEXT' },
  { name: 'price', type: 'DECIMAL(10,2)' },
  { name: 'created_at', type: 'DATETIME' },
  { name: 'enabled', type: 'BOOLEAN' },
  { name: 'avatar', type: 'BLOB' },
]

describe('createClientDatabaseSource', () => {
  it('listSources 返回单个库/表结构，表为数组', async () => {
    const repo = createClientDatabaseSource({ database: 'shop.db', table: 'orders', columns: COLUMNS })
    const sources = await repo.listSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.id).toBe('shop.db')
    expect(sources[0]!.name).toBe('shop.db / orders')
    const table = sources[0]!.tables![0]!
    expect(table.isArray).toBe(true)
    expect(table.pathPrefix).toBe(DB_ARRAY_PREFIX)
  })

  it('字段 path 统一走 items[].col 前缀', async () => {
    const repo = createClientDatabaseSource({ database: 'd', table: 't', columns: COLUMNS })
    const fields = await repo.getFields('')
    expect(fields[0]!.path).toBe(`${DB_ARRAY_PREFIX}[].id`)
    expect(fields.every((f) => f.path.startsWith(`${DB_ARRAY_PREFIX}[].`))).toBe(true)
  })

  it('类型映射正确（含带括号的 DECIMAL / 图像 / 布尔 / 日期）', async () => {
    const repo = createClientDatabaseSource({ database: 'd', table: 't', columns: COLUMNS })
    const fields = await repo.getFields('')
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f.type]))
    expect(byPath[`${DB_ARRAY_PREFIX}[].id`]).toBe('number')
    expect(byPath[`${DB_ARRAY_PREFIX}[].price`]).toBe('number')
    expect(byPath[`${DB_ARRAY_PREFIX}[].name`]).toBe('string')
    expect(byPath[`${DB_ARRAY_PREFIX}[].created_at`]).toBe('date')
    expect(byPath[`${DB_ARRAY_PREFIX}[].enabled`]).toBe('boolean')
    expect(byPath[`${DB_ARRAY_PREFIX}[].avatar`]).toBe('image')
  })

  it('主键排在前面并归入「主键」分组', async () => {
    const repo = createClientDatabaseSource({ database: 'd', table: 't', columns: COLUMNS })
    const fields = await repo.getFields('')
    expect(fields[0]!.group).toBe('主键')
    expect(fields[0]!.sort).toBe(-1)
    expect(fields.find((f) => f.path.endsWith('[].name'))!.group).toBe('字段')
  })

  it('sample 取自行首行', async () => {
    const repo = createClientDatabaseSource({
      database: 'd',
      table: 't',
      columns: COLUMNS,
      sampleRow: { id: 7, name: '测试' },
    })
    const fields = await repo.getFields('')
    expect(fields.find((f) => f.path.endsWith('[].id'))!.sample).toBe(7)
    expect(fields.find((f) => f.path.endsWith('[].name'))!.sample).toBe('测试')
  })
})
