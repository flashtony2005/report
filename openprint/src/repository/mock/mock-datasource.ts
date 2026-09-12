/**
 * createMockDataSource —— 内置示例数据源（§19.4.3a 第十节）
 *
 * 零后端即可体验完整"字段绑定→预览"闭环。
 * 与 createDataSourceHttp 同接口，传入真实 source 时整体替换，无分支。
 */
import type { DataSourceRepository, DataSourceMeta, FieldDef } from '@/types/datasource'
import {
  SALES_ORDER_META,
  SALES_ORDER_FIELDS,
} from './data/sales-order'
import {
  CUSTOMER_META,
  CUSTOMER_FIELDS,
} from './data/customer'

const SOURCES: DataSourceMeta[] = [SALES_ORDER_META, CUSTOMER_META]
const FIELDS_MAP: Record<string, FieldDef[]> = {
  sale_order: SALES_ORDER_FIELDS,
  customer: CUSTOMER_FIELDS,
}

export function createMockDataSource(): DataSourceRepository {
  return {
    async listSources() {
      return SOURCES
    },
    async getFields(sourceId: string) {
      return FIELDS_MAP[sourceId] ?? []
    },
  }
}
