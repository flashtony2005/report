/**
 * kernel-purity —— 画布内核依赖纯净性守卫
 *
 * 背景：P2 的核心决策是「React 端**零复制**复用画布内核」（CanvasDesigner + 14 类
 * 控件 + SmartGuides 通过 vite alias 直接引用 Vue 项目的源码）。这个决策成立的
 * 前提是内核的整条 import 链**永不触及 vue / pinia** —— 否则 React 工程会隐式
 * 依赖 Vue 项目的 node_modules（真实发生过：rulerHighlight 曾用 vue ref，导致
 * React 端悄悄解析到 Vue 项目的 vue 包，测试还全绿）。
 *
 * 本测试从 CanvasDesigner.ts 出发，静态递归解析全部 import，断言可达模块集合
 * 里没有任何文件 import vue / pinia。以后谁往内核里加框架依赖，这条守卫就会红。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const OPENPRINT_SRC = resolve(__dirname, '../../../openprint/src')
const ENTRY = resolve(OPENPRINT_SRC, 'design/canvas/CanvasDesigner.ts')

/** 仅允许的外部包（框架无关的第三方依赖） */
const ALLOWED_EXTERNAL = new Set([
  'fabric',
  'qrcode',
  'dompurify',
  '@bwip-js/generic',
  'katex',
  'jspdf',
  'svg2pdf.js',
  'opentype.js',
  // shim（designer-react 内）引入；React 端原生依赖
  'zustand',
])

/**
 * 与 designer-react/vite.config.ts 保持一致的 alias（守卫必须模拟 vite 的真实解析）。
 * 若 vite.config 的 shim alias 变更，这里必须同步 —— 下方有专门用例验证 shim 有效。
 */
const VITE_ALIAS: Array<[string, string]> = [
  [
    '@/design/stores/dataSource',
    resolve(__dirname, '../canvas/shims/dataSource.ts'),
  ],
]

/** 从 import 声明中提取模块说明符 */
function extractImports(text: string): string[] {
  const specs: string[] = []
  // import ... from 'x'（含多行）/ export ... from 'x' / import 'x'
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) specs.push(m[1]!)
  // 裸 import 'x'
  const bare = /\bimport\s*['"]([^'"]+)['"]/g
  while ((m = bare.exec(text))) specs.push(m[1]!)
  // 动态 import('x')
  const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dyn.exec(text))) specs.push(m[1]!)
  return specs
}

/** 把模块说明符解析为本地文件路径（解析不到 = 外部包，返回 null） */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = resolve(OPENPRINT_SRC, spec.slice(2))
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec)
  else return null // 外部包
  // 模拟 vite 的 shim alias：命中后直接落到 designer-react 内的替代实现
  const aliased = VITE_ALIAS.find(([from]) => spec === from)
  if (aliased) base = aliased[1]!
  // 去掉 vite 资源尾巴（如 ?raw）
  base = base.replace(/\?.*$/, '')
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ]
  return candidates.find((p) => existsSync(p) && statSync(p).isFile()) ?? null
}

/** BFS 收集从入口可达的全部本地模块 */
function collectReachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>() // 文件 → 它 import 的外部包列表
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    const text = readFileSync(file, 'utf-8')
    const externals: string[] = []
    for (const spec of extractImports(text)) {
      const target = resolveSpecifier(spec, file)
      if (target) queue.push(target)
      else {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
        externals.push(pkg)
      }
    }
    seen.set(file, externals)
  }
  return seen
}

describe('画布内核依赖纯净性', () => {
  it('CanvasDesigner 整条 import 链不触及 vue / pinia，且外部依赖全部在白名单内', () => {
    const reachable = collectReachable(ENTRY)
    expect(reachable.size).toBeGreaterThan(5) // 链路确实展开过（防止静默解析失败）

    const offenders: string[] = []
    for (const [file, externals] of reachable) {
      for (const pkg of externals) {
        if (pkg === 'vue' || pkg === 'pinia') {
          offenders.push(`${file} → ${pkg}`)
        } else if (!ALLOWED_EXTERNAL.has(pkg)) {
          offenders.push(`${file} → 未知外部包 ${pkg}（如确属框架无关依赖，请加入 ALLOWED_EXTERNAL）`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('内核链路覆盖了控件注册表与 SmartGuides（关键节点确实在守卫范围内）', () => {
    const reachable = collectReachable(ENTRY)
    // 统一成正斜杠便于跨平台断言
    const files = [...reachable.keys()].map((f) => f.replace(/\\/g, '/'))
    expect(files.some((f) => f.endsWith('controls/index.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('guides/SmartGuides.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('table-design-render.ts'))).toBe(true)
    // dataSource shim 已生效：链路里不应出现 Vue 项目的 dataSource store
    expect(files.some((f) => f.endsWith('openprint/src/design/stores/dataSource.ts'))).toBe(false)
  })
})
