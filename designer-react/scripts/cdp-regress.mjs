/**
 * P6.4 前回归排查：桌面尺寸下画布点击/编辑是否正常。
 * 输出：console 报错、点击控件后选中态、属性面板是否出现。
 */
const [, , url = 'http://localhost:5189', waitArg = '12000'] = process.argv
const waitMs = Number(waitArg)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.onopen = r)
let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300))
  }
}
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

// 画布几何：找可点击的控件位置（用 fabric 状态或直接点纸张中心）
const geo = await send('Runtime.evaluate', { expression: `JSON.stringify((() => {
  const c = document.querySelector('.app-canvas canvas.upper-canvas')
  const r = c ? c.getBoundingClientRect() : null
  return { hasUpper: !!c, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }
})())`, returnByValue: true })
console.log('geo:', geo.result.result.value)
const rect = JSON.parse(geo.result.result.value).rect
if (!rect) { console.log('NO UPPER CANVAS'); process.exit(1) }

// 单击纸张中心（大概率有控件）
const cx = rect.x + rect.w / 2
const cy = rect.y + rect.h / 2
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 })
}
await new Promise((r) => setTimeout(r, 1000))
const after = await send('Runtime.evaluate', { expression: `JSON.stringify((() => {
  const rp = document.querySelector('.app-right')
  return {
    rightPanel: !!rp,
    rightText: rp ? rp.textContent.slice(0, 80) : null,
    zoom: document.querySelector('.zoom-bar-label')?.textContent,
  }
})())`, returnByValue: true })
console.log('after click:', after.result.result.value)
console.log('console errors:', logs.slice(0, 6))
ws.close()
process.exit(0)
