/**
 * 数据库模式字段拖拽验证（React / Vue 两端通用，自包含）
 *
 * 走真实 UI：左栏「数据源」→ 数据源类型「数据库」→ 打开开关 → 选库 → 点表展开列
 * 然后分别把**探索器树里的列节点**和**下方字段树的条目**拖到画布，看是否真的落地绑定。
 *
 * 回归背景：探索器树里的列早先没有 dragstart（dragstart 不写 dataTransfer → 画布收不到 drop），
 * 提示语却写着「点击表展开字段」，用户拖那些"字段"毫无反应 —— 即「不能拖动字段到画布」。
 *
 * 用法：node scripts/cdp-db-uitree-probe.mjs <url> [等待毫秒]
 *   本项目 dev server 只监听 IPv6 回环，React ≈ http://[::1]:5189/ ，Vue ≈ http://127.0.0.1:5227/
 */
const base = process.argv[2] || 'http://[::1]:5189/'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params?.exceptionDetails?.exception?.description || '').slice(0, 200))
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

/* 两端通用的测试锚点：全部收敛到 .db-explorer 作用域下 —— 面板内部不区分 antd(React)/naive(Vue) */
const SWITCH = '.db-explorer .ant-switch, .db-explorer .n-switch'
const SELECT_ROOT = '.db-explorer .ant-select, .db-explorer .n-select'
const TREE_NODE = '.db-explorer .ant-tree-treenode .ant-tree-title, .db-explorer .n-tree-node-content'
const COL_NODE = '.db-explorer-col'
const SW_ON = '.db-explorer .ant-switch-checked, .db-explorer .n-switch--active'

const out = []
const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now() })
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  if (await raw(`!!document.querySelector('canvas') && !!window.__op`)) break
}

/* 左栏切「数据源」页签（antd / naive 两种 tab 类名都试，反复点到数据源面板出现为止）
   就绪判定用文案而不是类名：React 有 .ds-tree-provider，Vue 没有（naive 用的是 .n-radio-button） */
const dsReady = () => raw(`(() => {
  const w = document.querySelector('.left-panel') || document.body
  return /数据源类型|启用数据库数据源/.test(w.innerText || '')
})()`)
let tabOk = false
for (let i = 0; i < 12 && !tabOk; i++) {
  await raw(`(() => {
    const t = [...document.querySelectorAll('.left-panel .ant-tabs-tab, .left-panel .n-tabs-tab')].find((x) => x.textContent.includes('数据源'))
    if (t) {
      const b = t.querySelector('.ant-tabs-tab-btn, .n-tabs-tab__label') || t
      for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        b.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
      }
    }
  })()`)
  await sleep(700)
  tabOk = await dsReady()
}
check('左栏切到数据源页签', tabOk)

/* 数据源类型 → 数据库 */
await raw(`(() => {
  const w = document.querySelector('.left-panel') || document.body
  const s = [...w.querySelectorAll('label, .n-radio-button, .ant-radio-button-wrapper')].find((x) => x.textContent.trim().includes('数据库'))
  ;(s?.querySelector('input') || s)?.click()
})()`)
await sleep(2500)
check('数据库面板出现', await raw(`!!document.querySelector('.db-explorer')`))

/* 打开「启用数据库数据源」开关 */
const swInfo = await raw(`(() => {
  const s = document.querySelector('${SWITCH}')
  if (!s) return null
  return {
    checked: s.classList.contains('ant-switch-checked') || s.classList.contains('n-switch--active'),
    disabled: s.classList.contains('ant-switch-disabled') || s.classList.contains('n-switch--disabled'),
  }
})()`)
check('开关存在且未因未连客户端而禁用', !!swInfo && swInfo.disabled === false, JSON.stringify(swInfo))
if (swInfo && !swInfo.checked) {
  await click(`document.querySelector('${SWITCH}')`)
  await sleep(3500)
}
check('开关已打开', await raw(`!!document.querySelector('${SW_ON}')`))

/* 选库：antd Select 与 naive Select 的下拉项类名都试 */
const opened = await raw(`(() => {
  const root = document.querySelector('${SELECT_ROOT}')
  if (!root) return 'no-select'
  const inner = root.querySelector('.ant-select-selector, .n-base-selection, input') || root
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    inner.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
  }
  return 'ok'
})()`)
await sleep(900)
const options = await raw(`document.querySelectorAll('.ant-select-item-option, .n-base-select-option').length`)
check('数据库下拉已打开', opened === 'ok' && options > 0, `options=${options}`)
await click(`document.querySelector('.ant-select-item-option, .n-base-select-option')`)
await sleep(3500)
const tables = await raw(`document.querySelectorAll('${TREE_NODE}').length`)
check('已选库并列出数据表', tables > 0, `tables=${tables}`)

/* 点表展开列 */
await click(`document.querySelector('${TREE_NODE}')`)
await sleep(3500)

const after = await raw(`(() => {
  const cols = [...document.querySelectorAll('${COL_NODE}')]
  const colNodes = cols.map((n) => ({ text: n.textContent.trim(), draggable: n.draggable, title: n.getAttribute('title') }))
  const raw = window.__op
  const s = typeof raw.getState === 'function' ? raw.getState() : raw
  return {
    colNodes,
    fieldItems: document.querySelectorAll('.field-item').length,
    fieldPaths: [...document.querySelectorAll('.field-item .field-path')].map((e) => e.textContent.trim()),
    controls: s.controls.length,
  }
})()`)
check('探索器树里出现列节点', Array.isArray(after?.colNodes) && after.colNodes.length > 0, JSON.stringify(after?.colNodes))
check(
  '列节点可拖（draggable 且带字段路径提示）',
  Array.isArray(after?.colNodes) && after.colNodes.length > 0 && after.colNodes.every((c) => c.draggable === true && /items\[\]\./.test(c.title || '')),
  JSON.stringify(after?.colNodes?.[0]),
)
check('下方字段树有可拖条目', after?.fieldItems > 0, `count=${after?.fieldItems} paths=${JSON.stringify(after?.fieldPaths)}`)

/* 拖「探索器树里的列节点」到画布 —— 这就是用户拖的那条 */
const dragCol = await raw(`(() => {
  const raw = window.__op
  const st = () => (typeof raw.getState === 'function' ? raw.getState() : raw)
  const col = document.querySelector('${COL_NODE}')
  if (!col) return { err: '找不到列节点' }
  const stage = document.querySelector('canvas').parentElement.parentElement
  const sr = stage.getBoundingClientRect()
  const cx = sr.left + sr.width / 2, cy = sr.top + sr.height / 2
  const before = st().controls.length
  const dt = new DataTransfer()
  col.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const top = document.elementFromPoint(cx, cy) || stage
  top.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
  top.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
  const st2 = typeof raw.getState === 'function' ? raw.getState() : raw
  return {
    colText: col.textContent.trim(),
    dtTypes: [...dt.types],
    dtData: dt.getData('application/x-openprint-binding'),
    before,
    after: st2.controls.length,
    lastBinding: st2.controls.at(-1)?.binding ?? null,
  }
})()`)
check(
  '拖探索器树里的列 → 画布绑定成功',
  dragCol?.after === (dragCol?.before ?? -1) + 1 && /^items\[0\]\./.test(dragCol?.lastBinding || ''),
  JSON.stringify(dragCol),
)

/* 拖「下方字段树条目」到画布 */
const dragField = await raw(`(() => {
  const raw = window.__op
  const st = () => (typeof raw.getState === 'function' ? raw.getState() : raw)
  const item = document.querySelector('.field-item')
  if (!item) return { err: '无 .field-item' }
  const stage = document.querySelector('canvas').parentElement.parentElement
  const sr = stage.getBoundingClientRect()
  const cx = sr.left + sr.width / 2, cy = sr.top + sr.height * 0.7
  const before = st().controls.length
  const dt = new DataTransfer()
  item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const top = document.elementFromPoint(cx, cy) || stage
  top.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
  top.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
  const st2 = typeof raw.getState === 'function' ? raw.getState() : raw
  return { dtData: dt.getData('application/x-openprint-binding'), before, after: st2.controls.length, lastBinding: st2.controls.at(-1)?.binding ?? null }
})()`)
check(
  '拖下方字段树条目 → 画布绑定成功',
  dragField?.after === (dragField?.before ?? -1) + 1,
  JSON.stringify(dragField),
)

check('无页面异常', logs.length === 0, logs.slice(0, 3).join(' | '))

console.log(out.join('\n'))
console.log(`\n站点：${base}`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  const fs = await import('node:fs')
  const name = base.includes('5227') ? 'db-fix-vue.png' : 'db-fix-react.png'
  fs.writeFileSync(`F:/project/openprint/print-server/tgt/${name}`, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：print-server/tgt/${name}`)
}
ws.close()
process.exit(out.some((r) => r.startsWith('FAIL')) ? 1 : 0)
