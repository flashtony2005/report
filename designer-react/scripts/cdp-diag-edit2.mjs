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

// 1) 文件菜单 → 载入示例模板
console.log('open file menu:', await clickText('文件'))
await new Promise((r) => setTimeout(r, 600))
console.log('click demo item:', await clickText('载入示例模板'))
await new Promise((r) => setTimeout(r, 800))
const st = await evalJs(`(() => { const s = window.__op.getState(); return { controls: s.controls.length, name: s.templateName } })()`)
console.log('store after demo:', JSON.stringify(st))
await shot('diag-edit-1-demo.png')

// 2) 第一个控件 mm 坐标 → 屏幕坐标
const info = await evalJs(`(() => {
  const s = window.__op.getState()
  const c = s.controls[0]
  if (!c) return { ctrl: null }
  return {
    zoom: s.viewport.zoom, ox: s.viewport.offsetX, oy: s.viewport.offsetY,
    ctrl: { id: c.id, type: c.type, x: c.x, y: c.y, w: c.w, h: c.h },
    page: { w: s.pageSetup.width, h: s.pageSetup.height, margin: s.pageSetup.margin },
    rulerThick: 20,
  }
})()`)
console.log('viewport+control:', JSON.stringify(info))

if (info.ctrl) {
  // 画布宿主原点
  const host = await evalJs(`(() => { const el = document.querySelector('.canvas-container').parentElement; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })()`)
  // mm→px：zoom 比例（PX_PER_MM=3.78 近似，用 host 宽与页面宽推更稳：直接用 fabric 画布宽/页面mm）
  const pxPerMm = 780 / info.page.w
  const sx = host.x + info.ox * 0 + (20 + (info.ctrl.x + info.ctrl.w / 2) * pxPerMm * info.zoom)
  const sy = host.y + (20 + (info.ctrl.y + info.ctrl.h / 2) * pxPerMm * info.zoom)
  console.log('click target screen:', Math.round(sx), Math.round(sy))
  // 悬停
  await mouse('mouseMoved', Math.round(sx), Math.round(sy))
  await new Promise((r) => setTimeout(r, 400))
  await shot('diag-edit-2-hover.png')
  const hoverSel = await evalJs(`(() => { const s = window.__op.getState(); return { sel: s.selectedIds, tooltip: [...document.querySelectorAll('.ant-tooltip')].filter(t=>t.offsetParent!==null).map(t=>t.textContent.slice(0,40)) } })()`)
  console.log('after hover:', JSON.stringify(hoverSel))
  // 点击选中
  await clickAt(Math.round(sx), Math.round(sy))
  const sel = await evalJs(`(() => { const s = window.__op.getState(); return { sel: s.selectedIds } })()`)
  console.log('after click selection:', JSON.stringify(sel))
  await shot('diag-edit-3-selected.png')
  // 拖拽 40px
  await mouse('mouseMoved', Math.round(sx), Math.round(sy))
  await mouse('mousePressed', Math.round(sx), Math.round(sy), { clickCount: 1 })
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', Math.round(sx + i * 5), Math.round(sy + i * 3))
  await mouse('mouseReleased', Math.round(sx + 40), Math.round(sy + 24), { clickCount: 1 })
  await new Promise((r) => setTimeout(r, 400))
  const after = await evalJs(`(() => { const s = window.__op.getState(); const c = s.controls.find((x) => x.id === ${JSON.stringify('')} ) ; return { sel: s.selectedIds, first: s.controls[0] ? { x: s.controls[0].x, y: s.controls[0].y } : null } })()`)
  console.log('after drag:', JSON.stringify(after))
  await shot('diag-edit-4-dragged.png')
}

ws.close()
process.exit(0)
