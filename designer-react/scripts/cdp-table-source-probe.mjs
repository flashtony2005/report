/**
 * 验证：表格「属性 → 数据设置 → 数据源」下拉给的必须是**表（数组）**，不是**列**。
 *
 * 背景：表格引擎 resolveRows 要求 `control.dataSource` 解析出来是数组，
 * 早先该下拉错喂了 flatFields（全是 `items[].列名`）→ 用户看到"下拉里全是列、没有表"，
 * 选中一列当数据源会直接报 DATASOURCE_NOT_ARRAY、表格空白。
 *
 * 用法：node scripts/cdp-table-source-probe.mjs <url>
 *   React ≈ http://[::1]:5189/   Vue ≈ http://127.0.0.1:5227/
 */
const base = process.argv[2] || 'http://[::1]:5189/'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const raw = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return '<<ERR ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 250) + '>>'
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now() })
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  if (await raw(`!!document.querySelector('canvas') && !!window.__op`)) break
}

const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)

/* 1) 数据源选「示例数据」（内置 mock，零后端，含 明细表 items[]） */
await raw(`(() => {
  const w = document.querySelector('.left-panel') || document.body
  const t = [...w.querySelectorAll('.ant-tabs-tab, .n-tabs-tab')].find((x) => x.textContent.includes('数据源'))
  if (t) { const b = t.querySelector('.ant-tabs-tab-btn, .n-tabs-tab__label') || t
    for (const ev of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })) }
})()`)
await sleep(800)
const kindOk = await raw(`(() => {
  const w = document.querySelector('.left-panel') || document.body
  const s = [...w.querySelectorAll('label, .n-radio-button, .ant-radio-button-wrapper')].find((x) => x.textContent.trim().includes('示例数据'))
  ;(s?.querySelector('input') || s)?.click()
  return !!s
})()`)
await sleep(2500)
check('左栏存在「示例数据」选项', kindOk)

/* 2) 造一个表格控件并选中 → 右侧出现「数据设置 → 数据源」 */
const added = await raw(`(() => {
  const op = window.__op
  const st = () => (typeof op.getState === 'function' ? op.getState() : op)
  const s = st()
  const hasAdd = typeof s.addControlOfType === 'function' && typeof s.selectControl === 'function'
  if (!hasAdd) return { err: 'store 缺少 addControlOfType/selectControl' }
  s.addControlOfType('table', { leftMm: 30, topMm: 30 })
  const ctl = st().controls.at(-1)
  st().selectControl(ctl.id)
  return { id: ctl.id, type: ctl.type, total: st().controls.length }
})()`)
await sleep(1200)
check('已加表格控件并选中', added?.type === 'table', JSON.stringify(added))

/* 3) 右栏「数据设置」区块里的「数据源」下拉 */
const hasSection = await raw(`(() => {
  const rows = [...document.querySelectorAll('.props-row')]
  const row = rows.find((r) => (r.querySelector('.props-label')?.textContent || '').trim() === '数据源')
  return !!row
})()`)
check('右栏出现「数据设置 → 数据源」行', hasSection === true)

const opened = await raw(`(() => {
  const rows = [...document.querySelectorAll('.props-row')]
  const row = rows.find((r) => (r.querySelector('.props-label')?.textContent || '').trim() === '数据源')
  if (!row) return 'no-row'
  const root = row.querySelector('.ant-select, .n-select')
  if (!root) return 'no-select'
  const inner = root.querySelector('.ant-select-selector, .n-base-selection, input') || root
  for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) inner.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
  return 'ok'
})()`)
await sleep(900)
const opts = await raw(`[...document.querySelectorAll('.ant-select-item-option, .n-base-select-option')].map((e) => e.textContent.trim())`)
check('数据源下拉已打开', opened === 'ok' && Array.isArray(opts) && opts.length > 0, `opened=${opened} opts=${JSON.stringify(opts)}`)
check(
  '下拉里出现「表（数组）」',
  Array.isArray(opts) && opts.some((t) => /items\[\]|items\b/.test(t)),
  JSON.stringify(opts),
)
check(
  '下拉里不再出现「列」（items[].xxx）',
  Array.isArray(opts) && !opts.some((t) => t.includes('[].')),
  JSON.stringify(opts),
)

/* 4) 选中那张表 → 写回 control.dataSource */
const picked = await raw(`(() => {
  const opt = [...document.querySelectorAll('.ant-select-item-option, .n-base-select-option')].find((e) => /items/.test(e.textContent))
  if (!opt) return { err: '找不到表选项' }
  const txt = opt.textContent.trim()
  for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
  const op = window.__op
  const st = () => (typeof op.getState === 'function' ? op.getState() : op)
  const t = st().controls.filter((c) => c.type === 'table').at(-1)
  return { txt, dataSource: t?.dataSource ?? null }
})()`)
await sleep(800)
check(
  '选中后写回 dataSource（数组路径，不含 [].列）',
  typeof picked?.dataSource === 'string' && picked.dataSource.length > 0 && !picked.dataSource.includes('[].'),
  JSON.stringify(picked),
)

console.log(out.join('\n'))
console.log(`\n站点：${base}`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  const fs = await import('node:fs')
  const name = base.includes('5227') ? 'table-source-vue.png' : 'table-source-react.png'
  fs.writeFileSync(`F:/project/openprint/print-server/tgt/${name}`, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：print-server/tgt/${name}`)
}
ws.close()
process.exit(out.some((r) => r.startsWith('FAIL')) ? 1 : 0)
