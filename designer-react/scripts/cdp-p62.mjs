/**
 * P6.2 实机量测：把视口切到窄屏 800×900，验证 is-narrow/FAB/抽屉，再回桌面对照。
 * 用法：node cdp-p62.mjs [url] [waitMs]
 */
const [, , url = 'http://localhost:5189', waitArg = '10000'] = process.argv
const waitMs = Number(waitArg)

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

async function measure(tag) {
  const r = await send('Runtime.evaluate', { expression: `JSON.stringify((() => {
    const q = (s) => document.querySelector(s)
    return {
      narrowClass: !!q('.app-shell.is-narrow'),
      appLeft: !!q('.app-left'),
      appRight: !!q('.app-right'),
      fabLeft: !!q('[data-testid="fab-left"]'),
      fabRight: !!q('[data-testid="fab-right"]'),
      hiddenCount: document.querySelectorAll('[data-narrow-hide]').length,
      drawerOpen: !!q('.ant-drawer.ant-drawer-open'),
    }
  })())`, returnByValue: true })
  console.log(tag, r.result.result.value)
}

// 窄屏 800×900
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: true })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, waitMs))
await measure('NARROW 800x900:')
// 点 FAB 打开左抽屉
await send('Runtime.evaluate', { expression: `document.querySelector('[data-testid="fab-left"]').click()` })
await new Promise((r) => setTimeout(r, 1200))
const dr = await send('Runtime.evaluate', { expression: `JSON.stringify({
  open: !!document.querySelector('.ant-drawer.app-left-drawer.ant-drawer-open'),
  hasPanel: !!document.querySelector('.app-left-drawer .left-panel'),
})`, returnByValue: true })
console.log('NARROW drawer:', dr.result.result.value)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('.shots/react-narrow.png', Buffer.from(shot.result.data, 'base64'))
// 关抽屉 + 回桌面 1600×900
await send('Runtime.evaluate', { expression: `document.querySelector('.app-left-drawer .ant-drawer-close, .app-left-drawer .ant-drawer-mask')?.click()` })
await new Promise((r) => setTimeout(r, 500))
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
await new Promise((r) => setTimeout(r, 1200))
await measure('DESKTOP 1600x900:')
ws.close()
process.exit(0)
