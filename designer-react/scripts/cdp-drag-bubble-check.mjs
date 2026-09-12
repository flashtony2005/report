/**
 * 真实落点冒泡测试（React zustand / Vue pinia 两端通吃）
 *
 * 关键点：把 dragstart/dragover/drop 派发给「落点最上层元素」，而不是 stage 本身 ——
 * 只有这样才能验证事件能否从真实指针命中的元素冒泡到画布的 drop 处理器。
 *
 * 用法：node scripts/cdp-drag-bubble-check.mjs <url> [等待毫秒=8000]
 */
const base = process.argv[2] || 'http://[::1]:5189/'
const waitMs = Number(process.argv[3] || 8000)
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))

let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params?.exceptionDetails?.exception?.description || '').slice(0, 250))
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return '<<ERR ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300) + '>>'
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now() })

/* 轮询等待画布就绪（Vue 首屏要编译，可能十几秒） */
let ready = false
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  if (await evaluate(`!!document.querySelector('canvas') && !!window.__op`)) {
    ready = true
    break
  }
}
console.log('页面就绪：', ready)

/* 切到左栏「数据源」（antd / naive 两种 tab 类名都试） */
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.left-panel .ant-tabs-tab, .left-panel .n-tabs-tab')]
  const t = tabs.find((x) => x.textContent.includes('数据源'))
  t && t.click()
  return tabs.length
})()`)
await sleep(1500)

const r = await evaluate(`(() => {
  const raw = window.__op
  if (!raw) return { err: 'window.__op 不存在（dev 调试句柄缺失）' }
  const isZustand = typeof raw.getState === 'function'
  const getState = () => (isZustand ? raw.getState() : raw)

  const stage = document.querySelector('canvas')?.parentElement?.parentElement
  if (!stage) return { err: '找不到 stage（canvas 未挂载）' }
  const sr = stage.getBoundingClientRect()
  const cx = sr.left + sr.width / 2
  const cy = sr.top + sr.height / 2

  const top = document.elementFromPoint(cx, cy)
  const chain = []
  let n = top
  while (n && n !== document.documentElement) {
    const cs = getComputedStyle(n)
    const cls = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).slice(0, 2).join('.') : n.tagName
    chain.push(cls + '{pe:' + cs.pointerEvents + '}')
    n = n.parentElement
  }

  const item = document.querySelector('.field-item')
  if (!item) return {
    err: '字段树里没有 .field-item（字段为空或面板未展开）',
    topEl: typeof top?.className === 'string' ? top.className : top?.tagName,
    inStage: !!(top && stage.contains(top)),
    chain: chain.slice(0, 10),
  }

  const before = getState().controls.length
  const dt = new DataTransfer()
  item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))

  const target = top || stage
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt })
  target.dispatchEvent(over)
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt })
  target.dispatchEvent(drop)
  const after = getState().controls.length

  return {
    storeKind: isZustand ? 'zustand(React)' : 'pinia(Vue)',
    topEl: typeof top?.className === 'string' ? top.className : top?.tagName,
    inStage: !!(top && stage.contains(top)),
    chain: chain.slice(0, 10),
    fieldCount: document.querySelectorAll('.field-item').length,
    samplePath: item.querySelector('.field-path')?.textContent?.trim() ?? null,
    dtTypes: [...dt.types],
    dtData: dt.getData('application/x-openprint-binding'),
    overPrevented: over.defaultPrevented,
    before,
    after,
    delta: after - before,
    lastBinding: getState().controls.at(-1)?.binding ?? null,
    lastType: getState().controls.at(-1)?.type ?? null,
  }
})()`)

console.log(JSON.stringify(r, null, 2))
if (logs.length) console.log('异常：\n' + logs.slice(0, 5).join('\n'))
ws.close()
process.exit(0)
