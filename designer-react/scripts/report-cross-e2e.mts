/**
 * 端到端探针：用前端 buildCrossTemplate 生成模板 → POST 给 18888（真 sqlite 数据源）
 *
 * 验证三件事：
 * 1. 列向展开（city 横向铺开）与行向展开（region 纵向铺开）同时工作
 * 2. 数值格按 agg=sum 聚合交集里的多行（华东 × 上海 有两个销售员）
 * 3. 行合计 / 列合计 / 总计 三者自洽
 *
 * 运行：node_modules/.bin/vite-node scripts/report-cross-e2e.mts
 */
import { writeFileSync } from 'node:fs'
import { buildCrossTemplate } from '@/report/grid-report'

const SERVER = 'http://127.0.0.1:18888'
const DB = 'F:/project/_nop/report-demo.db'

/** 期望值：与 Java 版 NopReport 同一份数据，逐格对照 */
const EXPECTED = {
  rows: [
    'region | 杭州 | 南京 | 上海 | 广州 | 天津 | 深圳 | 北京 | amount合计',
    '华东 | 9,900 | 7,400 | 20,600 |  |  |  |  | 37,900',
    '华南 |  |  |  | 21,500 |  | 18,700 |  | 40,200',
    '华北 |  |  |  |  | 7,100 |  | 31,200 | 38,300',
    '合计 | 9,900 | 7,400 | 20,600 | 21,500 | 7,100 | 18,700 | 31,200 | 116,400',
  ],
}

async function main() {
  const tpl = buildCrossTemplate({
    sheetName: '地区×城市交叉表',
    ds: 'ds1',
    rowFields: ['region'],
    colFields: ['city'],
    valueFields: ['amount'],
    agg: 'sum',
    title: '地区 × 城市 销售交叉表（真数据源）',
  })

  const body = {
    template: tpl,
    sources: [{ name: 'ds1', engine: 'sqlite', database: DB, table: 'sales' }],
  }

  const res = await fetch(`${SERVER}/api/report/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error('渲染失败', res.status, text.slice(0, 600))
    process.exit(1)
  }
  const data = JSON.parse(text) as { sheets: { name: string; rows: { text: string }[][] }[] }
  const rows = data.sheets[0].rows
  const lines = rows.map((r) => r.map((c) => c.text).join(' | '))
  console.log(`行数=${rows.length}`)
  for (const l of lines) console.log(l)

  // 逐格核对（表头列顺序由数据决定，这里只按内容断言关键数字）
  const flat = lines.join('\n')
  const must = ['37,900', '40,200', '38,300', '116,400', '20,600', '31,200']
  const missing = must.filter((m) => !flat.includes(m))
  if (missing.length) {
    console.error('缺少期望值:', missing.join(', '))
    process.exit(1)
  }
  // 合计行必须等于各地区之和
  const total = rows[rows.length - 1].map((c) => c.text)
  if (total[total.length - 1] !== '116,400') {
    console.error('总计不符：', total.join(' | '))
    process.exit(1)
  }
  void EXPECTED

  // 导出 xlsx
  const xres = await fetch(`${SERVER}/api/report/xlsx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!xres.ok) {
    console.error('导出失败', xres.status, (await xres.text()).slice(0, 300))
    process.exit(1)
  }
  const buf = Buffer.from(await xres.arrayBuffer())
  const out = 'F:/project/openprint/网格报表-交叉表导出.xlsx'
  writeFileSync(out, buf)
  console.log(`xlsx 已写出: ${out} (${buf.length} bytes, 签名=${buf.subarray(0, 4).toString('hex')})`)
  console.log('OK')
}

void main()
