/**
 * 内置示例模板 —— 销售出库单
 *
 * 用途有二：
 * 1. 新用户打开设计器就有一张能用的真单据，而不是空白画布 + "该从哪下手"
 * 2. Phase 7 分页引擎的活体验收：明细行调到 30+ 行必然跨页，
 *    可直接检查「表头每页重复 / 页眉页脚每页出现 / 合计只在末页 / 页码正确」
 *
 * 坐标全部 mm（整页相对坐标模型，§协议）：
 * - body 控件相对物理页左上角 (0,0)——页边距仅作可视化参考线，不参与渲染/导出偏移；
 * - header/footer 子控件相对各自色带左上角。
 * A4 纵向 210×297，页面设 12mm 边距，示例正文按「内容区宽 186」排布（视觉上落在边距参考线内）。
 */
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'

const CONTENT_W = 186

/** 内容区宽度，表格列宽之和必须等于它，否则会被等比归一化 */
export const DEMO_CONTENT_WIDTH = CONTENT_W

export const DEMO_TEMPLATE_NAME = '销售出库单（示例）'

export function createDemoTemplate(): TemplateData<AnyControl> {
  const header: AnyControl[] = [
    {
      id: 'hd-company',
      type: 'text',
      left: 12,
      top: 0,
      width: 100,
      height: 6,
      value: '深圳某某科技有限公司',
      style: { fontSize: 10, fontWeight: 'bold', fill: '#333333' },
      printable: true,
    },
    {
      id: 'hd-title',
      type: 'text',
      left: 12,
      top: 7,
      width: CONTENT_W,
      height: 11,
      value: '销售出库单',
      style: { fontSize: 18, fontWeight: 'bold', textAlign: 'center' },
      printable: true,
    },
    {
      id: 'hd-barcode',
      type: 'barcode',
      left: 152,
      top: 0,
      width: 46,
      height: 12,
      binding: 'order.orderNo',
      format: 'code128',
      showText: false,
      printable: true,
    },
    {
      id: 'hd-rule',
      type: 'line',
      left: 12,
      top: 21,
      width: CONTENT_W,
      height: 0,
      stroke: '#333333',
      strokeWidth: 1,
      printable: true,
    },
  ]

  const body: AnyControl[] = [
    /* ── 单据头：仅第 1 页 ── */
    txt('bd-no', 12, 12, 62, 6, '单号：{{order.orderNo}}'),
    txt('bd-date', 74, 12, 62, 6, '日期：{{order.orderDate}}'),
    txt('bd-salesman', 136, 12, 62, 6, '业务员：{{order.salesman}}'),
    txt('bd-cust', 12, 19, 92, 6, '客户：{{customer.name}}'),
    txt('bd-contact', 104, 19, 94, 6, '联系人：{{customer.contact}}　电话：{{customer.phone}}'),
    txt('bd-addr', 12, 26, CONTENT_W, 6, '收货地址：{{customer.address}}'),

    /* ── 明细表：驱动分页 ── */
    {
      id: 'bd-table',
      type: 'table',
      left: 12,
      top: 35,
      width: CONTENT_W,
      height: 60,
      dataSource: 'items',
      printable: true,
      data: [
        { productCode: 'PD-1001', productName: '无线鼠标', spec: '2.4G', unit: '个', qty: 2, price: 45.0, amount: 90.0 },
        { productCode: 'PD-1002', productName: '机械键盘', spec: '87键', unit: '个', qty: 1, price: 320.0, amount: 320.0 },
        { productCode: 'PD-1003', productName: 'USB集线器', spec: '4口', unit: '个', qty: 3, price: 65.0, amount: 195.0 },
        { productCode: 'PD-1004', productName: '六类网线', spec: '1.5m', unit: '根', qty: 5, price: 12.0, amount: 60.0 },
        { productCode: 'PD-1005', productName: '高清摄像头', spec: '1080P', unit: '个', qty: 1, price: 180.0, amount: 180.0 },
      ],
      columns: [
        { title: '序号', expression: '{{rowIndex + 1}}', width: 14, align: 'center', headerAlign: 'center' },
        { title: '商品编码', field: 'productCode', width: 26, align: 'left', headerAlign: 'center' },
        { title: '商品名称', field: 'productName', width: 58, align: 'left', headerAlign: 'center' },
        { title: '规格型号', field: 'spec', width: 34, align: 'left', headerAlign: 'center' },
        { title: '单位', field: 'unit', width: 12, align: 'center', headerAlign: 'center' },
        { title: '数量', field: 'qty', width: 12, align: 'right', headerAlign: 'center' },
        { title: '单价', field: 'price', width: 14, align: 'right', headerAlign: 'center' },
        { title: '金额', field: 'amount', width: 16, align: 'right', headerAlign: 'center' },
      ],
      options: {
        repeatHeader: true,
        // 合计只在最后一页出现（ERP 惯例），同时验证 repeatFooter=false 分支
        repeatFooter: false,
        pageRows: 'auto',
        rowHeightMode: 'auto',
        borders: 'all',
        striped: true,
        verticalAlign: 'middle',
        summaryRow: { type: 'sum', fields: ['qty', 'amount'], label: '合计' },
      },
    },

    /* ── 单据尾：随表格实际底边下移，只在末页 ── */
    txt('bd-total', 12, 97, CONTENT_W, 7, '合计金额（大写）：{{order.total | currency:"CNY"}}', {
      fontSize: 11,
      fontWeight: 'bold',
    }),
    txt('bd-memo', 12, 105, 120, 6, '备注：{{order.memo}}', { fontSize: 9, fill: '#555555' }),
    txt('bd-sign', 12, 115, CONTENT_W, 6, '制单人：{{order.salesman}}　　审核：＿＿＿＿　　仓管：＿＿＿＿　　客户签收：＿＿＿＿', {
      fontSize: 9,
    }),
  ]

  const footer: AnyControl[] = [
    {
      id: 'ft-rule',
      type: 'line',
      left: 12,
      top: 1,
      width: CONTENT_W,
      height: 0,
      stroke: '#999999',
      strokeWidth: 0.5,
      printable: true,
    },
    txt('ft-brand', 12, 3, 90, 6, '本单据由 OpenPrint 生成', { fontSize: 8, fill: '#888888' }),
    txt('ft-page', 108, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', {
      fontSize: 9,
      textAlign: 'right',
      fill: '#555555',
    }),
  ]

  return {
    version: '1.0',
    document: {
      type: 'report',
      page: {
        width: 210,
        height: 297,
        unit: 'mm',
        orientation: 'portrait',
        margin: { top: 12, right: 12, bottom: 10, left: 12 },
      },
      sections: [
        { type: 'header', height: 24, repeat: true, components: header },
        { type: 'body', components: body },
        { type: 'footer', height: 12, repeat: true, components: footer },
      ],
    },
  }
}

/* -------------------------------- 小工具 -------------------------------- */

function txt(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  value: string,
  style: NonNullable<Extract<AnyControl, { type: 'text' }>['style']> = {},
): AnyControl {
  return {
    id,
    type: 'text',
    left,
    top,
    width,
    height,
    value,
    printable: true,
    // 示例模板默认思源黑体（与内置字体包一致），调用方可覆盖
    style: { fontSize: 10, fontFamily: '思源黑体', ...style },
  }
}
