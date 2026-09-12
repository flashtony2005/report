/**
 * createClientDatabaseSource —— 本地客户端数据库连接的数据源仓库
 *
 * 由数据源探索器选好「库 + 表」后，用客户端返回的列元信息与真实行构造。
 * 与 createMockDataSource / createDataSourceHttp 同 DataSourceRepository 接口，
 * 整体替换无分支。字段统一走 `items[]` 数组前缀，契合表格 `items[].xxx` 绑定习惯。
 *
 * 注意：本仓库只提供「字段定义 + 单表结构」，真实数据行由 dataSource store 的
 * dbRows 持有并直接喂给预览（不再经 FieldDef.sample 合成）。
 */
import type { DataSourceMeta, DataSourceRepository, FieldDef, TableMeta } from '@/types/datasource'
import type { ClientColumn } from '@/core/print-client'

/** 明细数组路径前缀（与表格绑定 items[].xxx 对齐） */
export const DB_ARRAY_PREFIX = 'items'
const DB_TABLE_ID = 'main'

export interface ClientDatabaseSourceOptions {
  /** 库名（作为数据源 id / 展示） */
  database: string
  /** 表名 */
  table: string
  /** 字段元信息（来自 GET /api/data/columns） */
  columns: ClientColumn[]
  /** 首行示例（用于字段 sample 占位 / 预览兜底）；可空 */
  sampleRow?: Record<string, unknown>
}

/** 把客户端字段类型粗略映射为 FieldDef.type */
function mapDbType(raw: string): FieldDef['type'] {
  const t = raw.toUpperCase().replace(/\(.*\)/, '').trim()
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|MONEY|NUMBER)/.test(t)) {
    return 'number'
  }
  if (/^(BOOL|BOOLEAN)/.test(t)) return 'boolean'
  if (/^(DATE|DATETIME|TIMESTAMP|TIME)/.test(t)) return 'date'
  if (/^(BLOB|BINARY|IMAGE|BYTEA)/.test(t)) return 'image'
  if (/^(JSON|JSONB|ARRAY|LIST)/.test(t)) return 'array'
  return 'string'
}

export function createClientDatabaseSource(opts: ClientDatabaseSourceOptions): DataSourceRepository {
  const table: TableMeta = {
    id: DB_TABLE_ID,
    name: opts.table,
    relation: 'main',
    pathPrefix: DB_ARRAY_PREFIX,
    isArray: true,
  }
  const meta: DataSourceMeta = {
    id: opts.database,
    name: `${opts.database} / ${opts.table}`,
    description: '本地客户端数据库连接',
    tables: [table],
  }
  const fields: FieldDef[] = opts.columns.map((c, i) => ({
    path: `${DB_ARRAY_PREFIX}[].${c.name}`,
    label: c.name,
    type: mapDbType(c.type),
    tableId: DB_TABLE_ID,
    group: c.primary ? '主键' : '字段',
    sort: c.primary ? -1 : i,
    sample: opts.sampleRow?.[c.name] ?? '',
    readonly: false,
  }))

  return {
    async listSources() {
      return [meta]
    },
    async getFields() {
      return fields
    },
  }
}
