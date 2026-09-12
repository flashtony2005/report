/**
 * 浏览器端验证：点击工具栏「网格报表」→ Univer 是否真的渲染出服务端展开的结果
 *
 * 前置：
 *   1) print-server 已在 18888 运行（提供 /api/report/sample）
 *   2) React dev server 在 5189（http://[::1]:5189/）
 *   3) headless Edge：msedge --headless=new --remote-debugging-port=9222 \
 *        --user-data-dir=C:/Users/Administrator/.cache/edge-cdp --disable-gpu --no-first-run
 *
 * 用法：node scripts/cdp-grid-report.mjs [url] [截图路径]
 */
const [, , urlArg, shotArg] = process.argv
const URL = urlArg || 'http://[::1]:5189/'
const SHOT = shotArg || '../网格报表-Univer-验证.png'

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
await send('Page.navigate', { url: 'about:blank' }) // 先清空，避免残留日志
await sleep(300)
await send('Page.navigate', { url: URL })

// 冷启动：vite 首次要预构建 Univer（很大），给足时间
await sleep(16000)

const click = await evalJs(`
  (() => {
    const btn = document.querySelector('[data-testid="btn-grid-report"]');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()
`)
console.log('点击网格报表按钮：', click)

await sleep(7000)

const probe = await evalJs(`
  (() => {
    const modal = document.querySelector('.ant-modal-content');
    const container = document.querySelector('[data-testid="grid-report-container"]');
    const canvas = document.querySelectorAll('canvas');
    const univerRoot = document.querySelector('[class*="univer"], [id*="univer"]');
    const text = modal ? modal.innerText.slice(0, 400) : '';
    return JSON.stringify({
      modal: !!modal,
      container: !!container,
      canvasCount: canvas.length,
      hasUniverRoot: !!univerRoot,
      modalText: text
    });
  })()
`)
console.log('DOM 探测：', probe)

const parsed = typeof probe === 'string' && probe.startsWith('{') ? JSON.parse(probe) : {}
const cells = await evalJs(`
  (() => {
    // Univer 用 canvas 渲染，DOM 里读不到单元格；退而验证服务端数据已到达：
    return fetch('http://127.0.0.1:18888/api/report/sample')
      .then(r => r.json())
      .then(d => JSON.stringify({ rows: d.sheets[0].rows.length, last: d.sheets[0].rows.at(-1).map(c => c.text).join('|') }))
  })()
`)
console.log('服务端数据自检：', cells)

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

// 注：antd v6 的模态根节点类名与 v5 不同，这里以容器 + canvas 为准
const ok = parsed.canvasCount > 0 && parsed.container && parsed.hasUniverRoot
console.log(ok ? '\n结果：Univer 已渲染（canvas 存在）' : '\n结果：未检测到 Univer canvas，需排查')
ws.close()
