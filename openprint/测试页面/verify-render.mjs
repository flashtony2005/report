/**
 * 渲染引擎逻辑验证（Node 端，零 DOM）
 *
 * 用途：不打开浏览器就能确认「模板 + 数据 → HTML」这条链路是对的，
 * 作为测试页 test.html 的命令行补充。两边共用 demo-template.json / demo-data.json。
 *
 * 覆盖的关键逻辑：
 *   1. 标量字段绑定（{{order.orderNo}} 等）
 *   2. 表格按数据数组重复行（items 6 条 → 6 行）
 *   3. 表格内单元格绑定（每行取各自的 productName / qty / amount）
 *   4. 条码控件真的生成了 SVG（异步 bwip-js 加载生效）
 *   5. 无遗留未解析占位符 {{...}}
 *   6. 分页数量符合预期
 *
 * 运行：node 测试页面/verify-render.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render } from '../dist-sdk/node.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f) => JSON.parse(readFileSync(join(here, f), 'utf8'))

const template = read('demo-template.json')
const data = read('demo-data.json')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

console.log('模板：demo-template.json   数据：demo-data.json\n')

const t0 = performance.now()
const { html, pages, warnings, layout } = await render({ template, data })
const ms = Math.round(performance.now() - t0)

console.log(`渲染完成：${ms}ms，${pages} 页，HTML ${html.length.toLocaleString()} 字节\n`)

/* 1. 标量绑定 */
console.log('[1] 标量字段绑定')
for (const [path, expect] of [
  ['order.orderNo', 'XS-20260830-0001'],
  ['order.salesman', '王小明'],
  ['customer.name', '深圳市鑫源贸易有限公司'],
  ['customer.phone', '138-0013-8000'],
]) {
  check(`{{${path}}} → ${expect}`, html.includes(expect))
}

/* 2. 表格重复行：数 is-data 行，并确认每行商品名各出现一次（不重不漏） */
console.log('\n[2] 表格按数据数组展开')
const rowCount = data.items.length
const dataRows = (html.match(/<tr class="is-data/g) ?? []).length
check(`items ${rowCount} 条 → ${rowCount} 个数据行`, dataRows === rowCount, `实际 ${dataRows} 行`)
check('表头只有一组（未逐行重复表头）',
  (html.match(/<tr class="[^"]*is-header/g) ?? []).length === 1)
for (const it of data.items) {
  const n = (html.match(new RegExp(it.productName.replace(/[()（）/]/g, '\\$&'), 'g')) ?? []).length
  check(`「${it.productName}」出现 ${n} 次（期望 1）`, n === 1)
}

/* 3. 单元格逐行绑定：每条的 qty 都要以格式化后的形态出现 */
console.log('\n[3] 单元格逐行取值')
for (const it of data.items) {
  const qtyStr = String(it.qty)
  check(`「${it.productName}」数量 ${qtyStr}`, html.includes(qtyStr))
}

/* 3.5 单元格格式化：模板给「数量」配 int、「单价/金额」配 currency(CNY,2位,千分位) */
console.log('\n[3.5] 单元格格式化（千分位 / 货币 / 小数位）')
const tableSeg = html.slice(html.indexOf('商品编码'), html.indexOf('</table>') + 8)
const rowOf = (name) => {
  const i = tableSeg.indexOf(name)
  return tableSeg.slice(tableSeg.lastIndexOf('<tr', i), tableSeg.indexOf('</tr>', i))
}
const cellAt = (row, idx) => {
  const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim())
  return tds[idx] ?? ''
}
// 第一行：单价 4200 → ¥4,200.00 ；金额 8400 → ¥8,400.00
const r0 = rowOf('工业级条码打印机')
check('单价 4200 → ¥4,200.00', cellAt(r0, 6) === '¥4,200.00', `实际「${cellAt(r0, 6)}」`)
check('金额 8400 → ¥8,400.00', cellAt(r0, 7) === '¥8,400.00', `实际「${cellAt(r0, 7)}」`)
// 末行：单价 124.75 → ¥124.75 （小数位补齐，不加多余千分位）
const rLast = rowOf('无线扫码枪')
check('单价 124.75 → ¥124.75', cellAt(rLast, 6) === '¥124.75', `实际「${cellAt(rLast, 6)}」`)
check('金额 249.5 → ¥249.50', cellAt(rLast, 7) === '¥249.50', `实际「${cellAt(rLast, 7)}」`)
// 合计行：qty 合计 35，amount 合计 12846.5 → ¥12,846.50
const sumRow = tableSeg.slice(tableSeg.lastIndexOf('<tr'))
check('合计行 金额 → ¥12,846.50',
  tableSeg.includes('¥12,846.50'), `实际「${sumRow.replace(/<[^>]+>/g, ' ').trim().slice(0, 60)}」`)

/* 4. 条码 / 二维码异步加载 */
console.log('\n[4] 条码控件（异步 bwip-js）')
const svgCount = (html.match(/<svg/g) ?? []).length
check('生成了 SVG（条码/二维码）', svgCount > 0, `${svgCount} 个 <svg>`)
// bwip-js 产出的条码是 path 集合，不会带 data:image
check('条码非占位空框', !/<svg[^>]*>\s*<\/svg>/.test(html))

/* 5. 无遗留占位符 —— 这是最容易静默出错的地方 */
console.log('\n[5] 占位符全部解析')
const leftovers = [...html.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0])
const uniqueLeftovers = [...new Set(leftovers)]
check('无未解析 {{...}} 占位符', uniqueLeftovers.length === 0,
  uniqueLeftovers.length ? uniqueLeftovers.slice(0, 5).join(', ') : '')
check('无 undefined / NaN 泄漏', !html.includes('undefined') && !html.includes('NaN'))

/* 6. 分页 */
console.log('\n[6] 分页')
check('页数 ≥ 1', pages >= 1, `${pages} 页`)

/* 7. 告警 */
console.log('\n[7] 渲染告警')
const realWarnings = warnings ?? []
check('无渲染告警', realWarnings.length === 0,
  realWarnings.map((w) => `${w.code}:${w.message}`).join('; ') || '（无）')

console.log(`\n${'─'.repeat(52)}`)
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
