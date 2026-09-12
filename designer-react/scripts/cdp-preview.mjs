/**
 * cdp-preview.mjs —— 打开打印预览并量取 iframe 内容几何（React/Vue 通用）
 *
 * 用法：node scripts/cdp-preview.mjs <url> [waitMs]
 */
const [, , url = 'http://localhost:5189', waitArg = '10000'] = process.argv
const waitMs = Number(waitArg)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value ?? JSON.stringify(r.result)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

// 点击顶栏「预览」按钮
console.log('click:', await evaluate(`(() => {
  // 注意：antd 会在两字按钮间插空格（「预 览」），必须归一化空白后再比对
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').replace(/\\s/g,'') === '预览')
  if (!btn) return 'no-button'
  btn.click()
  return 'clicked:' + btn.className
})()`))

await new Promise((r) => setTimeout(r, 6000))

console.log(
  await evaluate(`(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)} }
  const frame = document.querySelector('.preview-frame')
  const shell = document.querySelector('.preview-shell')
  const doc = frame && frame.contentDocument
  const pages = doc ? Array.from(doc.querySelectorAll('.op-page-wrap')) : []
  const p0 = pages[0]
  const inner = p0 ? p0.firstElementChild : null
  return JSON.stringify({
    shell: rect(shell),
    frame: rect(frame),
    frameAttr: frame ? {w: frame.getAttribute('width'), h: frame.getAttribute('height')} : null,
    docReady: !!doc,
    htmlLen: doc ? (doc.documentElement.outerHTML||'').length : 0,
    pageCount: pages.length,
    page0: rect(p0),
    page0Inner: rect(inner),
    page0Style: p0 ? {w: p0.style.width, h: p0.style.height, transform: p0.style.transform} : null,
    opScale: doc ? doc.documentElement.style.getPropertyValue('--op-scale') : null,
    bodyW: doc ? doc.body.getBoundingClientRect().width : null,
    fontStyleInjected: doc ? !!doc.getElementById('op-fonts') : null,
    pageIndicator: (document.querySelector('[data-testid=preview-page-indicator]')||{}).textContent || null,
    texts: doc ? Array.from(doc.querySelectorAll('.op-text, .op-page-wrap')).slice(0,5).map(e=>e.className) : []
  }, null, 2)
})()`),
)
ws.close()
