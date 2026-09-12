/**
 * P6.3 实机验证：CDP 触摸模拟双指捏合 → ZoomBar 百分比应变化。
 * 用法：node cdp-p63.mjs [url] [waitMs]
 */
const [, , url = 'http://localhost:5189', waitArg = '11000'] = process.argv
const waitMs = Number(waitArg)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.onopen = r)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

const zoomText = () => send('Runtime.evaluate', {
  expression: `document.querySelector('.zoom-bar-label')?.textContent ?? 'n/a'`,
  returnByValue: true,
})

const before = await zoomText()
console.log('before pinch:', before.result.result.value)

// 双指捏合：从 (300,450)+(500,450) 放大到 (200,450)+(600,450)（间距 200→400）
const pinchPoints = (spread) => [
  { x: 400 - spread / 2, y: 450, id: 0, radiusX: 4, radiusY: 4 },
  { x: 400 + spread / 2, y: 450, id: 1, radiusX: 4, radiusY: 4 },
]
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pinchPoints(200) })
for (const spread of [240, 280, 320, 360, 400]) {
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pinchPoints(spread) })
  await new Promise((r) => setTimeout(r, 60))
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await new Promise((r) => setTimeout(r, 800))

const after = await zoomText()
console.log('after pinch :', after.result.result.value)

const ok = await send('Runtime.evaluate', { expression: `JSON.stringify({
  touchAction: getComputedStyle(document.querySelector('.app-canvas canvas')).touchAction,
  coarseFab: !!document.querySelector('[data-testid="fab-left"]'),
  modalMaxWidth: getComputedStyle(document.querySelector('.ant-modal') || document.body).maxWidth,
})`, returnByValue: true })
console.log('env:', ok.result.result.value)
ws.close()
process.exit(0)
