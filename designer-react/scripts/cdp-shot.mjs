/**
 * cdp-shot.mjs —— 用 CDP 截取页面截图（PNG）
 *
 * 用法：node scripts/cdp-shot.mjs <url> <outPng> [waitMs]
 */
const [, , url = 'http://localhost:5189', out = 'shot.png', waitArg = '9000', wArg = '1600', hArg = '900'] = process.argv
const waitMs = Number(waitArg)
const { writeFileSync } = await import('node:fs')

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
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(wArg),
  height: Number(hArg),
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log('saved', out)
ws.close()
