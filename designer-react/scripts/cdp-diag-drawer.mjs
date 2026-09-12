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
const clickAt = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { clickCount: 1 }); await mouse('mouseReleased', x, y, { clickCount: 1 }); await new Promise((r) => setTimeout(r, 400)) }

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: 'http://localhost:5189' })
await new Promise((r) => setTimeout(r, 9000))

// 载入 demo（文件菜单 → 载入示例模板）
const clickText = async (text) => {
  const pos = await evalJs(`(() => {
    const target = ${JSON.stringify(text)}
    const els = [...document.querySelectorAll('li, .ant-dropdown-menu-item, button, [role=menuitem], span')]
      .filter((e) => e.offsetParent !== null && e.childElementCount === 0 && e.textContent.replace(/\\s/g, '').includes(target))
    const el = els[els.length - 1]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!pos) return false
  await clickAt(pos.x, pos.y)
  return true
}
console.log('file:', await clickText('文件'))
await new Promise((r) => setTimeout(r, 500))
console.log('demo:', await clickText('载入示例模板'))
await new Promise((r) => setTimeout(r, 800))

// 点击第一个控件（左上 12,12mm 附近）
const info = await evalJs(`(() => {
  const s = window.__op.getState()
  const host = document.querySelector('.canvas-container').parentElement
  const r = host.getBoundingClientRect()
  return { host: { x: r.x, y: r.y }, vp: s.viewport, c: s.controls[0] }
})()`)
const PX = 3.779527559
const cx = info.host.x + (info.c.left + info.c.width / 2) * PX * info.vp.zoom + info.vp.offsetX
const cy = info.host.y + (info.c.top + info.c.height / 2) * PX * info.vp.zoom + info.vp.offsetY
await clickAt(Math.round(cx), Math.round(cy))
await new Promise((r) => setTimeout(r, 800))

const drawer = await evalJs(`(() => {
  const drawers = [...document.querySelectorAll('.ant-drawer')]
  return {
    narrow: matchMedia('(max-width: 900px)').matches,
    innerWidth: innerWidth,
    sel: window.__op.getState().selectedIds,
    drawerCount: drawers.length,
    drawers: drawers.map((d) => {
      const r = d.getBoundingClientRect()
      const cs = getComputedStyle(d)
      return { cls: d.className.slice(0, 60), x: Math.round(r.x), w: Math.round(r.width), display: cs.display, pointerEvents: cs.pointerEvents, z: cs.zIndex, text: d.textContent.slice(0, 60) }
    }),
    masks: [...document.querySelectorAll('.ant-drawer-mask')].map((m) => { const r = m.getBoundingClientRect(); const cs = getComputedStyle(m); return { w: Math.round(r.width), display: cs.display, opacity: cs.opacity, pe: cs.pointerEvents } }),
    topAtCanvasCenter: (() => { const el = document.elementFromPoint(400, 450); return el ? el.tagName + '.' + String(el.className).slice(0, 50) : null })(),
  }
})()`)
console.log(JSON.stringify(drawer, null, 1))
await shot('diag-edit-5-drawer.png')

// 再试拖拽另一个控件（被 mask 拦截？）——点「合计金额」文本
ws.close()
process.exit(0)
