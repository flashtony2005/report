/**
 * 终极端到端：真实鼠标拖拽（CDP Input）把字段树条目拖到画布中央并松手
 * 判定：drop 事件是否送达 + store.controls 是否真的多出一个绑定控件
 * 用法：node scripts/cdp-native-drag-e2e.mjs <url>
 *
 * 为什么必须用真实鼠标事件（而不是合成 DragEvent）：
 *   合成 `new DragEvent('dragstart')` 会绕过浏览器原生的「拖动是否成立」判定，
 *   只能验证 JS 链路；真实指针事件才能证明「鼠标按下去真的能拖起来」。
 *   判定原生拖拽是否成立，用 Input.dispatchMouseEvent 序列 + 页面内 dragstart 打点，
 *   别依赖 `Input.setInterceptDrags` 的回调（部分 Edge/headless 版本根本不触发）。
 *   环境自检：注入一个标准 `<div draggable>` 当对照组，它的 dragstart 能触发即说明环境 OK。
 *
 * 两个探针级大坑：
 *   1) 页面地址：本项目 dev server 只监听 IPv6 回环，用 127.0.0.1 会 ERR_CONNECTION_REFUSED，
 *      必须写 http://[::1]:5189/。
 *   2) 动态 import 拿 store：`import('/src/stores/dataSource.ts')` 与页面自身模块的 URL
 *      不同（应用侧带 Vite 的 `?t=` 版本查询串）→ 拿到的是**另一个模块实例**，
 *      读到的 state 全是初始值，据此得出的结论都是假的。要读状态请从 DOM 反推。
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
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return '<<ERR ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 250) + '>>'
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now() })
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  if (await evaluate(`!!document.querySelector('canvas') && !!window.__op`)) break
}

/* 左栏：数据源页签 + 示例数据（避免上次残留的数据库模式导致字段树为空） */
for (let i = 0; i < 12; i++) {
  const n = await evaluate(`(() => {
    const t = [...document.querySelectorAll('.left-panel .ant-tabs-tab, .left-panel .n-tabs-tab')].find((x) => x.textContent.includes('数据源'))
    if (t) {
      const btn = t.querySelector('.ant-tabs-tab-btn, .n-tabs-tab__label') || t
      for (const ev of ['pointerdown','mousedown','pointerup','mouseup','click']) btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    }
    return document.querySelectorAll('.field-item').length
  })()`)
  if (n > 0) break
  await sleep(700)
}
await evaluate(`(() => {
  const wrap = document.querySelector('.ds-tree-provider'); if (!wrap) return
  const s = [...wrap.querySelectorAll('label, .n-radio-button, .ant-radio-button-wrapper')].find((x) => x.textContent.includes('示例数据'))
  ;(s?.querySelector('input') || s)?.click()
})()`)
await sleep(2000)

/* 装录音机 */
await evaluate(`(() => {
  window.__dragLog = []
  for (const t of ['dragstart','drag','dragend','dragenter','dragleave','dragover','drop']) {
    document.addEventListener(t, (e) => {
      const el = e.target
      const cls = typeof el?.className === 'string' ? el.className.trim().split(/\\s+/)[0] : el?.tagName
      window.__dragLog.push(t + '@' + cls)
    }, true)
  }
  return 1
})()`)

const geom = await evaluate(`(() => {
  const item = [...document.querySelectorAll('.field-item')].find((e) => e.getBoundingClientRect().width > 4)
  const stage = document.querySelector('canvas').parentElement.parentElement
  if (!item || !stage) return null
  const ir = item.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  const raw = window.__op
  const s = typeof raw.getState === 'function' ? raw.getState() : raw
  return {
    from: { x: Math.round(ir.left + ir.width / 2), y: Math.round(ir.top + ir.height / 2) },
    to: { x: Math.round(sr.left + sr.width / 2), y: Math.round(sr.top + sr.height / 2) },
    before: s.controls.length,
    path: item.querySelector('.field-path')?.textContent?.trim() ?? null,
  }
})()`)
if (!geom) {
  console.log('找不到字段条目或 stage')
  process.exit(1)
}
console.log('拖拽起终点：', JSON.stringify(geom))

/* 真实鼠标拖拽：按下 → 多步移动（跨过拖拽阈值并持续触发 dragover）→ 松手 */
const { from, to } = geom
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
await sleep(60)
const steps = 24
for (let i = 1; i <= steps; i++) {
  const t = i / steps
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(from.x + (to.x - from.x) * t),
    y: Math.round(from.y + (to.y - from.y) * t),
    button: 'left',
    buttons: 1,
  })
  await sleep(20)
}
await sleep(150)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
await sleep(600)

const after = await evaluate(`(() => {
  const raw = window.__op
  const s = typeof raw.getState === 'function' ? raw.getState() : raw
  const log = window.__dragLog
  const count = (pfx) => log.filter((x) => x.startsWith(pfx)).length
  return {
    after: s.controls.length,
    dropSeen: count('drop@') > 0,
    dropTargets: log.filter((x) => x.startsWith('drop@') || x.startsWith('dragenter@')).slice(0, 6),
    dragStartTargets: log.filter((x) => x.startsWith('dragstart@')).slice(0, 3),
    dragOverCount: count('dragover@'),
    lastBinding: s.controls.at(-1)?.binding ?? null,
    lastType: s.controls.at(-1)?.type ?? null,
    totalEvents: log.length,
  }
})()`)
console.log('结果：', JSON.stringify(after, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  const fs = await import('node:fs')
  fs.writeFileSync('F:/project/openprint/print-server/tgt/native-drag-e2e.png', Buffer.from(shot.result.data, 'base64'))
  console.log('截图：print-server/tgt/native-drag-e2e.png')
}
ws.close()
process.exit(0)
