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
const clickAt = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { clickCount: 1 }); await mouse('mouseReleased', x, y, { clickCount: 1 }); await new Promise((r) => setTimeout(r, 350)) }
const clickText = async (text) => {
  const pos = await evalJs(`(() => {
    const target = ${JSON.stringify(text)}
    const els = [...document.querySelectorAll('li, .ant-dropdown-menu-item, button, .ant-menu-item, [role=menuitem], span')]
      .filter((e) => e.offsetParent !== null && e.childElementCount === 0 && e.textContent.replace(/\\s/g, '').includes(target))
    const el = els[els.length - 1]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), n: els.length }
  })()`)
  if (!pos) return false
  await clickAt(pos.x, pos.y)
  return pos.n
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: 'http://localhost:5189' })
await new Promise((r) => setTimeout(r, 9000))

console.log('file menu:', await clickText('文件'))
await new Promise((r) => setTimeout(r, 600))
console.log('demo item:', await clickText('载入示例模板'))
await new Promise((r) => setTimeout(r, 800))

// 控件真实字段名 + host 几何
const info = await evalJs(`(() => {
  const s = window.__op.getState()
  const c = s.controls[0]
  const host = document.querySelector('.canvas-container').parentElement
  const r = host.getBoundingClientRect()
  return { keys: c ? Object.keys(c) : [], c: c ? { ...c } : null, host: { x: r.x, y: r.y }, vp: s.viewport, ctrlCount: s.controls.length }
})()`)
console.log('ctrl keys:', JSON.stringify(info.keys))
console.log('ctrl0:', JSON.stringify(info.c))
console.log('host:', JSON.stringify(info.host), 'vp:', JSON.stringify(info.vp))

// mm→screen：screen = host + mm*PX_PER_MM*zoom + offset
const PX = 3.779527559
const cx = info.host.x + (info.c.left + (info.c.width ?? 20) / 2) * PX * info.vp.zoom + info.vp.offsetX
const cy = info.host.y + (info.c.top + (info.c.height ?? 8) / 2) * PX * info.vp.zoom + info.vp.offsetY
console.log('click at', Math.round(cx), Math.round(cy))

// 悬停 → 观察是否有任何「预览」出现
await mouse('mouseMoved', Math.round(cx), Math.round(cy))
await new Promise((r) => setTimeout(r, 500))
const hover = await evalJs(`(() => ({
  sel: window.__op.getState().selectedIds,
  tips: [...document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)')].map((t) => t.textContent.slice(0, 50)),
  modals: [...document.querySelectorAll('.ant-modal-wrap')].filter((m) => getComputedStyle(m).display !== 'none').map((m) => m.textContent.slice(0, 40)),
}))()`)
console.log('after hover:', JSON.stringify(hover))
await shot('diag-edit-2-hover.png')

// 点击选中
await clickAt(Math.round(cx), Math.round(cy))
const sel = await evalJs(`window.__op.getState().selectedIds`)
console.log('after click sel:', JSON.stringify(sel))
await shot('diag-edit-3-selected.png')

// 拖拽移动
await mouse('mouseMoved', Math.round(cx), Math.round(cy))
await mouse('mousePressed', Math.round(cx), Math.round(cy), { clickCount: 1 })
for (let i = 1; i <= 10; i++) await mouse('mouseMoved', Math.round(cx + i * 4), Math.round(cy + i * 2))
await mouse('mouseReleased', Math.round(cx + 40), Math.round(cy + 20), { clickCount: 1 })
await new Promise((r) => setTimeout(r, 400))
const after = await evalJs(`(() => { const s = window.__op.getState(); return { sel: s.selectedIds, c0: { ...s.controls[0] } } })()`)
console.log('after drag c0:', JSON.stringify(after.c0), 'sel:', JSON.stringify(after.sel))
await shot('diag-edit-4-dragged.png')

ws.close()
process.exit(0)
