/**
 * 网格报表端到端核验（HTTP → 18888）
 *
 * 覆盖本轮三项遗留：
 * A. 多级列头合并，以及多指标下的「指标子表头」行
 * B. sources 的 where / params 筛选
 * C. 行字段中文别名映射（表头/小计/合计标题全部中文化）
 * D. 真库多级列头 + 双指标 + 筛选（sales_month）
 * E. 数值列格式（货币 / 整数，含 xlsx 数字格式串下发）
 *
 * 运行：node_modules/.bin/vite-node scripts/report-verify.mts
 */
import { buildCrossTemplate, buildGroupTemplate, headerRowCount } from '@/report/grid-report'

const SERVER = 'http://127.0.0.1:18888'
const DB = 'F:/project/_nop/report-demo.db'

interface Cell {
  text: string
  rowspan: number
  colspan: number
}
type Grid = Cell[][]

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function show(rows: Grid): void {
  rows.forEach((row, i) => {
    console.log(
      `    r${i}: ` +
        row
          .map((c) => {
            const t = c.text || '∅'
            return c.rowspan > 1 || c.colspan > 1 ? `${t}{rs${c.rowspan},cs${c.colspan}}` : t
          })
          .join(' | '),
    )
  })
}

async function render(body: unknown, label: string): Promise<Grid> {
  const res = await fetch(`${SERVER}/api/report/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`${label} 渲染失败 ${res.status}: ${text.slice(0, 400)}`)
    failures++
    return []
  }
  return (JSON.parse(text) as { sheets: { rows: Grid }[] }).sheets[0].rows
}

const cells = (row: Cell[]): string[] => row.map((c) => c.text)
const nonEmpty = (row: Cell[]): string[] => row.filter((c) => c.text).map((c) => c.text)

// ---------------------------------------------------------------- A. 多级列头
const multiData = [
  { region: '华东', year: '2024', month: '1月', amount: 100, qty: 10 },
  { region: '华东', year: '2024', month: '2月', amount: 200, qty: 20 },
  { region: '华东', year: '2025', month: '1月', amount: 300, qty: 30 },
  { region: '华南', year: '2024', month: '1月', amount: 150, qty: 15 },
  { region: '华南', year: '2025', month: '2月', amount: 250, qty: 25 },
]

async function scenarioMultiLevel(): Promise<void> {
  console.log('\nA. 多级列头（年份 × 月份）+ 双指标（金额 / 数量）')
  const tpl = buildCrossTemplate({
    sheetName: '多级列头',
    ds: 'ds1',
    rowFields: ['region'],
    colFields: ['year', 'month'],
    valueFields: ['amount', 'qty'],
    title: '年 × 月 销售交叉表',
  })
  console.log(`  模板表头行数 = ${headerRowCount(tpl)}（标题 + 2 层列头 + 指标子表头）`)
  const rows = await render({ template: tpl, datasets: { ds1: multiData } }, 'A')
  if (!rows.length) return
  show(rows)

  // 标题铺满整行（1 行字段 + 4 个月 × 2 指标 + 2 合计 = 11 列）
  check('标题铺满整行（colspan=11）', rows[0][0].colspan === 11, `实际 ${rows[0][0].colspan}`)
  // 行字段表头纵跨 3 行（2 层列头 + 指标子表头）
  check('行字段表头纵向合并 3 行', rows[1][0].text === '地区' && rows[1][0].rowspan === 3,
    `${rows[1][0].text}/rs=${rows[1][0].rowspan}`)
  // 年份跨其下 2 月 × 2 指标 = 4 列
  check('年份表头跨 4 列', rows[1][1].text === '2024' && rows[1][1].colspan === 4,
    `${rows[1][1].text}/cs=${rows[1][1].colspan}`)
  // 月份跨其下 2 个指标列
  check('月份表头跨 2 列', rows[2][1].text === '1月' && rows[2][1].colspan === 2,
    `${rows[2][1].text}/cs=${rows[2][1].colspan}`)
  // 指标子表头：每个月下并排 金额 / 数量
  check('指标子表头 = 金额|数量 ×4',
    nonEmpty(rows[3]).join(',') === '金额,数量,金额,数量,金额,数量,金额,数量',
    nonEmpty(rows[3]).join(','))
  // 合计表头纵跨 3 行且排在所有月份之后
  const tot = rows[1].find((c) => c.text === '金额合计')
  check('金额合计表头纵向合并 3 行', !!tot && tot.rowspan === 3, `rs=${tot?.rowspan}`)
  check('合计列排在最后（末列为数量合计）', rows[1][10].text === '数量合计', rows[1][10].text)
  // 数值：11 列，被合并覆盖的空位照常是空串
  check('华东行 = 100/10 · 200/20 · 300/30 · – · 600/60',
    cells(rows[4]).join(',') === '华东,100,10,200,20,300,30,,,600,60', cells(rows[4]).join(','))
  check('华南行 = 150/15 · – · – · 250/25 · 400/40',
    cells(rows[5]).join(',') === '华南,150,15,,,,,250,25,400,40', cells(rows[5]).join(','))
  check('合计行 = 250/25 · 200/20 · 300/30 · 250/25 · 1000/100',
    cells(rows[6]).join(',') === '合计,250,25,200,20,300,30,250,25,1,000,100', cells(rows[6]).join(','))
}

// ---------------------------------------------------------------- B. where / params
async function scenarioWhere(): Promise<void> {
  console.log('\nB. 服务端筛选（WHERE + 参数化）')
  const tpl = buildGroupTemplate({
    sheetName: '分组汇总',
    ds: 'ds1',
    groupFields: ['region'],
    valueField: 'amount',
  })
  const call = (where?: string, params?: unknown[]) =>
    render({ template: tpl, sources: [{ name: 'ds1', engine: 'sqlite', database: DB, table: 'sales', where, params }] }, 'B')

  const all = await call()
  const hd = await call('region = ?', ['华东'])
  const two = await call('region = ? AND amount > ?', ['华南', 10000])
  show(hd)

  const totalOf = (rows: Grid) => rows[rows.length - 1].map((c) => c.text).join(' | ')
  console.log(`    无筛选总计: ${totalOf(all)}`)
  console.log(`    华东总计:   ${totalOf(hd)}`)
  console.log(`    华南>10000: ${totalOf(two)}`)

  check('无筛选 = 116,400', totalOf(all).includes('116,400'))
  check('WHERE region=? → 华东 37,900', totalOf(hd).includes('37,900'))
  check('WHERE region=? AND amount>? → 华南 34,000（排除 6,200 那笔）',
    totalOf(two).includes('34,000'), totalOf(two))

  // 参数个数不匹配时服务端应报错，而不是静默返回全量
  const bad = await fetch(`${SERVER}/api/report/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: tpl,
      sources: [{ name: 'ds1', engine: 'sqlite', database: DB, table: 'sales', where: 'region = ?', params: [] }],
    }),
  })
  check('占位符与参数不匹配 → 400', bad.status === 400, `status=${bad.status}`)

  // xlsx 导出（带筛选）
  const xres = await fetch(`${SERVER}/api/report/xlsx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: tpl,
      sources: [{ name: 'ds1', engine: 'sqlite', database: DB, table: 'sales', where: 'region = ?', params: ['华东'] }],
    }),
  })
  const buf = Buffer.from(await xres.arrayBuffer())
  check('带筛选导出 xlsx 成功', xres.ok && buf.subarray(0, 4).toString('hex') === '504b0304',
    `${xres.status}/${buf.length}B`)
}

// ---------------------------------------------------------------- C. 别名
async function scenarioAlias(): Promise<void> {
  console.log('\nC. 字段中文别名映射')
  const tpl = buildGroupTemplate({
    sheetName: '别名',
    ds: 'ds1',
    groupFields: ['region', 'city', 'salesman'],
    valueField: 'amount',
    aliases: { city: '地市' },
  })
  const rows = await render({ template: tpl, sources: [{ name: 'ds1', engine: 'sqlite', database: DB, table: 'sales' }] }, 'C')
  if (!rows.length) return
  console.log(`    表头: ${cells(rows[0]).join(' | ')}`)
  check('表头中文（显式别名 + 内置别名）',
    cells(rows[0]).join(',') === '地区,地市,销售员,金额', cells(rows[0]).join(','))
  check('小计标签中文（地市小计）',
    rows.some((r) => r.some((c) => c.text === '地市小计')), cells(rows[2]).join(','))
  check('合计标签中文（地区合计）',
    rows.some((r) => r.some((c) => c.text === '地区合计')), '')
  // 分组聚合：华东 = 37,900（4 个城市相加，不是首行的 12,000）
  const total = cells(rows[rows.length - 1])
  check('总计 = 116,400（分组内已聚合）', total.join(',').includes('116,400'), total.join(','))
  check('总计标签未被数值格覆盖', total[0] === '总计', total.join(','))
}

// ---------------------------------------------------------------- D. 真库多级表头 + 筛选
async function scenarioDbMultiLevel(): Promise<void> {
  console.log('\nD. 真库（sales_month）多级列头 + 双指标 + 筛选')
  const tpl = buildCrossTemplate({
    sheetName: '销售月度交叉表',
    ds: 'ds1',
    rowFields: ['region'],
    colFields: ['year', 'month'],
    valueFields: ['amount', 'qty'],
    title: 'region × year/month',
  })
  const res = await fetch(`${SERVER}/api/report/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: tpl,
      sources: [
        {
          name: 'ds1',
          engine: 'sqlite',
          database: DB,
          table: 'sales_month',
          where: 'region <> ?',
          params: ['华北'],
        },
      ],
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`  渲染失败 ${res.status}: ${text.slice(0, 400)}`)
    failures++
    return
  }
  const rows = (JSON.parse(text) as { sheets: { rows: Grid }[] }).sheets[0].rows
  show(rows)
  const flat = rows.map((r) => cells(r).join('|')).join('\n')
  check('排除华北后仅剩华东/华南', !flat.includes('华北'), flat.slice(0, 200))
  check('华东 2024-1月 = 12,000 / 120', flat.includes('12,000') && flat.includes('120'))
  // 华东 12000+8600+9900+7400 = 37,900；华南 15300+6200+18700+5100 = 45,300
  check('华东行合计 37,900', flat.includes('37,900'), '')
  check('华南行合计 45,300', flat.includes('45,300'), '')
  check('总计 = 83,200', flat.includes('83,200'), '')
}

async function scenarioNumberFormat(): Promise<void> {
  console.log('\nE. 数值列格式（真库 sales_month：金额=货币 / 数量=整数）')
  const tpl = buildCrossTemplate({
    sheetName: '格式化交叉表',
    ds: 'ds1',
    rowFields: ['region'],
    colFields: ['year', 'month'],
    valueFields: ['amount', 'qty'],
    valueFormats: {
      amount: { kind: 'currency', code: 'CNY', digits: 2, thousands: true },
      qty: { kind: 'int', digits: 0, thousands: true },
    },
    title: 'region × year/month',
  })
  const res = await fetch(`${SERVER}/api/report/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: tpl,
      sources: [{ name: 'ds1', engine: 'sqlite', database: DB, table: 'sales_month' }],
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`  渲染失败 ${res.status}: ${text.slice(0, 400)}`)
    failures++
    return
  }
  type FCell = Cell & { num_format?: string; raw_number?: number }
  const rows = (JSON.parse(text) as { sheets: { rows: FCell[][] }[] }).sheets[0].rows
  show(rows)
  const flat = rows.map((r) => cells(r).join('|')).join('\n')

  // 金额：货币符号 + 千分位 + 两位小数（华东 2024-1月 = 12,000）
  check('金额按货币格式渲染（¥12,000.00）', flat.includes('¥12,000.00'), flat.slice(0, 300))
  // 数量：整数（无 .00 尾巴）
  check('数量按整数渲染（120，不带小数）', /(^|\|)120(\||$)/m.test(flat), flat.slice(0, 300))
  // 千分位生效：不应出现「¥」后紧跟 4 位以上数字
  check('金额一律带千分位', !/¥\d{4}/.test(flat))
  // xlsx 导出靠这两个字段设置 Excel 数字格式（文本渲染与 Excel 显示同口径）
  const moneyCells = rows.flat().filter((c) => c.num_format === '"¥"#,##0.00')
  check('金额格下发 Excel 数字格式串', moneyCells.length > 0, `命中 ${moneyCells.length} 个`)
  const qtyCells = rows.flat().filter((c) => c.num_format === '#,##0')
  check('数量格下发 Excel 数字格式串', qtyCells.length > 0, `命中 ${qtyCells.length} 个`)
  // 数值格仍保留原始数字（Excel 里可继续参与计算）
  check('数值格保留原始数字', moneyCells.every((c) => typeof c.raw_number === 'number'))
}

async function main(): Promise<void> {
  await scenarioMultiLevel()
  await scenarioWhere()
  await scenarioAlias()
  await scenarioDbMultiLevel()
  await scenarioNumberFormat()
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项未通过 ❌`)
  if (failures) process.exit(1)
}

void main()
