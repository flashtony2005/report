/**
 * 回归排查 3：检查 Fabric 事件绑定与 DOM 结构（StrictMode 双挂载嫌疑）。
 */
const [, , url = 'http://localhost:5189', waitArg = '12000'] = process.argv
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
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

const r = await send('Runtime.evaluate', { expression: `JSON.stringify((() => {
  const canvases = [...document.querySelectorAll('.app-canvas canvas')]
  const wrappers = document.querySelectorAll('.canvas-container').length
  const uppers = canvases.filter(c => c.classList.contains('upper-canvas'))
  const ev = (el) => {
    try { return Object.keys(getEventListeners(el)) } catch { return 'n/a' }
  }
  const up = uppers[0]
  return {
    canvasCount: canvases.length,
    wrapperCount: wrappers,
    upperCount: uppers.length,
    upperEvents: up ? ev(up) : null,
    lowerEvents: canvases[0] ? ev(canvases[0]) : null,
    wrapperEvents: wrappers ? ev(document.querySelector('.canvas-container')) : null,
    upperZ: up ? getComputedStyle(up).zIndex + '/' + getComputedStyle(up).pointerEvents : null,
  }
})())`, returnByValue: true, includeCommandLineAPI: true })
console.log(JSON.parse(r.result.result.value))
ws.close()
process.exit(0)
