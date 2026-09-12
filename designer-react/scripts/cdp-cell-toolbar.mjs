/**
 * cdp-cell-toolbar.mjs —— 单元格浮动工具栏（CellToolbar）浏览器实测
 *
 * 验证 P7 收尾：双击进入单元格后 React 端工具条真的挂出来，且按钮点击
 * 经 onApply → TableViewLayer → store 写回链路生效（非仅单测绿）。
 *
 * 用法：
 *   1. 起 5189 dev server 与 9222 headless Edge
 *   2. node scripts/cdp-cell-toolbar.mjs
 */
import fs from 'node:fs'

const URL_APP = process.env.OP_URL || 'http://localhost:5189'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
let consoleErrors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXC: ' + (m.params?.exceptionDetails?.text ?? '?'))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push('ERR: ' + (m.params.args ?? []).map((a) => a.value ?? a.description).join(' '))
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evalJs = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(new URL('./' + name, import.meta.url), Buffer.from(r.result.data, 'base64'))
}
const mouse = (type, x, y, opt = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...opt })
const clickAt = async (x, y) => {
  await mouse('mouseMoved', Math.round(x), Math.round(y))
  await mouse('mousePressed', Math.round(x), Math.round(y), { clickCount: 1 })
  await mouse('mouseReleased', Math.round(x), Math.round(y), { clickCount: 1 })
  await new Promise((r) => setTimeout(r, 400))
}
/** 按可见文本点元素（取最内层的那个） */
const clickText = async (text) => {
  const pos = await evalJs(`(() => {
    const t = ${JSON.stringify(text)}
    const els = [...document.querySelectorAll('li, .ant-dropdown-menu-item, button, .ant-menu-item, [role=menuitem], span')]
      .filter((e) => e.offsetParent !== null && e.childElementCount === 0 && e.textContent.replace(/\\s/g, '') === t)
    const el = els[els.length - 1]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!pos) return false
  await clickAt(pos.x, pos.y)
  return true
}
/** 按 testid 点元素；若元素矩形落在视口外（工具条定位在单元格上方，靠近画布顶部时会越界），
 *  退化为元素自身的 click() —— 仍是真实 DOM 事件，React 根监听照常处理。 */
const clickTestId = async (tid) => {
  const info = await evalJs(`(() => {
    const el = document.querySelector('[data-testid="' + ${JSON.stringify(tid)} + '"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      text: (el.textContent || '').replace(/\\s/g, ''),
      inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
    }
  })()`)
  if (!info) return null
  if (info.inView) {
    await clickAt(info.x, info.y)
    info.via = 'mouse'
  } else {
    await evalJs(`(() => { const el = document.querySelector('[data-testid="' + ${JSON.stringify(tid)} + '"]'); if (el) el.click(); return 1 })()`)
    await new Promise((r) => setTimeout(r, 400))
    info.via = 'el.click(视口外)'
  }
  return info
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL_APP })
await new Promise((r) => setTimeout(r, 16000)) // 冷启动需 16s

const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: Boolean(cond), extra })
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

// 1. 载入示例模板（文件 → 载入示例模板）
await clickText('文件')
await new Promise((r) => setTimeout(r, 700))
const demoClicked = await clickText('载入示例模板')
await new Promise((r) => setTimeout(r, 1200))
ok('载入示例模板', demoClicked)

const ctrlStat = await evalJs(`(() => {
  const s = window.__op.getState()
  const flat = [...s.controls, ...s.zones.flatMap((z) => z.children)]
  const tables = flat.filter((c) => c.type === 'table')
  return { total: flat.length, tables: tables.map((t) => ({ id: t.id, cols: (t.columns || []).length, rows: (t.cells || []).length })) }
})()`)
ok('模板含表格控件', ctrlStat?.tables?.length > 0, JSON.stringify(ctrlStat?.tables))
if (!ctrlStat?.tables?.length) {
  console.log('中止：没有表格控件可测')
  ws.close()
  process.exit(1)
}

// 2. 进入单元格编辑（等价双击命中单元格后的 store 状态）
const tableId = ctrlStat.tables[0].id
await evalJs(`(() => { window.__op.getState().openCellEditor(${JSON.stringify(tableId)}, 0, 0); return 1 })()`)
await new Promise((r) => setTimeout(r, 600))

const bar = await evalJs(`(() => {
  const el = document.querySelector('[data-testid="cell-toolbar"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return {
    present: true,
    x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    role: (document.querySelector('[data-testid="cell-role"]') || {}).textContent || '',
    buttons: [...el.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\\s/g, '')).filter(Boolean),
    hasFormatRow: !!el.querySelector('[data-testid="cell-format-kind"]'),
  }
})()`)
ok('编辑态挂出 CellToolbar', bar?.present, bar ? `role=${bar.role} 尺寸=${bar.w}x${bar.h}` : '未找到')

// 3. 点「B」加粗 → 用户可见的激活态与模型都应变化
//    注意：表头格**默认加粗**（cellFromColumn → style.bold=true），故首次点击是「取消加粗」。
const boldActive = () =>
  evalJs(`(() => {
    const b = document.querySelector('[data-testid="cell-bold"]')
    return !!(b && b.className.indexOf('ant-btn-primary') >= 0)
  })()`)
const boldBefore = await boldActive()
const bBtn = await clickTestId('cell-bold')
ok('找到「B」加粗按钮', !!bBtn, bBtn ? `rect=${JSON.stringify(bBtn.rect)} 点击方式=${bBtn.via}` : '未找到')
await new Promise((r) => setTimeout(r, 500))
const boldAfter = await boldActive()
ok('点「B」→ 按钮激活态翻转', boldBefore !== boldAfter, `加粗激活 ${boldBefore} → ${boldAfter}`)

const modelBold = await evalJs(`(() => {
  const s = window.__op.getState()
  const flat = [...s.controls, ...s.zones.flatMap((z) => z.children)]
  const t = flat.find((c) => c.id === ${JSON.stringify(tableId)})
  const st = t && t.cells && t.cells[0] && t.cells[0][0] && t.cells[0][0].style
  return st ? JSON.stringify(st) : null
})()`)
ok(
  '写回模型：表头默认加粗被取消（bold=false 落到 cells[0][0].style）',
  !!modelBold && /"bold":false/.test(modelBold),
  `cells[0][0].style=${modelBold}`,
)
ok('写回后工具条仍在（未被误关）', await evalJs(`!!document.querySelector('[data-testid="cell-toolbar"]')`))

// 4. 上方插入行 → 行数 +1
const rowsBefore = await evalJs(`(() => {
  const s = window.__op.getState()
  const flat = [...s.controls, ...s.zones.flatMap((z) => z.children)]
  const t = flat.find((c) => c.id === ${JSON.stringify(tableId)})
  return (t && t.cells && t.cells.length) || 0
})()`)
const ins = await clickTestId('cell-insert-row-above')
ok('找到「上方插入行」按钮', !!ins, ins ? `文本=${ins.text}` : '未找到')
await new Promise((r) => setTimeout(r, 500))
const rowsAfter = await evalJs(`(() => {
  const s = window.__op.getState()
  const flat = [...s.controls, ...s.zones.flatMap((z) => z.children)]
  const t = flat.find((c) => c.id === ${JSON.stringify(tableId)})
  return (t && t.cells && t.cells.length) || 0
})()`)
ok('插入行生效（store 行数 +1）', rowsAfter === rowsBefore + 1, `${rowsBefore} → ${rowsAfter}`)

await shot('单元格工具条-React.png')

// 5. 关闭按钮 → 退出编辑
const closeRes = await clickTestId('cell-close')
await new Promise((r) => setTimeout(r, 500))
const stillEditing = await evalJs(`!!window.__op.getState().editingCell`)
ok('点「✕」退出编辑', closeRes ? !stillEditing : false, `editingCell=${stillEditing}`)
const gone = await evalJs(`!document.querySelector('[data-testid="cell-toolbar"]')`)
ok('退出后工具条消失', gone)

/**
 * 已知既有告警白名单 —— 与本轮改动无关：
 * 加载示例模板时 TopToolbar 用 antd 静态 message API，触发 antd v6 的 context 提示。
 */
const KNOWN_NOISE = [/Static function can not consume context/]
const ignored = consoleErrors.filter((e) => KNOWN_NOISE.some((re) => re.test(e)))
const realErrors = consoleErrors.filter((e) => !KNOWN_NOISE.some((re) => re.test(e)))
ok('无（新增）控制台错误', realErrors.length === 0, realErrors.slice(0, 4).join(' | ') || `仅既有告警 ${ignored.length} 条`)

const failed = results.filter((r) => !r.pass)
console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) console.log('失败项：\n' + failed.map((f) => ' - ' + f.name).join('\n'))

ws.close()
process.exit(failed.length ? 1 : 0)
