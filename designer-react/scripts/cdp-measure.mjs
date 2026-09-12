/**
 * cdp-measure.mjs —— 通过 Chrome DevTools Protocol 在无头浏览器里量取 DOM 几何
 *
 * 用途：当无法直接看图时（例如当前模型不支持图像），用数值方式核对设计器
 * 画布 / 标尺 / 预览的实际布局，React 版（5189）与 Vue 版（5227）对照。
 *
 * 用法：
 *   1. 先起调试浏览器：
 *      msedge --headless=new --remote-debugging-port=9222 --user-data-dir=<dir> about:blank
 *   2. node scripts/cdp-measure.mjs <url> [waitMs]
 */
const [, , url = 'http://localhost:5189', waitArg = '8000', wArg = '1600', hArg = '900'] =
  process.argv
const waitMs = Number(waitArg)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(wArg),
  height: Number(hArg),
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Runtime.enable')
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

const EXPR = `(() => {
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  }
  const stage =
    document.querySelector('.canvas-stage') || document.querySelector('main.app-canvas > div')
  const host = stage ? stage.firstElementChild : null
  const svg = stage ? stage.querySelector('svg') : null
  const canvasEl = stage ? stage.querySelector('canvas') : null
  const vpState = (() => {
    const s = window.__op
    if (!s) return null
    const st = typeof s.getState === 'function' ? s.getState() : s
    return st && st.viewport ? { ...st.viewport } : null
  })()
  const texts = svg
    ? Array.from(svg.querySelectorAll('text')).map((t) => {
        const r = t.getBoundingClientRect()
        return { label: t.textContent, x: +r.x.toFixed(1), y: +r.y.toFixed(1) }
      })
    : []
  const hRulerBg = svg ? svg.children[0] : null
  return JSON.stringify(
    {
      stage: rect(stage),
      host: rect(host),
      svg: rect(svg),
      svgAttr: svg ? { w: svg.getAttribute('width'), h: svg.getAttribute('height') } : null,
      hRuler: rect(hRulerBg),
      canvas: rect(canvasEl),
      viewport: vpState,
      zeroH: (texts.find((t) => t.label === '0' && Math.abs(t.y - (rect(svg)?.y ?? 0)) < 40) || null),
      zeroV: (texts.find((t) => t.label === '0' && Math.abs(t.x - (rect(svg)?.x ?? 0)) < 40) || null),
      firstTexts: texts.slice(0, 12),
      textCount: texts.length,
    },
    null,
    2,
  )
})()`

const res = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: false })
console.log(res.result?.result?.value ?? JSON.stringify(res.result))
ws.close()
