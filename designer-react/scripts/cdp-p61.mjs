/** 量测 ZoomBar / StatusBar 是否渲染及几何位置 */
import { WebSocket } from 'ws'

const url = process.argv[2] ?? 'http://localhost:5189'
const waitMs = Number(process.argv[3] ?? 10000)

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
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

const expr = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), text: (el.textContent || '').slice(0, 80) }
  }
  return JSON.stringify({
    zoomBar: pick('.zoom-bar'),
    zoomLabel: pick('[data-testid="zoom-label"]'),
    statusBar: pick('[data-testid="status-bar"]'),
    dirty: !!document.querySelector('[data-testid="status-dirty"]'),
    grid: pick('[data-testid="status-grid"]'),
    margin: pick('[data-testid="status-margin"]'),
  })
})()`
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(r.result.result.value)
ws.close()
process.exit(0)
