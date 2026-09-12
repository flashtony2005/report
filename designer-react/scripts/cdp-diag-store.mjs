const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('5189')) || list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.onopen = r)
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
const out = await evalJs(`(() => {
  const op = window.__op
  if (!op) return 'no __op'
  const s = op.getState()
  return {
    controls: s.controls?.length,
    pages: s.pageCount,
    selectedIds: s.selectedIds,
    templateName: s.templateMeta?.name || s.templateName,
    pageSetupW: s.pageSetup?.widthMm,
    canvasObjects: null,
  }
})()`)
console.log(JSON.stringify(out, null, 1))
const fabric = await evalJs(`(() => {
  const host = document.querySelector('.canvas-container')?.parentElement
  // fabric 实例藏在 CanvasDesigner 闭包里，从 DOM 反查：lower-canvas 的 __fabric? 试 fabric 环境
  const lower = document.querySelector('canvas.lower-canvas')
  return { hasLower: !!lower, lowerW: lower?.width, lowerH: lower?.height, hostW: host?.clientWidth, hostH: host?.clientHeight }
})()`)
console.log(JSON.stringify(fabric, null, 1))
ws.close(); process.exit(0)
