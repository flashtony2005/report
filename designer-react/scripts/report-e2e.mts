/**
 * 端到端探针：用前端 buildGroupTemplate 生成模板 → POST 给 18888（真 sqlite 数据源）
 * 运行：node_modules/.bin/vite-node scripts/report-e2e.mts
 */
import { writeFileSync } from 'node:fs'
import { buildGroupTemplate } from '@/report/grid-report'

const SERVER = 'http://127.0.0.1:18888'
const DB = 'F:/project/_nop/report-demo.db'

async function main() {
  const tpl = buildGroupTemplate({
    sheetName: '销售分组汇总',
    ds: 'ds1',
    groupFields: ['region', 'city', 'salesman'],
    valueField: 'amount',
    title: '2026 年销售分组汇总表（真数据源）',
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
    console.error('渲染失败', res.status, text.slice(0, 500))
    process.exit(1)
  }
  const data = JSON.parse(text) as { sheets: { name: string; rows: { text: string }[][] }[] }
  const rows = data.sheets[0].rows
  console.log(`行数=${rows.length}`)
  for (const r of rows) console.log(r.map((c) => c.text).join(' | '))

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
  const out = 'F:/project/openprint/网格报表-真数据源导出.xlsx'
  writeFileSync(out, buf)
  console.log(`xlsx 已写出: ${out} (${buf.length} bytes, 签名=${buf.subarray(0, 4).toString('hex')})`)
}

void main()
