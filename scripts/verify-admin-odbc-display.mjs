#!/usr/bin/env node
/**
 * 验证配置页在**三种能力状态**下各显示什么 —— 断言的是「页面不能撒谎」。
 *
 * 背景：`admin.html` 原来把「Rust 版客户端暂未实现 ODBC」**写死**在配置块和连接
 * 列表的标签里。ODBC 改成可选 feature 之后，这两处就变成**页面在说谎**：
 * 开着 feature 的构建明明能连，页面还在说「暂未实现」。
 *
 * 为什么不能只做静态检查（grep 一遍没有「暂未实现」就过）：三态里最容易被漏掉的是
 * **第三态**。读不到 `/health` 时如果按「未编入」显示，就把一次网络抖动说成
 * 「这个构建没有 ODBC」—— 换了个方向的谎，grep 是看不出来的。
 *
 * 所以这里真把页面跑起来（jsdom + 打桩的 fetch），三种状态各渲染一遍。
 *
 * **自带反向对照**（`--self-test`，默认就跑）：把源码改成「已知坏掉」的几种写法，
 * 确认这组断言**真的会红**。没有这一步，上面那些 ✓ 只能证明「碰巧是绿的」——
 * 第一版就在这里翻过车：`body.textContent` 把 `<script>` 源码也算进去，
 * 于是源码注释里的那句「暂未实现」被当成了页面上的字，三条断言全是假红。
 *
 * 用法（jsdom 在 designer-react 的依赖里，所以从那里解析；从哪个目录跑都行）：
 *     node scripts/verify-admin-odbc-display.mjs
 *     node scripts/verify-admin-odbc-display.mjs --no-self-test   # 只跑正例
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境缺 jsdom。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = join(ROOT, 'print-server/src/admin.html')
const SELF_TEST = !process.argv.includes('--no-self-test')

// ESM 的裸包解析是**按脚本自己的位置**往上找 node_modules，跟 cwd 无关，
// 而 jsdom 只装在 designer-react 里 → 必须显式指过去，不能指望 cwd。
const require = createRequire(join(ROOT, 'designer-react/package.json'))
let JSDOM
try {
  ;({ JSDOM } = require('jsdom'))
} catch (e) {
  console.error(
    '✗ 解析不到 jsdom（它装在 designer-react/node_modules）。\n' +
      '  先 `cd designer-react && npm install`，或按 sandbox-ts-verify 的办法备好依赖。\n' +
      `  原始错误：${e.message}`
  )
  process.exit(2)
}

const CONFIG = {
  ok: true,
  configPath: '/tmp/print-server.json',
  connections: [
    { id: 'erp', engine: 'odbc', label: 'ERP DSN', dsn: 'erp_dsn' },
    { id: 'local', engine: 'sqlite', label: '本地库', path: '/tmp/x.db' },
  ],
  scanDirs: [],
  spoolDir: '',
}

const CASES = [
  {
    name: '构建编入了 ODBC（/health.odbc = true）',
    health: { app: 'OpenPrint Client', ok: true, version: '0.1.0', uptimeSec: 60, odbc: true },
    hintHas: ['已编入'],
    hintHasNot: ['未编入', '读不到'],
    pill: false,
  },
  {
    name: '构建没编入 ODBC（/health.odbc = false）',
    health: { app: 'OpenPrint Client', ok: true, version: '0.1.0', uptimeSec: 60, odbc: false },
    hintHas: ['未编入', 'cargo build --features odbc'],
    hintHasNot: ['已编入', '读不到'],
    pill: true,
  },
  {
    name: '读不到 /health（服务不可达）—— 必须显示「未知」，不能当成「未编入」',
    health: null,
    hintHas: ['读不到'],
    hintHasNot: ['未编入', '已编入'],
    pill: false,
  },
]

// 三个「已知坏掉」的写法。探针必须至少对其中一个用例报红，否则等于没测。
const SELF_TESTS = [
  {
    name: '退回写死的「暂未实现」（本次要修的原 bug）',
    patches: [
      [
        "if (c.engine === 'odbc' && odbcBuiltIn() === false) pills.push('<span class=\"chip warn\">本构建未编入</span>');",
        "if (c.engine === 'odbc') pills.push('<span class=\"chip warn\">暂未实现</span>');",
      ],
      [
        '<div class="sub" id="odbc-hint" data-page-node-id="cNixXwPqFyrlGFoDKf1Vfe"></div>',
        '<div class="sub" data-page-node-id="cNixXwPqFyrlGFoDKf1Vfe">Rust 版客户端暂未实现 ODBC，配置可以保存，但暂时连不上</div>',
      ],
    ],
  },
  {
    name: '读不到 /health 时当成「未编入」（另一个方向的谎）',
    patches: [
      [
        "if (!S.health || typeof S.health.odbc !== 'boolean') return null;\n    return S.health.odbc;",
        'return !!(S.health && S.health.odbc);',
      ],
    ],
  },
  {
    name: '提示整个不渲染（静默没显示）',
    // renderAll 里那一处调用；fillForm 里还有一处，所以只砍这里 → 首次加载后提示是空的
    patches: [['    renderDirty();\n    renderOdbcHint();', '    renderDirty();']],
  },
]

/**
 * 把页面跑起来，返回渲染结果。`health` 传 `null` 表示 /health 请求直接失败。
 */
async function render(html, health) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:18888/',
    runScripts: 'dangerously',
    beforeParse(win) {
      win.fetch = async (input) => {
        const url = String(typeof input === 'string' ? input : input.url)
        const path = url.replace(/^https?:\/\/[^/]+/, '')
        if (path.startsWith('/health')) {
          if (health === null) throw new Error('ECONNREFUSED（打桩：服务不可达）')
          return { ok: true, status: 200, json: async () => health }
        }
        if (path.startsWith('/api/config')) {
          return { ok: true, status: 200, json: async () => CONFIG }
        }
        if (path.startsWith('/api/data/databases')) {
          return { ok: true, status: 200, json: async () => ({ databases: [] }) }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      }
    },
  })
  // load() 里是一串 await（Promise.all + renderAll），等它落地
  await new Promise((r) => setTimeout(r, 80))
  const doc = dom.window.document
  const $ = (sel) => doc.querySelector(sel)

  // 「页面上不再出现某句话」必须**排除 <script> / <style> 的源码**：
  // body.textContent 把 <script> 的文本也算进去，于是源码里的注释会被当成
  // 页面上显示的字 —— 第一版就是这么误报的（注释里正好写了那句要消灭的话）。
  const rendered = doc.body.cloneNode(true)
  rendered.querySelectorAll('script, style').forEach((n) => n.remove())

  const out = {
    hint: ($('#odbc-hint') || {}).textContent || '',
    connsHtml: ($('#conn-list') || {}).innerHTML || '',
    body: rendered.textContent || '',
  }
  dom.window.close()
  return out
}

/** 跑一个用例，返回失败说明数组（空 = 全绿）。 */
async function runCase(html, c) {
  const bad = []
  const check = (cond, label, detail) => {
    if (!cond) bad.push(`${label}${detail ? ` —— ${detail}` : ''}`)
  }

  const r = await render(html, c.health)

  check(r.hint.trim().length > 0, '#odbc-hint 不是空的（空了等于静默没显示）', JSON.stringify(r.hint))
  for (const want of c.hintHas) {
    check(r.hint.includes(want), `提示里有「${want}」`, JSON.stringify(r.hint))
  }
  for (const not of c.hintHasNot) {
    check(!r.hint.includes(not), `提示里没有「${not}」`, JSON.stringify(r.hint))
  }

  const hasPill = r.connsHtml.includes('本构建未编入')
  check(
    hasPill === c.pill,
    c.pill ? '连接列表挂了「本构建未编入」标签' : '连接列表没有挂「本构建未编入」标签',
    JSON.stringify((r.connsHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200))
  )

  // 直接守住这次改动要消灭的那句话（只看渲染出来的字，不含 script 源码）
  check(
    !r.body.includes('暂未实现'),
    '页面上不再出现「暂未实现」（改 feature 后那句话就是错的）',
    JSON.stringify(r.body.replace(/\s+/g, ' ').slice(0, 300))
  )

  return bad
}

let failed = 0
const source = readFileSync(HTML, 'utf8')

console.log(`正例（${CASES.length} 种能力状态）…`)
for (const c of CASES) {
  const bad = await runCase(source, c)
  console.log(`\n  [${c.name}]`)
  if (!bad.length) {
    console.log('    ✓ 全部通过')
  } else {
    for (const b of bad) console.log(`    ✗ ${b}`)
    failed += bad.length
  }
}

if (SELF_TEST) {
  console.log(`\n反向对照（${SELF_TESTS.length} 种「已知坏掉」的写法，探针必须报红）…`)
  for (const t of SELF_TESTS) {
    let html = source
    for (const [from, to] of t.patches) {
      if (!html.includes(from)) {
        console.log(`\n  [${t.name}]`)
        console.log(`    ✗ 注入点找不到（源码变了？）—— ${JSON.stringify(from.slice(0, 60))}`)
        failed++
        continue
      }
      html = html.replace(from, to)
    }
    if (html === source) continue

    // 只要**任意一个**用例报红就算抓到（不同坏法在不同状态暴露）
    let caught = []
    for (const c of CASES) {
      const bad = await runCase(html, c)
      if (bad.length) caught.push(`${c.name}：${bad[0]}`)
    }
    console.log(`\n  [${t.name}]`)
    if (caught.length) {
      console.log(`    ✓ 抓到 —— ${caught[0].slice(0, 130)}`)
    } else {
      console.log('    ✗ 探针**没抓到**（三个状态全绿 = 这组断言是摆设）')
      failed++
    }
  }
}

console.log()
if (failed) {
  console.log(`✗ ${failed} 条失败`)
  process.exit(1)
}
console.log('✓ 全部通过')
