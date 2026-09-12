/**
 * 销售订单 —— 内置示例数据源（《设计方案》§19.4.3a 第十节）
 *
 * 结构：主表(order) + 明细(items[]) + 关联表(customer)
 * 所有字段带 sample 示例值，绑定后可立刻预览效果。
 */
import type { FieldDef, DataSourceMeta, TableMeta } from '@/types/datasource'

export const SALES_ORDER_TABLES: TableMeta[] = [
  {
    id: 'order',
    name: '订单主表',
    relation: 'main',
    pathPrefix: 'order',
  },
  {
    id: 'customer',
    name: '客户信息',
    relation: 'join',
    pathPrefix: 'customer',
  },
  {
    id: 'items',
    name: '订单明细',
    relation: 'detail',
    pathPrefix: 'items[]',
    isArray: true,
  },
]

export const SALES_ORDER_FIELDS: FieldDef[] = [
  // ── 订单主表 ──
  { path: 'order.orderNo',   label: '单据编号',       type: 'string',  tableId: 'order', group: '基本信息', sort: 1,  sample: 'XSCK202508050001' },
  { path: 'order.orderDate', label: '单据日期',       type: 'date',    tableId: 'order', group: '基本信息', sort: 2,  sample: '2025-08-05' },
  { path: 'order.total',     label: '合计金额',       type: 'number',  tableId: 'order', group: '金额信息', sort: 10, sample: 12800.50 },
  { path: 'order.warehouse', label: '仓库',           type: 'string',  tableId: 'order', group: '基本信息', sort: 3,  sample: '深圳中心仓' },
  { path: 'order.salesman',  label: '业务员',         type: 'string',  tableId: 'order', group: '基本信息', sort: 4,  sample: '张三' },
  { path: 'order.status',    label: '单据状态',       type: 'string',  tableId: 'order', group: '基本信息', sort: 5,
    options: [
      { value: 'draft', label: '草稿' },
      { value: 'confirmed', label: '已确认' },
      { value: 'shipped', label: '已出库' },
    ],
    sample: 'confirmed',
  },
  { path: 'order.memo',      label: '备注',           type: 'string',  tableId: 'order', group: '其他',     sort: 99, sample: '急单，请优先处理' },

  // ── 客户信息 ──
  { path: 'customer.name',    label: '客户名称',      type: 'string',  tableId: 'customer', group: '基本信息', sort: 1,  sample: '深圳某科技有限公司' },
  { path: 'customer.phone',   label: '客户电话',      type: 'string',  tableId: 'customer', group: '联系方式', sort: 2,  sample: '0755-88888888' },
  { path: 'customer.address', label: '客户地址',      type: 'string',  tableId: 'customer', group: '联系方式', sort: 3,  sample: '深圳市南山区科技园南路 88 号' },
  { path: 'customer.contact', label: '联系人',        type: 'string',  tableId: 'customer', group: '联系方式', sort: 4,  sample: '李明' },

  // ── 订单明细 ──
  { path: 'items[].seq',       label: '序号',         type: 'number',  tableId: 'items', group: '基本信息', sort: 1,  sample: 1 },
  { path: 'items[].productCode', label: '商品编码',   type: 'string',  tableId: 'items', group: '基本信息', sort: 2,  sample: 'P20240001' },
  { path: 'items[].productName', label: '商品名称',   type: 'string',  tableId: 'items', group: '基本信息', sort: 3,  sample: '惠普激光打印机 HP M404dn' },
  { path: 'items[].spec',      label: '规格型号',     type: 'string',  tableId: 'items', group: '基本信息', sort: 4,  sample: 'A4 黑白 38ppm' },
  { path: 'items[].unit',      label: '单位',         type: 'string',  tableId: 'items', group: '基本信息', sort: 5,  sample: '台' },
  { path: 'items[].qty',       label: '数量',         type: 'number',  tableId: 'items', group: '数量金额', sort: 6,  sample: 5 },
  { path: 'items[].price',     label: '单价',         type: 'number',  tableId: 'items', group: '数量金额', sort: 7,  sample: 1999.00 },
  { path: 'items[].amount',    label: '金额',         type: 'number',  tableId: 'items', group: '数量金额', sort: 8,  sample: 9995.00 },
  { path: 'items[].remark',    label: '备注',         type: 'string',  tableId: 'items', group: '其他',     sort: 99, sample: '' },
]

export const SALES_ORDER_META: DataSourceMeta = {
  id: 'sale_order',
  name: '销售订单',
  description: '内置演示数据源（含主表/明细/客户三层）',
  tables: SALES_ORDER_TABLES,
}

/** 示例业务数据（Phase 7 渲染引擎预览用） */
export const SALES_ORDER_SAMPLE = {
  order: {
    orderNo: 'XSCK202508050001',
    orderDate: '2025-08-05',
    total: 12800.50,
    warehouse: '深圳中心仓',
    salesman: '张三',
    status: 'confirmed',
    memo: '急单，请优先处理',
  },
  customer: {
    name: '深圳某科技有限公司',
    phone: '0755-88888888',
    address: '深圳市南山区科技园南路 88 号',
    contact: '李明',
  },
  items: [
    { seq: 1, productCode: 'P20240001', productName: '惠普激光打印机 HP M404dn', spec: 'A4 黑白 38ppm', unit: '台', qty: 5, price: 1999.00, amount: 9995.00, remark: '' },
    { seq: 2, productCode: 'P20240015', productName: '兄弟黑白激光一体机 DCP-1618W', spec: 'A4 打印/复印/扫描', unit: '台', qty: 2, price: 1399.00, amount: 2798.00, remark: '' },
    { seq: 3, productCode: 'P20230088', productName: '佳能彩色喷墨打印机 G3810', spec: 'A4 无线 加墨', unit: '台', qty: 1, price: 999.00, amount: 999.00, remark: '促销款' },
  ],
}
