/**
 * 发布检查：懒加载块在「相对 base（./）」下能否被正确按需加载。
 *
 * 拆包后最容易踩的坑：base 改成相对路径 + 动态 import 的组合，若产物里的
 * 动态 chunk 引用没跟着变成相对/可解析的地址，点击相关入口会 404 或静默失败。
 * 光看构建日志看不出来，必须真点一次。
 *
 * 做法：navigate → 等首屏 → 断言此刻**还没**请求 GridReportModal chunk →
 * 点「网格报表」→ 断言 chunk 被请求且弹窗出现、无控制台错误。
 *
 * 用法：node scripts/cdp-lazy-chunk.mjs [url] [bootMs]
 */
const TARGET = process.argv[2] || 'http://localhost:5190'
const BOOT_MS = Number(process.argv[3] || 9000)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page') || list[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
const errs = []
const reqs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url)
  if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 200))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('ERR: ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200))
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push('LOG: ' + String(m.params.entry.text).slice(0, 200))
}
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const lazyHits = () => reqs.filter((u) => /GridReportModal.*\.js/.test(u))

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable')
await send('Page.navigate', { url: TARGET })
await wait(BOOT_MS)

const before = lazyHits().length
console.log('首屏后 GridReportModal chunk 请求数:', before, before === 0 ? '(懒加载正确)' : '(❌ 被提前加载)')

// 点「网格报表」按钮（按可见文本找，兼容 antd 会给两字按钮插空格）
const clicked = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')]
  const t = btns.find((b) => (b.textContent || '').replace(/\\s/g, '').includes('网格报表'))
  if (!t) return 'not-found'
  t.click()
  return 'clicked'
})()`)
console.log('点击「网格报表」:', clicked)

await wait(6000)
const after = lazyHits().length
const modalState = await evalJs(`(() => ({
  modal: !!document.querySelector('.ant-modal'),
  univer: !!document.querySelector('.univer-app, .univer, [class*="univer"]'),
}))()`)

console.log('点击后 GridReportModal chunk 请求数:', after, after > 0 ? '(✅ 按需拉取成功)' : '(❌ 未按需加载)')
console.log('弹窗/Univer DOM:', JSON.stringify(modalState))
console.log('chunk 地址样例:', lazyHits()[0] || '(无)')
console.log('errors:', errs.length ? errs.slice(0, 8) : 'none')
ws.close(); process.exit(0)
