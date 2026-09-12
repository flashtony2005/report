/**
 * 浏览器端验证：网格报表弹窗「交叉表」多级列头 + 中文别名 + 筛选条件的真实渲染
 *
 * 前置：
 *   1) print-server 在 18888（配置里已注册「报表演示库」= F:/project/_nop/report-demo.db）
 *   2) React dev server 在 5189（http://[::1]:5189/）
 *   3) headless Edge：msedge --headless=new --remote-debugging-port=9222 \
 *        --user-data-dir=C:/Users/Administrator/.cache/edge-cdp --disable-gpu --no-first-run
 *
 * 注意：跑全量 vitest 前先停掉这个 Edge，否则会因负载超时出现假失败。
 *
 * 用法：node scripts/cdp-multi-header.mjs [url] [截图路径]
 */
const [, , urlArg, shotArg] = process.argv
const URL = urlArg || 'http://[::1]:5189/'
const SHOT = shotArg || '../网格报表-多级表头-Univer.png'

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
const log = (label, value) => console.log(`${label}${typeof value === 'string' ? value : JSON.stringify(value)}`)

/** 打开 antd Select 的下拉 */
async function openSelect(testid) {
  return evalJs(`(() => {
    const el = document.querySelector('[data-testid="${testid}"]');
    if (!el) return 'no-select';
    const sel = el.querySelector('.ant-select-selector') || el;
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return 'opened';
  })()`)
}

/**
 * 点当前「可见下拉」里的选项。
 *
 * 踩过两次坑：
 * 1) 全局查 .ant-select-item-option → 上一个没关的下拉会抢走点击，字段全进错框；
 * 2) 按 aria-controls 定位 → antd v6 该 id 指向的容器里并没有选项（虚拟列表在外层）。
 * 因此改为：只取当前可见的下拉，且每次选择前先用 Escape 确认没有残留下拉。
 */
async function clickOption(text) {
  return evalJs(`(() => {
    const dds = [...document.querySelectorAll('.ant-select-dropdown')]
      .filter((d) => !d.classList.contains('ant-select-dropdown-hidden') && d.offsetParent !== null);
    if (!dds.length) return 'no-visible-dropdown';
    const box = dds[dds.length - 1];
    const opts = [...box.querySelectorAll('.ant-select-item-option')];
    const t = ${JSON.stringify(text)};
    const o = opts.find((x) => (x.textContent || '').replace(/\\s/g, '') === t.replace(/\\s/g, ''));
    if (!o) return 'no-option: ' + opts.map((x) => (x.textContent || '').trim()).join('|');
    for (const type of ['mousedown', 'mouseup', 'click']) {
      o.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    return 'ok';
  })()`)
}

/** 关掉下拉（Esc 走 CDP 真实按键事件，rc-select 认这个） */
async function closeDropdown() {
  for (let i = 0; i < 3; i++) {
    const left = await evalJs(
      `document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').length`,
    )
    if (!left) break
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      })
    }
    await sleep(250)
  }
  const left = await evalJs(
    `document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').length`,
  )
  return `open-dropdowns=${left}`
}

/** 单选：开下拉 → 点选项 */
async function pickOne(testid, text) {
  const r1 = await openSelect(testid)
  if (r1 !== 'opened') return r1
  await sleep(500)
  const r2 = await clickOption(text)
  await sleep(500)
  return r2
}

/** 多选：开下拉 → 依次点多个选项 → 关下拉 */
async function pickMany(testid, texts) {
  const r1 = await openSelect(testid)
  if (r1 !== 'opened') return r1
  await sleep(500)
  const rs = []
  for (const t of texts) {
    rs.push(await clickOption(t))
    await sleep(280)
  }
  const closed = await closeDropdown()
  return rs.join(',') + ' / ' + closed
}

/** 写 antd/React 受控输入框：走原生 setter + input 事件 */
const typeText = (testid, value) =>
  evalJs(`(() => {
    const el = document.querySelector('[data-testid="${testid}"]');
    if (!el) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Page.navigate', { url: 'about:blank' })
await sleep(300)
await send('Page.navigate', { url: URL })
// 冷启动：vite 首次要预构建 Univer（很大），给足时间
await sleep(16000)

log('① 打开网格报表：', await evalJs(`(() => {
  const btn = document.querySelector('[data-testid="btn-grid-report"]');
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
})()`))
await sleep(5000)

log('② 切到交叉表：', await evalJs(`(() => {
  const labels = [...document.querySelectorAll('.ant-segmented-item-label')];
  const t = labels.find((l) => l.textContent.replace(/\\s/g, '') === '交叉表');
  if (!t) return 'no-tab';
  t.click();
  return 'clicked';
})()`))
await sleep(1200)

log('③ 选库：', await pickOne('grid-report-database', '报表演示库'))
log('④ 选表：', await pickOne('grid-report-table', 'sales_month'))
log('⑤ 行字段 region：', await pickMany('grid-report-row-fields', ['region']))
log('⑥ 列字段 year/month：', await pickMany('grid-report-col-fields', ['year', 'month']))
log('⑦ 数值字段 amount/qty：', await pickMany('grid-report-value-fields', ['amount', 'qty']))
log('⑧ 别名 region→大区：', await typeText('grid-report-cross-alias-region', '大区'))
log('⑨ 筛选条件：', await typeText('grid-report-where', 'region <> ?'))
log('⑩ 参数：', await typeText('grid-report-params', '["华北"]'))

await sleep(3500)

// 点一次「重新渲染」：非静默路径，任何服务端错误都会以 alert 暴露
log('⑪ 点重新渲染：', await evalJs(`(() => {
  const b = document.querySelector('[data-testid="grid-report-refresh"]');
  if (!b) return 'no-button';
  b.click();
  return 'clicked';
})()`))
await sleep(2500)

const probe = await evalJs(`(() => {
  const q = (id) => !!document.querySelector('[data-testid="' + id + '"]');
  const txt = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim());
  const chips = (id) => {
    const el = document.querySelector('[data-testid="' + id + '"]');
    return el ? [...el.querySelectorAll('.ant-select-selection-item')].map((e) => (e.textContent || '').trim()) : null;
  };
  return JSON.stringify({
    rowFields: chips('grid-report-row-fields'),
    colFields: chips('grid-report-col-fields'),
    valueFields: chips('grid-report-value-fields'),
    crossAlias: q('grid-report-cross-alias-region'),
    aliasValue: (document.querySelector('[data-testid="grid-report-cross-alias-region"]') || {}).value,
    exportBtn: q('grid-report-export'),
    canvasCount: document.querySelectorAll('canvas').length,
    alertText: txt('.ant-alert-title, .ant-alert-message'),
    alertDesc: txt('.ant-alert-description'),
  });
})()`)
log('⑫ UI 探测：', probe)

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
ws.close()
