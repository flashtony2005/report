/**
 * P6.3 实机验证 2：触屏单指空白拖拽 = 平移（截图前后对比）。
 * 用法：node cdp-p63-pan.mjs [url] [waitMs]
 */
const [, , url = 'http://localhost:5189', waitArg = '12000'] = process.argv
const waitMs = Number(waitArg)
const fs = await import('node:fs')

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

const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`.shots/${name}.png`, Buffer.from(s.result.data, 'base64'))
}
await shot('p63-pan-before')

// 单指从空白区 (400,750) 拖到 (480,650)（+80,-100）→ 画布平移
const pt = (x, y) => [{ x, y, id: 0, radiusX: 4, radiusY: 4 }]
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(400, 750) })
for (const [x, y] of [[410, 740], [430, 720], [455, 695], [480, 670], [480, 650]]) {
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x, y) })
  await new Promise((r) => setTimeout(r, 50))
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await new Promise((r) => setTimeout(r, 800))
await shot('p63-pan-after')

// 无选中（点在空白），框选语义不应产生选框残留；输出 zoom 确认未缩放
const z = await send('Runtime.evaluate', { expression: `document.querySelector('.zoom-bar-label')?.textContent`, returnByValue: true })
console.log('zoom after pan:', z.result.result.value)
ws.close()
process.exit(0)
