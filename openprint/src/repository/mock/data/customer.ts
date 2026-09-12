import type { FieldDef, DataSourceMeta, TableMeta } from '@/types/datasource'

export const CUSTOMER_TABLES: TableMeta[] = [
  {
    id: 'customer',
    name: '客户档案',
    relation: 'main',
    pathPrefix: 'customer',
  },
]

export const CUSTOMER_FIELDS: FieldDef[] = [
  { path: 'customer.id',      label: '客户编号', type: 'string', tableId: 'customer', group: '基本信息', sort: 1,  sample: 'C001' },
  { path: 'customer.name',    label: '客户名称', type: 'string', tableId: 'customer', group: '基本信息', sort: 2,  sample: '深圳某科技有限公司' },
  { path: 'customer.phone',   label: '客户电话', type: 'string', tableId: 'customer', group: '联系方式', sort: 3,  sample: '0755-88888888' },
  { path: 'customer.address', label: '客户地址', type: 'string', tableId: 'customer', group: '联系方式', sort: 4,  sample: '深圳市南山区' },
  { path: 'customer.contact', label: '联系人',   type: 'string', tableId: 'customer', group: '联系方式', sort: 5,  sample: '李明' },
  { path: 'customer.balance', label: '账户余额', type: 'number', tableId: 'customer', group: '金额信息', sort: 10, sample: 150000.00 },
]

export const CUSTOMER_META: DataSourceMeta = {
  id: 'customer',
  name: '客户档案',
  description: '内置演示数据源',
  tables: CUSTOMER_TABLES,
}
