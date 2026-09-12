import { describe, it, expect, beforeEach } from 'vitest'

// import.meta.env 在测试环境无 VITE_OPENPRINT_API_BASE → isBackendConfigured=false
import {
  DATA_SOURCE_KIND_LABEL,
  defaultDataSourceKind,
  fieldTreeEmptyHint,
  isErpConfigured,
  loadDataSourcePersisted,
  saveDataSourcePersisted,
  DATA_SOURCE_STORAGE_KEY,
  type DataSourceKind,
} from './data-source'

describe('data-source 配置层', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('未配置后端时 ERP 不可用，默认回落示例数据', () => {
    expect(isErpConfigured()).toBe(false)
    expect(defaultDataSourceKind()).toBe('sample')
  })

  it('标签齐备', () => {
    expect(DATA_SOURCE_KIND_LABEL.erp).toContain('ERP')
    expect(DATA_SOURCE_KIND_LABEL.database).toContain('数据库')
    expect(DATA_SOURCE_KIND_LABEL.sample).toContain('示例')
  })

  it('持久化：默认 dbEnabled=false', () => {
    expect(loadDataSourcePersisted()).toEqual({ kind: 'sample', dbEnabled: false })
  })

  it('保存后可读回，且 dbEnabled 持久化', () => {
    const value = { kind: 'database' as DataSourceKind, dbEnabled: true }
    saveDataSourcePersisted(value)
    expect(loadDataSourcePersisted()).toEqual(value)
  })

  it('持久化损坏时回落默认', () => {
    window.localStorage.setItem(DATA_SOURCE_STORAGE_KEY, 'not json')
    expect(loadDataSourcePersisted()).toEqual({ kind: 'sample', dbEnabled: false })
  })

  it('持久化 kind 非法时回落默认', () => {
    window.localStorage.setItem(DATA_SOURCE_STORAGE_KEY, JSON.stringify({ kind: 'bogus', dbEnabled: true }))
    expect(loadDataSourcePersisted().kind).toBe('sample')
  })
})

describe('字段树空态提示 fieldTreeEmptyHint', () => {
  it('搜索无结果时优先提示"没有匹配"', () => {
    expect(fieldTreeEmptyHint({ kind: 'database', dbEnabled: false, keyword: ' zzz ' })).toBe(
      '没有匹配的字段',
    )
  })

  it('数据库模式：未启用开关 → 指向开关', () => {
    const hint = fieldTreeEmptyHint({ kind: 'database', dbEnabled: false })
    expect(hint).toContain('未启用')
    expect(hint).toContain('启用数据库数据源')
  })

  it('数据库模式：已启用但未选表 → 指向选择数据库/展开表', () => {
    expect(fieldTreeEmptyHint({ kind: 'database', dbEnabled: true, dbTable: '' })).toContain(
      '数据表',
    )
  })

  it('数据库模式：已选表但无字段 → 说明是该表没有字段', () => {
    expect(fieldTreeEmptyHint({ kind: 'database', dbEnabled: true, dbTable: 'orders' })).toBe(
      '该表没有可用字段',
    )
  })

  it('ERP / 示例数据各自的兜底文案', () => {
    expect(fieldTreeEmptyHint({ kind: 'erp' })).toContain('ERP')
    expect(fieldTreeEmptyHint({ kind: 'sample' })).toBe('暂无字段')
  })
})
