import fs from 'node:fs'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] })
await send('Page.navigate', { url: 'http://localhost:5189' })
await new Promise((r) => setTimeout(r, 9000))
const layout = await evalJs(`(() => ({
  narrow: matchMedia('(max-width: 900px)').matches,
  coarse: matchMedia('(pointer: coarse)').matches,
  hasLeftPanel: !!document.querySelector('.app-left'),
  fabs: document.querySelectorAll('[data-testid^="fab-"]').length,
  isNarrow: document.querySelector('.app-shell').className.includes('is-narrow'),
}))()`)
console.log('touch @800px:', JSON.stringify(layout))
ws.close(); process.exit(0)
