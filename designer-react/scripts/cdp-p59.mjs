/** P5.9 实机验证：点击顶栏 AI 按钮 → 量 AI 抽屉几何与内容 */
import { WebSocket } from 'ws'

const url = process.argv[2] ?? 'http://localhost:5189'
const waitMs = Number(process.argv[3] ?? 10000)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.onopen = r)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

const click = `(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'AI 设计助手')
  if (!btn) return 'AI button not found'
  btn.click()
  return 'clicked'
})()`
const r1 = await send('Runtime.evaluate', { expression: click, returnByValue: true })
console.log('click:', r1.result.result.value)
await new Promise((r) => setTimeout(r, 1200))

const expr = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  }
  const drawer = document.querySelector('.ant-drawer-open')
  return JSON.stringify({
    drawer: pick('.ant-drawer-open .ant-drawer-content-wrapper') || pick('.ant-drawer-content-wrapper'),
    header: pick('.ai-header'),
    empty: pick('.ai-empty'),
    chips: document.querySelectorAll('.ai-chip').length,
    notice: document.querySelector('.ai-notice') ? document.querySelector('.ai-notice').textContent.slice(0, 40) : null,
    compose: !!document.querySelector('.ai-compose'),
    title: drawer ? (drawer.querySelector('.ant-drawer-title') || {}).textContent : null,
  })
})()`
const r2 = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(r2.result.result.value)
ws.close()
process.exit(0)
