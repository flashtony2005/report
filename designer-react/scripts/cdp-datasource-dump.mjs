/**
 * 诊断脚本：把「数据源」面板各列表/下拉的实际内容逐处 dump 出来，
 * 用来回答「下拉里列的都是列、不是表吗」这类疑问。
 *
 * 用法：node scripts/cdp-datasource-dump.mjs <url>
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
const box = (expr) =>
  raw(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); if (r.width < 1) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
const clickAt = async (p) => {
  if (!p) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  return true
}
const click = async (expr) => clickAt(await box(expr))

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now() })
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  if (await raw(`!!document.querySelector('canvas') && !!window.__op`)) break
}

/* 左栏切「数据源」 */
const dsReady = () => raw(`(() => { const w = document.querySelector('.left-panel') || document.body; return /数据源类型|启用数据库数据源/.test(w.innerText || '') })()`)
for (let i = 0; i < 12; i++) {
  if (await dsReady()) break
  await raw(`(() => {
    const t = [...document.querySelectorAll('.left-panel .ant-tabs-tab, .left-panel .n-tabs-tab')].find((x) => x.textContent.includes('数据源'))
    if (t) { const b = t.querySelector('.ant-tabs-tab-btn, .n-tabs-tab__label') || t
      for (const ev of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })) }
  })()`)
  await sleep(700)
}

/* 切「数据库」 */
await raw(`(() => {
  const w = document.querySelector('.left-panel') || document.body
  const s = [...w.querySelectorAll('label, .n-radio-button, .ant-radio-button-wrapper')].find((x) => x.textContent.trim().includes('数据库'))
  ;(s?.querySelector('input') || s)?.click()
})()`)
await sleep(2500)

/* 开开关 */
const SW = '.db-explorer .ant-switch, .db-explorer .n-switch'
const on = await raw(`(() => { const s = document.querySelector('${SW}'); return s ? (s.classList.contains('ant-switch-checked') || s.classList.contains('n-switch--active')) : null })()`)
if (on === false) { await click(`document.querySelector('${SW}')`); await sleep(3500) }

/* ① 打开「选择数据库」下拉，dump 全部选项（库列表可能还没拉回来，重试几次） */
let selectOpts = []
for (let i = 0; i < 8 && selectOpts.length === 0; i++) {
  await raw(`(() => {
    const root = document.querySelector('.db-explorer .ant-select, .db-explorer .n-select')
    if (!root) return
    const inner = root.querySelector('.ant-select-selector, .n-base-selection, input') || root
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) inner.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
  })()`)
  await sleep(1200)
  selectOpts = await raw(`[...document.querySelectorAll('.ant-select-item-option, .n-base-select-option')].map((e) => e.textContent.trim())`)
}
console.log('① 「选择数据库」下拉项：', JSON.stringify(selectOpts))
await click(`document.querySelector('.ant-select-item-option, .n-base-select-option')`)
await sleep(3500)

/* ② 数据表树（未展开）的顶层项 */
const TREE_NODE = '.db-explorer .ant-tree-treenode .ant-tree-title, .db-explorer .n-tree-node-content'
const topLevel = await raw(`[...document.querySelectorAll('${TREE_NODE}')].map((e) => e.textContent.trim())`)
console.log('② 「数据表」树顶层项（前 12）：', JSON.stringify((topLevel || []).slice(0, 12)), `共 ${(topLevel || []).length}`)

/* ③ 展开第一张表，dump 列节点 */
await click(`document.querySelector('${TREE_NODE}')`)
await sleep(3500)
const cols = await raw(`[...document.querySelectorAll('.db-explorer-col')].map((e) => e.textContent.trim())`)
console.log('③ 展开首表后的列节点：', JSON.stringify(cols))

/* ④ 下方「字段树」的内容（可用字段列表） */
const fieldDump = await raw(`(() => {
  const items = [...document.querySelectorAll('.field-item')]
  const groups = [...document.querySelectorAll('.ds-tree-group, .field-group')].map((g) => g.textContent.trim()).slice(0, 8)
  const labels = [...document.querySelectorAll('.ds-tree-label, .field-item .field-label, .field-item .field-path')].map((e) => e.textContent.trim())
  const empty = document.querySelector('.ds-tree-empty')
  return { count: items.length, labels: labels.slice(0, 20), groups, empty: empty ? empty.textContent.trim() : null }
})()`)
console.log('④ 下方字段树：', JSON.stringify(fieldDump))

/* ⑤ 左栏整块文案，供人工核对 */
const panelText = await raw(`(document.querySelector('.left-panel')?.innerText || '').replace(/\\n{2,}/g, '\\n')`)
console.log('⑤ 左栏文案：\n' + panelText)

/* ⑥ 数据库模式下，表格「数据设置 → 数据源」下拉给的是哪张表 */
const dbTableOpts = await raw(`(() => {
  const op = window.__op
  const st = () => (typeof op.getState === 'function' ? op.getState() : op)
  const s = st()
  if (typeof s.addControlOfType !== 'function') return { err: '无 addControlOfType' }
  s.addControlOfType('table', { leftMm: 30, topMm: 30 })
  st().selectControl(st().controls.at(-1).id)
  return { ok: true }
})()`)
await sleep(1200)
const dsOpts = await raw(`(() => {
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
const tableSrcOpts = await raw(`[...document.querySelectorAll('.ant-select-item-option, .n-base-select-option')].map((e) => e.textContent.trim())`)
console.log('⑥ 数据库模式下「数据设置 → 数据源」下拉项：', JSON.stringify(tableSrcOpts), `(opened=${dsOpts})`)

/* ⑦ 整页截图（含下方字段树），便于肉眼核对 */
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
if (shot.result?.data) {
  const fs = await import('node:fs')
  const name = base.includes('5227') ? 'ds-panel-vue.png' : 'ds-panel-react.png'
  fs.writeFileSync(`F:/project/openprint/print-server/tgt/${name}`, Buffer.from(shot.result.data, 'base64'))
  console.log(`⑥ 截图：print-server/tgt/${name}`)
}

ws.close()
process.exit(0)
