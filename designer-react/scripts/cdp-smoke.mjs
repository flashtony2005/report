/**
 * CDP 页面冒烟：连 headless Edge(9222) → navigate → 收集异常/错误 + DOM 骨架 + store 快照。
 *
 * 用法：node scripts/cdp-smoke.mjs [url] [waitMs]
 * - url 默认 http://localhost:5189（dev server）
 * - 验生产产物时传 vite preview 的地址（如 http://localhost:5190），
 *   此时 `window.__op` 不存在（显式 DEV-only，发布产物不带调试全局）属预期，
 *   脚本会打印 `__op: absent(prod)` 而不是报错 —— 生产态只看 DOM 骨架 + 控制台错误。
 * - 冷启动要等够：dev 16s；生产产物已压缩，6s 通常够。
 */
const TARGET = process.argv[2] || 'http://localhost:5189'
const WAIT_MS = Number(process.argv[3] || 16000)

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
await send('Page.navigate', { url: TARGET })
await new Promise((r) => setTimeout(r, WAIT_MS))
const st = await evalJs(`(() => { const op = window.__op; if (!op) return 'absent(prod)'; const s = op.getState(); return { controls: s.controls?.length ?? -1, name: s.templateName ?? s.templateMeta?.name } })()`)
const dom = await evalJs(`(() => ({ shell: !!document.querySelector('.app-shell'), canvas: !!document.querySelector('canvas.lower-canvas'), left: !!document.querySelector('.app-left'), right: !!document.querySelector('.app-right') }))()`)
console.log('target:', TARGET)
console.log('store:', JSON.stringify(st))
console.log('dom:', JSON.stringify(dom))
console.log('errors:', errs.length ? errs.slice(0, 8) : 'none')
ws.close(); process.exit(0)
