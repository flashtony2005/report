/**
 * 报表生成示例 —— 用共享渲染引擎把「模板 + 数据」渲染成填充后的报表 HTML
 *
 * 跑法（designer-react 下有 vite-node，且其 vite.config 的 `@` 别名指向 ../openprint/src）：
 *   node_modules/.bin/vite-node scripts/gen-report.mts
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@/core/sdk'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'

// —— 1) 业务数据：32 行明细，必然跨页，可验证「表头每页重复 / 合计只在末页 / 页码」——
const NAMES = [
  ['无线鼠标', '2.4G', 45],
  ['机械键盘', '87键', 320],
  ['USB集线器', '4口', 65],
  ['六类网线', '1.5m', 12],
  ['高清摄像头', '1080P', 180],
  ['打印纸', 'A4 70g', 22],
  ['碳粉盒', '黑色', 260],
  ['标签纸', '100×150', 38],
  ['条码机色带', '110mm', 55],
  ['收纳盒', '大号', 28],
] as const

const items = Array.from({ length: 32 }, (_, i) => {
  const [productName, spec, price] = NAMES[i % NAMES.length]
  const qty = ((i * 3) % 7) + 1
  return {
    productCode: `PD-${1001 + i}`,
    productName,
    spec,
    unit: '个',
    qty,
    price,
    amount: Number((qty * price).toFixed(2)),
  }
})

const totalAmount = items.reduce((s, r) => s + r.amount, 0)

const data = {
  order: {
    orderNo: 'SO-20260911-0038',
    orderDate: '2026-09-11',
    salesman: '陈伟',
    memo: '请于 3 个工作日内送达；货到验收入库后回传签收单。',
    total: totalAmount,
  },
  customer: {
    name: '中山市恒达电子有限公司',
    contact: '李敏',
    phone: '0760-8888 6666',
    address: '广东省中山市火炬开发区科技大道 18 号 3 栋 502',
  },
  items,
}

// —— 2) 渲染：模板 + 数据 → 分页 → HTML（与设计器预览、导出 PDF、浏览器打印同一份真相源）——
const res = await render({
  template: createDemoTemplate(),
  data,
  output: { screen: false },
})

const outPath = resolve(import.meta.dirname, '../../报表生成示例-销售出库单.html')
writeFileSync(outPath, res.html, 'utf8')

console.log('明细行数 :', items.length)
console.log('合计金额 :', totalAmount.toFixed(2))
console.log('总页数   :', res.pages)
console.log('告警     :', res.warnings.length ? JSON.stringify(res.warnings) : '无')
console.log('HTML 体积:', (res.html.length / 1024).toFixed(1), 'KB')
console.log('已写出   :', outPath)
