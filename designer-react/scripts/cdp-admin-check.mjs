/**
 * cdp-admin-check.mjs —— 用 CDP 对 print-server 的「数据库配置页」做端到端检查
 *
 * 要求：已有一个带 --remote-debugging-port=9222 的 Edge/Chrome 在跑。
 * 用法：node scripts/cdp-admin-check.mjs <baseUrl> <outPng>
 *   例：node scripts/cdp-admin-check.mjs http://127.0.0.1:18889/ ../print-server/tgt/admin-page.png
 *
 * 检查项：页面渲染 / 无 console 报错 / 新增连接弹窗 / 引擎切换 / 测试连接 / 保存落盘
 */
const [, , base = 'http://127.0.0.1:18889/', out = 'admin-page.png'] = process.argv
const { writeFileSync } = await import('node:fs')

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用的 page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))

let id = 0
const pending = new Map()
const problems = []
let dialogs = 0
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  // 原生 confirm/alert 会阻塞页面，这里自动确认并计数
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs++
    send('Page.handleJavaScriptDialog', { accept: true })
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    problems.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '))
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    problems.push('log: ' + m.params.entry.text)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

const evaluate = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const r = m.result || {}
  if (r.exceptionDetails) {
    throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result ? r.result.value : undefined
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/// 导航过程中 selectors 可能还是 null（上下文切换），轮询时一律吞掉异常当 false
async function evaluateTolerant(expression) {
  try {
    return await evaluate(expression)
  } catch {
    return undefined
  }
}
async function waitFor(expr, ms = 6000) {
  const t0 = Date.now()
  for (;;) {
    if (await evaluateTolerant(expr)) return true
    if (Date.now() - t0 > ms) return false
    await sleep(120)
  }
}

const results = []
/// Node 侧条件轮询（用于等 CDP 事件，比如原生弹窗）
async function waitForNode(fn, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > ms) return false
    await sleep(100)
  }
}
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  return ok
}

// 先切到 about:blank，避免把上一个页面残留的 console / log 记录算进来
await send('Page.enable')
await send('Page.navigate', { url: 'about:blank' })
await sleep(400)
await send('Runtime.enable')
await send('Log.enable')
problems.length = 0
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base })

check('页面加载出状态栏', await waitFor(`!!document.querySelector('#dirty-text') && document.querySelector('#dirty-text').textContent.length > 0`))
await waitFor(`(document.querySelector('#dirty-text')||{}).textContent?.includes('已保存')`)

const statCount = await evaluate(`document.querySelectorAll('#stats .stat').length`)
check('运行状态卡片渲染', statCount >= 5, `${statCount} 张`)

const cfgPath = await evaluate(`(document.querySelectorAll('#stats .stat .v')[5]||{}).textContent || ''`)
check('显示配置文件路径', /print-server|admin-e2e\.json/.test(cfgPath), cfgPath)

const inited = await evaluate(`window.__op = { S: null }; typeof document.querySelector('#btn-add').onclick === 'function'`)
check('事件已绑定', inited === true)

/* ---- 新增连接：弹窗 + 引擎切换 ---- */
const before = await evaluate(`document.querySelectorAll('#conn-list .conn').length`)
await evaluate(`document.querySelector('#btn-add').click()`)
check('弹窗打开', await waitFor(`!!document.querySelector('#conn-mask')?.classList.contains('show')`))
check('默认 sqlite 区块可见', await evaluate(`getComputedStyle(document.querySelector('[data-eng-block="sqlite"]')).display !== 'none'`))
check('默认生成的 ID 非空', (await evaluate(`document.querySelector('[data-field="id"]').value`)) !== '')

await evaluate(`document.querySelector('#eng-seg button[data-eng="postgres"]').click()`)
check('切到 postgres：sqlite 区块隐藏', await evaluate(`getComputedStyle(document.querySelector('[data-eng-block="sqlite"]')).display === 'none'`))
check('切到 postgres：分项区块可见', await evaluate(`getComputedStyle(document.querySelector('[data-pgm-block="fields"]')).display !== 'none'`))
{
  await sleep(350) // 等合成器刷帧，否则截到上一帧的选中态
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out.replace(/\.png$/, '-pg-form.png'), Buffer.from(s.result.data, 'base64'))
}
await evaluate(`document.querySelector('#pgmode-seg button[data-pgm="url"]').click()`)
check('切到连接串模式', await evaluate(`getComputedStyle(document.querySelector('[data-pgm-block="url"]')).display !== 'none'`))

/* ---- 切回 sqlite，填 demo.db 并测试连接 ---- */
await evaluate(`document.querySelector('#eng-seg button[data-eng="sqlite"]').click()`)
await evaluate(`
  (function(){
    const set = (f, v) => {
      const el = document.querySelector('#conn-mask [data-field="' + f + '"]');
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('id', 'ui_demo');
    set('label', 'UI 建的示例库');
    set('path', 'F:/project/openprint/print-server/demo.db');
  })()
`)
await evaluate(`document.querySelector('#btn-test').click()`)
check('测试连接返回成功', await waitFor(`!!document.querySelector('#conn-banner')?.classList.contains('ok')`, 10000),
  await evaluate(`document.querySelector('#conn-banner').textContent`))

await evaluate(`document.querySelector('#btn-confirm').click()`)
check(
  '弹窗关闭且卡片数 +1',
  await evaluate(`!document.querySelector('#conn-mask').classList.contains('show') && document.querySelectorAll('#conn-list .conn').length === (${before} || 0) + 1`),
  `${before} → ${await evaluate(`document.querySelectorAll('#conn-list .conn').length`)}`
)
check('出现未保存提示', await evaluate(`document.querySelector('#dirty-text').textContent.includes('未保存')`))
check('保存按钮已启用', await evaluate(`!document.querySelector('#btn-save').disabled`))

/* ---- 目录浏览器 ---- */
await evaluate(`document.querySelector('#btn-spool-browse').click()`)
check('目录浏览器打开并列出盘符', await waitFor(`document.querySelectorAll('#fs-list .fs-item:not(.disabled)').length > 0`),
  await evaluate(`(document.querySelectorAll('#fs-list .fs-item:not(.disabled)').length) + ' 项'`))
await evaluate(`document.querySelector('#fs-cancel').click()`)

/* ---- 保存 ---- */
await evaluate(`document.querySelector('#btn-save').click()`)
check('保存后回到已保存态', await waitFor(`(document.querySelector('#dirty-text')||{}).textContent?.includes('已保存')`, 10000))

const saved = await evaluate(`fetch('/api/config', { headers: { 'X-OpenPrint-Admin': '1' } }).then(r => r.json()).then(d => JSON.stringify({ n: d.connections.length, ids: d.connections.map(c => c.id), label: (d.connections[0]||{}).label }))`)
check('后端配置已含新连接', /ui_demo/.test(saved || ''), saved)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))

/* ---- 编辑既有连接：ID 应只读 ---- */
await evaluate(`document.querySelector('#conn-list button[data-act="edit"]').click()`)
check('编辑态 ID 只读', await evaluate(`document.querySelector('#conn-mask [data-field="id"]').disabled === true`))
check('编辑态回填 label', (await evaluate(`document.querySelector('#conn-mask [data-field="label"]').value`)) === 'UI 建的示例库')
await evaluate(`document.querySelector('#btn-cancel').click()`)
check('取消后未改动', await evaluate(`document.querySelectorAll('#conn-list .conn').length === 1 && document.querySelector('#dirty-text').textContent.includes('已保存')`))

/* ---- 删除连接（走原生 confirm） ---- */
await evaluate(`document.querySelector('#conn-list button[data-act="del"]').click()`)
check('删除弹出确认框并自动确认', await waitForNode(() => dialogs > 0), `dialogs=${dialogs}`)
check('卡片移除且回到空态', await waitFor(`document.querySelectorAll('#conn-list .conn').length === 0 && !!document.querySelector('#conn-list .empty')`))
check(
  '已删除的库回到待加入列表',
  await evaluate(`[...document.querySelectorAll('#found-list button[data-addfound]')].some(b => /demo\\.db$/i.test(b.getAttribute('data-addfound')))`)
)
await evaluate(`document.querySelector('#btn-save').click()`)
check('保存后后端已无连接', await waitFor(`(document.querySelector('#dirty-text')||{}).textContent?.includes('已保存')`, 10000) &&
  /"n":0/.test(await evaluate(`fetch('/api/config', { headers: { 'X-OpenPrint-Admin': '1' } }).then(r => r.json()).then(d => JSON.stringify({ n: d.connections.length }))`)))

check('无页面错误', problems.length === 0, problems.slice(0, 4).join(' | '))

console.log(results.join('\n'))
console.log(`\n截图：${out}`)
console.log(problems.length ? `\n⚠️ 页面错误 ${problems.length} 条：\n` + problems.join('\n') : '')
ws.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
