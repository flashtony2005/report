/**
 * 诊断「鼠标移动到编辑区会出现预览、不能操作」：
 * 1) 不做设备模拟（避免上次 Emulation 假象）
 * 2) 真实 mouseMoved 悬停画布 → 截图 + 检查光标下元素栈
 * 3) 检查预览弹窗 DOM 是否意外出现（previewOpen）
 * 4) 点击控件验证能否选中
 */
import fs from 'node:fs'

const [, , url = 'http://localhost:5189', waitArg = '12000'] = process.argv
const waitMs = Number(waitArg)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.onopen = r)
let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300))
  }
  if (m.method === 'Page.screenshotCreated') { /* noop */ }
}
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
// 不做任何 Emulation 覆盖 —— 用户真实环境就是桌面鼠标
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

const viewport = await evalJs(`({w: innerWidth, h: innerHeight})`)
console.log('viewport:', JSON.stringify(viewport))

// 1) 悬停画布中央：一串 mouseMoved（含 mouseover 路径）
const cx = Math.round(viewport.w / 2), cy = Math.round(viewport.h / 2)
for (let i = 0; i <= 10; i++) {
  await send('Input.dispatchMouseEvent', {
    type: i === 0 ? 'mouseMoved' : 'mouseMoved',
    x: 200 + (cx - 200) * i / 10,
    y: 120 + (cy - 120) * i / 10,
    button: 'none',
  })
}
await new Promise((r) => setTimeout(r, 600))

// 2) 光标处元素栈 + 是否有预览弹窗
const hoverInfo = await evalJs(`(() => {
  const el = document.elementFromPoint(${cx}, ${cy})
  const stack = document.elementsFromPoint(${cx}, ${cy}).slice(0, 6).map(e => e.tagName + '.' + String(e.className).slice(0, 60))
  const modal = [...document.querySelectorAll('.ant-modal, .ant-modal-wrap')].filter(m => m.offsetParent !== null || getComputedStyle(m).display !== 'none')
  const modalText = modal.map(m => m.textContent.slice(0, 80))
  const drawerOpen = [...document.querySelectorAll('.ant-drawer-content')].filter(d => d.getBoundingClientRect().width > 0).map(d => d.textContent.slice(0, 60))
  return { at: el ? el.tagName + '.' + String(el.className).slice(0, 80) : 'null', stack, modalCount: modal.length, modalText, drawerOpen }
})()`)
console.log('after hover:', JSON.stringify(hoverInfo, null, 1))

await send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  if (r.result?.data) {
    fs.writeFileSync(new URL('./diag-hover.png', import.meta.url), Buffer.from(r.result.data, 'base64'))
    console.log('shot saved: diag-hover.png')
  }
})

// 3) 点击画布中央 → 能否选中控件
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 400))
const sel = await evalJs(`(() => {
  const selEl = document.querySelector('[data-testid="status-selection"]')
  const modal = [...document.querySelectorAll('.ant-modal')].filter(m => getComputedStyle(m).display !== 'none' && m.textContent.includes('打印预览'))
  return { statusSelection: selEl ? selEl.textContent : 'no-elem', previewModalOpen: modal.length > 0 }
})()`)
console.log('after click:', JSON.stringify(sel, null, 1))

// 4) 全页找「预览」相关可见元素（悬停出现的东西）
const pv = await evalJs(`(() => {
  const hits = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    const t = (el.childElementCount === 0 ? el.textContent : '').trim()
    if (t === '预览' || (el.getAttribute('title') || '').includes('预览')) {
      const under = el.closest('.ant-tooltip, .ant-popover, .ant-modal')
      hits.push({ tag: el.tagName, cls: String(el.className).slice(0, 50), text: t, title: el.getAttribute('title'), in: under ? under.className.slice(0, 40) : null })
    }
  }
  return hits.slice(0, 20)
})()`)
console.log('preview-els:', JSON.stringify(pv, null, 1))
console.log('exceptions:', logs.slice(0, 5))
ws.close()
process.exit(0)
