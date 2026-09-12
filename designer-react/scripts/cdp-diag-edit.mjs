import fs from 'node:fs'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.onopen = r)
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(new URL('./' + name, import.meta.url), Buffer.from(r.result.data, 'base64'))
}
const mouse = async (type, x, y, opt = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...opt })
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { clickCount: 1 }); await mouse('mouseReleased', x, y, { clickCount: 1 }); await new Promise(r => setTimeout(r, 300)) }

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: 'http://localhost:5189' })
await new Promise(r => setTimeout(r, 10000))

// 载入 demo 模板
const loaded = await evalJs(`(() => {
  const op = window.__op; if (!op) return 'no __op'
  op.getState().loadTemplate({ id: 'demo', name: '销售出库单模板', data: op.getState().buildDemo ? op.getState().buildDemo() : undefined })
  return 'tried'
})()`)
console.log('demo load attempt:', loaded)
// buildDemo 不在 store 上 —— 改走模块导入不行（页面内），改用 UI：文件菜单 → 示例模板 太绕。
// 直接看 store 现状
const st = await evalJs(`(() => { const s = window.__op.getState(); return { controls: s.controls.length, name: s.templateName } })()`)
console.log('store now:', JSON.stringify(st))
await shot('diag-edit-0-initial.png')
ws.close(); process.exit(0)
