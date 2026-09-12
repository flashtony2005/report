/**
 * cdp-preview-shot.mjs —— 打开打印预览并截图
 * 用法：node scripts/cdp-preview-shot.mjs <url> <outPng> [waitMs]
 */
const [, , url = 'http://localhost:5189', out = 'preview.png', waitArg = '9000'] = process.argv
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
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))
await send('Runtime.evaluate', {
  expression: `(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').replace(/\\s/g,'') === '预览')
  if (b) { b.click(); return 'clicked' }
  return 'no-button'
})()`,
  returnByValue: true,
})
await new Promise((r) => setTimeout(r, 6000))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log('saved', out)
ws.close()
