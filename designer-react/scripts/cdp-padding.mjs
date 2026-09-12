/**
 * cdp-padding.mjs —— 打开预览并打印 .preview-shell 祖先链的宽度/内边距
 * 用法：node scripts/cdp-padding.mjs <url> [waitMs]
 */
const [, , url = 'http://localhost:5189', waitArg = '9000'] = process.argv
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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

console.log(
  'click:',
  await evaluate(`
(() => {
  const b = Array.from(document.querySelectorAll('button')).find(
    (x) => (x.textContent || '').replace(/\\s/g, '') === '预览',
  )
  if (!b) return 'no-button'
  b.click()
  return 'clicked'
})()
`),
)
await new Promise((r) => setTimeout(r, 5000))

console.log(
  await evaluate(`
(() => {
  const shell = document.querySelector('.preview-shell')
  if (!shell) return 'no-shell'
  const out = []
  let el = shell
  while (el && el !== document.body) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    out.push({
      cls: String(el.className || '').slice(0, 70),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      pad: cs.padding,
      box: cs.boxSizing,
    })
    el = el.parentElement
  }
  return JSON.stringify(out, null, 1)
})()
`),
)
ws.close()
