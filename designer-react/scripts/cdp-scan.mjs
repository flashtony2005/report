/**
 * 回归排查 2：网格扫描点击，验证画布控件能否选中/属性面板是否联动。
 */
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
}
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))

const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 250))
}
const check = () => send('Runtime.evaluate', {
  expression: `(() => {
    const sel = document.querySelector('[data-testid="status-selection"]')
    if (sel) return sel.textContent
    const rp = document.querySelector('.app-right')
    return rp && rp.textContent.includes('选中画布中的控件') ? 'none' : (rp ? 'panel-no-sel' : 'no-panel')
  })()`,
  returnByValue: true,
})

// 画布内网格扫描（避开标尺与 ZoomBar）
const hit = []
for (let gx = 0; gx < 8; gx++) {
  for (let gy = 0; gy < 6; gy++) {
    const x = 320 + gx * 110
    const y = 140 + gy * 100
    await click(x, y)
    const t = (await check()).result.result.value
    if (t && t !== 'none' && !t.includes('选中画布中的控件')) {
      hit.push({ x, y, text: t })
      if (hit.length >= 3) break
    }
    if (hit.length >= 3) break
  }
  if (hit.length >= 3) break
}
console.log('selection hits:', JSON.stringify(hit, null, 1))
console.log('exceptions:', logs.slice(0, 5))
ws.close()
process.exit(0)
