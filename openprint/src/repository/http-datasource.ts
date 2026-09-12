/**
 * createDataSourceHttp —— 云端数据源仓库（《后端对接规范》§4.2）
 *
 * 对接（只读元数据，无需写协议）：
 *   GET /api/print/data-sources            → 数据源列表（含子表层级 tables）
 *   GET /api/print/data-sources/{id}/fields → 字段定义列表（含每字段可选 sample）
 *
 * 与 createMockDataSource 同一 DataSourceRepository 接口，整体替换无分支。
 */
import { HttpClient, type HttpOptions } from './http-client'
import type { DataSourceMeta, DataSourceRepository, FieldDef } from '@/types/datasource'

const BASE = '/api/print/data-sources'

export function createDataSourceHttp(opts: HttpOptions): DataSourceRepository {
  const client = new HttpClient(opts)

  return {
    async listSources() {
      return client.list<DataSourceMeta>(BASE)
    },

    async getFields(sourceId) {
      return client.list<FieldDef>(`${BASE}/${encodeURIComponent(sourceId)}/fields`)
    },
  }
}
