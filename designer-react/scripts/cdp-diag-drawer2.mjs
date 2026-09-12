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
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(new URL('./' + name, import.meta.url), Buffer.from(r.result.data, 'base64')) }
const mouse = async (type, x, y, opt = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...opt })

await send('Page.enable')
await send('Runtime.enable')

const drawerState = () => evalJs(`(() => {
  const d = document.querySelector('.ant-drawer')
  if (!d) return 'no-drawer'
  const cs = getComputedStyle(d)
  const mask = document.querySelector('.ant-drawer-mask')
  const panel = d.querySelector('.ant-drawer-content')
  const pr = panel ? panel.getBoundingClientRect() : null
  return { open: cs.pointerEvents !== 'none', display: cs.display, panelW: pr ? Math.round(pr.width) : 0, mask: mask ? getComputedStyle(mask).display : 'none', topAt: (() => { const el = document.elementFromPoint(innerWidth - 100, 450); return el ? el.tagName + '.' + String(el.className).slice(0, 40) : null })() }
})()`)

// 直接 store 置选中
console.log('before:', JSON.stringify(await drawerState()))
await evalJs(`window.__op.setState({ selectedIds: ['bd-no'] })`)
await new Promise((r) => setTimeout(r, 900))
console.log('after setState sel:', JSON.stringify(await drawerState()))
await shot('diag-drawer-forced.png')

// 再看 App effect 是否竞态：先取消选中
await evalJs(`window.__op.setState({ selectedIds: [] })`)
await new Promise((r) => setTimeout(r, 500))
await evalJs(`window.__op.setState({ selectedIds: ['bd-no'] })`)
await new Promise((r) => setTimeout(r, 900))
console.log('second round:', JSON.stringify(await drawerState()))

ws.close()
process.exit(0)
