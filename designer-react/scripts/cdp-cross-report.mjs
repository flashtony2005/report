/**
 * 浏览器端验证：网格报表弹窗 →「交叉表」模式 UI 是否到位
 *
 * 前置（同 cdp-grid-report.mjs）：
 *   1) print-server 已在 18888 运行
 *   2) React dev server 在 5189（http://[::1]:5189/）
 *   3) headless Edge：msedge --headless=new --remote-debugging-port=9222 \
 *        --user-data-dir=C:/Users/Administrator/.cache/edge-cdp --disable-gpu --no-first-run
 *
 * 注意：跑全量 vitest 前先停掉这个 Edge，否则会因负载超时出现假失败。
 *
 * 用法：node scripts/cdp-cross-report.mjs [url] [截图路径]
 */
const [, , urlArg, shotArg] = process.argv
const URL = urlArg || 'http://[::1]:5189/'
const SHOT = shotArg || '../网格报表-交叉表-Univer.png'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((p) => p.type === 'page')
if (!page) throw new Error('没有可用的 page，先启动带 9222 调试端口的 Edge')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const errors = []
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push('exception: ' + (msg.params?.exceptionDetails?.text || ''))
  } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
    errors.push('console: ' + msg.params.entry.text)
  }
}
await new Promise((r) => (ws.onopen = r))

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) return { __error: r.exceptionDetails.text }
  return r?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Page.navigate', { url: 'about:blank' })
await sleep(300)
await send('Page.navigate', { url: URL })
// 冷启动：vite 首次要预构建 Univer（很大），给足时间
await sleep(16000)

console.log(
  '点击网格报表按钮：',
  await evalJs(`(() => {
    const btn = document.querySelector('[data-testid="btn-grid-report"]');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`),
)

await sleep(6000)

// 切到「交叉表」页签
console.log(
  '切换交叉表：',
  await evalJs(`(() => {
    const labels = [...document.querySelectorAll('.ant-segmented-item-label')];
    const t = labels.find((l) => l.textContent.replace(/\\s/g, '') === '交叉表');
    if (!t) return 'no-tab';
    t.click();
    return 'clicked';
  })()`),
)

await sleep(1500)

const probe = await evalJs(`(() => {
  const q = (id) => !!document.querySelector('[data-testid="' + id + '"]');
  const canvas = document.querySelectorAll('canvas');
  return JSON.stringify({
    container: q('grid-report-container'),
    rowFields: q('grid-report-row-fields'),
    colFields: q('grid-report-col-fields'),
    valueFields: q('grid-report-value-fields'),
    agg: q('grid-report-agg'),
    refresh: q('grid-report-refresh'),
    exportBtn: q('grid-report-export'),
    canvasCount: canvas.length,
  });
})()`)
console.log('交叉表 UI 探测：', probe)

const parsed = typeof probe === 'string' && probe.startsWith('{') ? JSON.parse(probe) : {}

if (SHOT) {
  await send('Page.captureScreenshot', { format: 'png' })
    .then(async (r) => {
      if (!r?.data) return
      const fs = await import('node:fs')
      fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64'))
      console.log('截图已保存：', SHOT)
    })
    .catch((e) => console.log('截图失败：', e?.message || e))
}

console.log('--- 控制台错误 ---')
console.log(errors.length ? errors.slice(0, 10).join('\n') : '（无）')

const ok =
  parsed.container &&
  parsed.rowFields &&
  parsed.colFields &&
  parsed.valueFields &&
  parsed.agg &&
  parsed.canvasCount > 0
console.log(ok ? '\n结果：交叉表 UI 齐全且 Univer 已渲染' : '\n结果：交叉表 UI 不完整，需排查')
ws.close()
