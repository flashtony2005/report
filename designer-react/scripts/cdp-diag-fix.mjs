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
// 保持窄视口 800px（用户报障场景），不模拟触屏
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:5189' })
await new Promise((r) => setTimeout(r, 9000))

const layout = await evalJs(`(() => ({
  innerWidth,
  narrowMedia: matchMedia('(max-width: 900px)').matches,
  coarseMedia: matchMedia('(pointer: coarse)').matches,
  hasLeftPanel: !!document.querySelector('.app-left .left-panel'),
  hasRightPanel: !!document.querySelector('.app-right'),
  fabs: document.querySelectorAll('[data-testid^="fab-"]').length,
  isNarrowClass: document.querySelector('.app-shell').className.includes('is-narrow'),
}))()`)
console.log('layout @800px mouse:', JSON.stringify(layout))

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

// 点击第一个控件 → 应直接选中、不弹任何抽屉/遮罩
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
await new Promise((r) => setTimeout(r, 600))
const after = await evalJs(`(() => {
  const drawer = document.querySelector('.ant-drawer.app-right-drawer')
  return {
    sel: window.__op.getState().selectedIds,
    drawerOpen: drawer ? drawer.className.includes('open') : false,
    mask: (() => { const m = document.querySelector('.ant-drawer-mask'); return m ? getComputedStyle(m).display : 'none' })(),
    topAtControl: (() => { const el = document.elementFromPoint(Math.round(${cx}), Math.round(${cy})); return el ? el.tagName : null })(),
  }
})()`)
console.log('click control @800px:', JSON.stringify(after))
await shot('diag-fix-800-desktop.png')

ws.close()
process.exit(0)
