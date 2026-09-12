const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page') || list[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 200))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('ERR: ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200))
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push('LOG: ' + String(m.params.entry.text).slice(0, 200))
}
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
await send('Page.navigate', { url: 'http://localhost:5189' })
await new Promise((r) => setTimeout(r, 16000))
const st = await evalJs(`(() => { const op = window.__op; if (!op) return 'no __op'; const s = op.getState(); return { controls: s.controls?.length ?? -1, name: s.templateName ?? s.templateMeta?.name } })()`)
const dom = await evalJs(`(() => ({ shell: !!document.querySelector('.app-shell'), canvas: !!document.querySelector('canvas.lower-canvas'), left: !!document.querySelector('.app-left'), right: !!document.querySelector('.app-right') }))()`)
console.log('store:', JSON.stringify(st))
console.log('dom:', JSON.stringify(dom))
console.log('errors:', errs.length ? errs.slice(0, 8) : 'none')
ws.close(); process.exit(0)
