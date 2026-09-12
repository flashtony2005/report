/**
 * 表达式引擎 —— 绑定取值 / 插值 / 条件渲染的统一入口
 * 真理源：《OpenPrint-设计方案.md》§5.3（表达式文本）、§5.6（条件渲染）、§5.4（列 expression）
 *
 * ## 为什么不用 mustache？
 * §11.2 建议用 mustache 做 `resolveBinding()`，但 mustache 是**逻辑无关**模板引擎：
 * 它无法求值 `{{rowIndex + 1}}`、`{{row.price * row.qty}}`（§5.4 列表达式的原文示例），
 * 也不支持 `{{order.total | currency:'CNY'}}` 的过滤器语法（§5.3 原文示例）。
 * 而 `new Function` / `eval` 方案在 ERP 场景不可接受（模板可能来自不可信的第三方设计者，
 * 且企业环境常配 CSP `script-src` 白名单，eval 直接被拦）。
 *
 * 因此这里实现一个**受限安全求值器**：
 * - 纯 Pratt 解析 + 树求值，无 new Function / eval / with
 * - 白名单运算符，无函数调用、无属性赋值、无原型访问（__proto__ / constructor 被拒）
 * - 只读取传入的 EvalContext，够不到全局对象
 * 覆盖面严格 ⊇ mustache 的用途，且顺带解决 visibleIf，一个引擎服务三处。
 */
import type { EvalContext } from './types'
import type { CellFormat } from '@/types/control'
import { toChineseCapitalRMB } from './aggregate'
/* ================================ 词法分析 ================================ */

type TokenType = 'num' | 'str' | 'ident' | 'op' | 'eof'

interface Token {
  type: TokenType
  value: string
  pos: number
}

/** 多字符运算符按长度降序，保证 `===` 不被切成 `==` + `=` */
const OPERATORS = [
  '===',
  '!==',
  '==',
  '!=',
  '>=',
  '<=',
  '&&',
  '||',
  '??',
  '+',
  '-',
  '*',
  '/',
  '%',
  '>',
  '<',
  '!',
  '?',
  ':',
  '(',
  ')',
  '[',
  ']',
  '.',
  ',',
]

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!

    // 空白
    if (/\s/.test(ch)) {
      i++
      continue
    }

    // 字符串字面量（单/双引号，支持反斜杠转义）
    if (ch === "'" || ch === '"') {
      const quote = ch
      let out = ''
      let j = i + 1
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1]
          j += 2
        } else {
          out += src[j]
          j++
        }
      }
      tokens.push({ type: 'str', value: out, pos: i })
      i = j + 1
      continue
    }

    // 数字（含小数）
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++
      tokens.push({ type: 'num', value: src.slice(i, j), pos: i })
      i = j
      continue
    }

    // 标识符（含中文字段名，ERP 里很常见）
    if (/[A-Za-z_$\u4e00-\u9fa5]/.test(ch)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(src[j]!)) j++
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i })
      i = j
      continue
    }

    // 运算符
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i })
      i += op.length
      continue
    }

    throw new Error(`表达式非法字符 "${ch}"（位置 ${i}）`)
  }
  tokens.push({ type: 'eof', value: '', pos: i })
  return tokens
}

/* ================================ 语法分析 ================================ */

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'path'; segs: Array<string | Node> }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }

/** 二元运算符优先级（数字越大结合越紧） */
const BIN_PREC: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '===': 4,
  '!==': 4,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
}

/** 禁止访问的属性名 —— 防原型链逃逸 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!
  }

  private next(): Token {
    return this.tokens[this.pos++]!
  }

  private eat(value: string): boolean {
    if (this.peek().type === 'op' && this.peek().value === value) {
      this.pos++
      return true
    }
    return false
  }

  private expect(value: string): void {
    if (!this.eat(value)) {
      throw new Error(`表达式缺少 "${value}"（位置 ${this.peek().pos}）`)
    }
  }

  parse(): Node {
    const node = this.parseTernary()
    if (this.peek().type !== 'eof') {
      throw new Error(`表达式多余内容 "${this.peek().value}"`)
    }
    return node
  }

  /** 三元（右结合，优先级最低） */
  private parseTernary(): Node {
    const cond = this.parseBinary(0)
    if (this.eat('?')) {
      const a = this.parseTernary()
      this.expect(':')
      const b = this.parseTernary()
      return { t: 'cond', c: cond, a, b }
    }
    return cond
  }

  /** 优先级爬升 */
  private parseBinary(minPrec: number): Node {
    let left = this.parseUnary()
    for (;;) {
      const tok = this.peek()
      if (tok.type !== 'op') break
      const prec = BIN_PREC[tok.value]
      if (prec === undefined || prec < minPrec) break
      this.next()
      const right = this.parseBinary(prec + 1) // 全部左结合
      left = { t: 'bin', op: tok.value, a: left, b: right }
    }
    return left
  }

  private parseUnary(): Node {
    const tok = this.peek()
    if (tok.type === 'op' && (tok.value === '!' || tok.value === '-' || tok.value === '+')) {
      this.next()
      return { t: 'un', op: tok.value, a: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Node {
    const tok = this.next()

    if (tok.type === 'num') return { t: 'lit', v: Number(tok.value) }
    if (tok.type === 'str') return { t: 'lit', v: tok.value }

    if (tok.type === 'op' && tok.value === '(') {
      const node = this.parseTernary()
      this.expect(')')
      return node
    }

    if (tok.type === 'ident') {
      if (tok.value === 'true') return { t: 'lit', v: true }
      if (tok.value === 'false') return { t: 'lit', v: false }
      if (tok.value === 'null') return { t: 'lit', v: null }
      if (tok.value === 'undefined') return { t: 'lit', v: undefined }
      // 标识符后紧跟 ( → 函数调用：now() / sum('items[].amount')
      if (this.peek().type === 'op' && this.peek().value === '(') {
        return this.parseCall(tok.value)
      }
      return this.parsePath(tok.value)
    }

    throw new Error(`表达式意外符号 "${tok.value}"（位置 ${tok.pos}）`)
  }

  /** 路径：a.b[0].c，以及协议里的数组标记 a[] */
  private parsePath(head: string): Node {
    const segs: Array<string | Node> = [head]
    for (;;) {
      if (this.eat('.')) {
        const tok = this.next()
        if (tok.type !== 'ident' && tok.type !== 'num') {
          throw new Error(`路径 "." 后应为字段名（位置 ${tok.pos}）`)
        }
        segs.push(tok.value)
        continue
      }
      if (this.eat('[')) {
        // `items[]` —— 协议里表示"该数组本身"，跳过不产生下标段
        if (this.eat(']')) continue
        const idx = this.parseTernary()
        this.expect(']')
        segs.push(idx)
        continue
      }
      break
    }
    return { t: 'path', segs }
  }

  /** 函数调用：name(args)。参数用逗号分隔，每个参数是一个完整表达式。 */
  private parseCall(name: string): Node {
    this.next() // 消费 '('
    const args: Node[] = []
    if (this.peek().type === 'op' && this.peek().value === ')') {
      this.next()
      return { t: 'call', name, args }
    }
    args.push(this.parseTernary())
    while (this.eat(',')) args.push(this.parseTernary())
    this.expect(')')
    return { t: 'call', name, args }
  }
}

/* ================================= 求值 ================================= */

function looseEqual(a: unknown, b: unknown): boolean {
  // 避免 eslint eqeqeq；语义等价于 ==（仅做数字/字符串宽松比较）
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined)
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return String(a) === String(b)
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

function isTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  return Boolean(v)
}

/** 空值判定：null / undefined / 空串 / 空数组 视为空 */
function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

function readProp(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined
  if (FORBIDDEN_KEYS.has(key)) return undefined
  if (typeof obj !== 'object' && typeof obj !== 'string') return undefined
  // 数组的 length 允许；字符串的 length 允许
  return (obj as Record<string, unknown>)[key]
}

function evalNode(node: Node, ctx: EvalContext, scope?: Record<string, unknown>): unknown {
  switch (node.t) {
    case 'lit':
      return node.v

    case 'path': {
      const [head, ...rest] = node.segs as [string, ...Array<string | Node>]
      let cur: unknown = resolveRoot(head, ctx, scope)
      for (const seg of rest) {
        if (cur === null || cur === undefined) return undefined
        const key = typeof seg === 'string' ? seg : String(evalNode(seg, ctx, scope))
        cur = readProp(cur, key)
      }
      return cur
    }

    case 'call': {
      const fn = FUNCTIONS[node.name]
      if (!fn) throw new Error(`未知函数 "${node.name}()"`)
      const args = node.args.map((a) => evalNode(a, ctx, scope))
      return fn(args, ctx)
    }

    case 'un': {
      const v = evalNode(node.a, ctx)
      if (node.op === '!') return !isTruthy(v)
      if (node.op === '-') return -toNum(v)
      return toNum(v)
    }

    case 'cond':
      return isTruthy(evalNode(node.c, ctx)) ? evalNode(node.a, ctx) : evalNode(node.b, ctx)

    case 'bin': {
      // 短路运算符先处理
      if (node.op === '&&') {
        const a = evalNode(node.a, ctx, scope)
        return isTruthy(a) ? evalNode(node.b, ctx, scope) : a
      }
      if (node.op === '||') {
        const a = evalNode(node.a, ctx, scope)
        return isTruthy(a) ? a : evalNode(node.b, ctx, scope)
      }
      if (node.op === '??') {
        const a = evalNode(node.a, ctx, scope)
        return a === null || a === undefined ? evalNode(node.b, ctx, scope) : a
      }

      const a = evalNode(node.a, ctx, scope)
      const b = evalNode(node.b, ctx, scope)
      switch (node.op) {
        case '+':
          // 任一侧为字符串则拼接，符合直觉（"单号-" + order.no）
          if (typeof a === 'string' || typeof b === 'string') return String(a ?? '') + String(b ?? '')
          return toNum(a) + toNum(b)
        case '-':
          return toNum(a) - toNum(b)
        case '*':
          return toNum(a) * toNum(b)
        case '/': {
          const d = toNum(b)
          return d === 0 ? 0 : toNum(a) / d
        }
        case '%': {
          const d = toNum(b)
          return d === 0 ? 0 : toNum(a) % d
        }
        case '===':
          return a === b
        case '!==':
          return a !== b
        case '==':
          return looseEqual(a, b)
        case '!=':
          return !looseEqual(a, b)
        case '<':
          return toNum(a) < toNum(b)
        case '<=':
          return toNum(a) <= toNum(b)
        case '>':
          return toNum(a) > toNum(b)
        case '>=':
          return toNum(a) >= toNum(b)
        default:
          throw new Error(`不支持的运算符 "${node.op}"`)
      }
    }
  }
}

/**
 * 路径根解析。约定（与字段树 path 对齐）：
 * - `data`  → 数据根（§5.6 的 `data.vip === true`）
 * - `row`   → 当前行；`rowIndex` → 行号；`page` / `pages` → 页码变量
 * - 其他标识符 → 先在 row 里找（表格单元格里 `qty` 即 `row.qty`），再退到数据根
 */
function resolveRoot(head: string, ctx: EvalContext, scope?: Record<string, unknown>): unknown {
  // 自定义作用域（如合计表达式里的 sum/avg/rows/allRows）优先于数据根解析
  if (scope && head in scope) return readProp(scope, head)
  switch (head) {
    case 'data':
      return ctx.data
    case 'row':
      return ctx.row
    case 'rowIndex':
      return ctx.rowIndex ?? 0
    // 页码变量的多种别名，模板设计者不必记忆唯一写法
    case 'page':
    case 'pageNo':
    case 'pageNumber':
      return ctx.page ?? 1
    case 'pages':
    case 'pageCount':
    case 'totalPages':
      return ctx.pages ?? 1
    default:
      if (ctx.row && head in (ctx.row as object)) return readProp(ctx.row, head)
      return readProp(ctx.data, head)
  }
}

/* =============================== 编译缓存 =============================== */

const astCache = new Map<string, Node | Error>()

function compile(src: string): Node {
  const hit = astCache.get(src)
  if (hit instanceof Error) throw hit
  if (hit) return hit
  try {
    const ast = new Parser(tokenize(src)).parse()
    astCache.set(src, ast)
    return ast
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    astCache.set(src, err)
    throw err
  }
}

/**
 * 求值单个表达式（不含 {{}}）。失败时抛错，由调用方转 warning。
 * @param scope 可选额外作用域（如自定义合计里的 sum/avg/rows/allRows），标识符解析时优先于数据根。
 */
export function evaluate(src: string, ctx: EvalContext, scope?: Record<string, unknown>): unknown {
  return evalNode(compile(src), ctx, scope)
}

/** 条件渲染判定（§5.6）。表达式为空视为可见；求值失败**保守可见**，避免静默丢内容。 */
export function evaluateVisible(src: string | undefined, ctx: EvalContext): boolean {
  if (!src || !src.trim()) return true
  try {
    return isTruthy(evaluate(src, ctx))
  } catch {
    return true
  }
}

/* ================================ 过滤器 ================================ */

export type Filter = (value: unknown, ...args: unknown[]) => string

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  RMB: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
}

function groupThousands(fixed: string): string {
  const [int = '0', dec] = fixed.split('.')
  const sign = int.startsWith('-') ? '-' : ''
  const digits = sign ? int.slice(1) : int
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + grouped + (dec ? `.${dec}` : '')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDate(value: unknown, pattern = 'YYYY-MM-DD'): string {
  if (value === null || value === undefined || value === '') return ''
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) return String(value)
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
  }
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (k) => map[k] ?? k)
}

export const FILTERS: Record<string, Filter> = {
  /** {{ order.total | currency:'CNY' }} → ¥12,800.50 */
  currency(value, code = 'CNY', digits = 2) {
    const symbol = CURRENCY_SYMBOL[String(code).toUpperCase()] ?? ''
    return symbol + groupThousands(toNum(value).toFixed(toNum(digits)))
  },
  /** {{ items[].qty | number:0 }} → 1,234 */
  number(value, digits = 2) {
    return groupThousands(toNum(value).toFixed(toNum(digits)))
  },
  /** 不加千分位的定点小数 */
  fixed(value, digits = 2) {
    return toNum(value).toFixed(toNum(digits))
  },
  /** {{ order.rate | percent:1 }} → 12.5% */
  percent(value, digits = 2) {
    return `${(toNum(value) * 100).toFixed(toNum(digits))}%`
  },
  /** {{ order.orderDate | date:'YYYY年MM月DD日' }} */
  date(value, pattern = 'YYYY-MM-DD') {
    return formatDate(value, String(pattern))
  },
  upper(value) {
    return String(value ?? '').toUpperCase()
  },
  lower(value) {
    return String(value ?? '').toLowerCase()
  },
  /** 空值兜底：{{ customer.memo | default:'无' }} */
  default(value, fallback = '') {
    const empty = value === null || value === undefined || value === ''
    return empty ? String(fallback) : String(value)
  },
  /** 超长截断：{{ productName | truncate:10 }} */
  truncate(value, len = 20, suffix = '…') {
    const s = String(value ?? '')
    const n = toNum(len)
    return s.length > n ? s.slice(0, n) + String(suffix) : s
  },
  /** 补零：{{ seq | padStart:3 }} → 007 */
  padStart(value, len = 2, fill = '0') {
    return String(value ?? '').padStart(toNum(len), String(fill))
  },  rmb(value) {
    return toChineseCapitalRMB(toNum(value))
  },
}

/* ============================== 内置函数 ============================== */

/** 表达式内置函数签名：参数已逐个求值后传入，ctx 用于解析路径字符串。 */
export type ExprFunction = (args: unknown[], ctx: EvalContext) => unknown

function toArrayLike(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/**
 * 把聚合参数解析为数值数组：
 * - 字符串路径 `'items[].amount'` → 取 data.items 每项的 amount 字段；
 * - 字符串路径 `'items'` → 直接求值该路径得到数组；
 * - 已求值的数组 → 原样转数值。
 * 用户需写成带引号的路径字符串（裸 `items[].amount` 会被当作普通路径字段访问）。
 */
function resolveNumericArray(arg: unknown, ctx: EvalContext): number[] {
  let arr: unknown[]
  if (typeof arg === 'string') {
    const marker = arg.indexOf('[]')
    if (marker >= 0) {
      const base = arg.slice(0, marker)
      const field = arg.slice(marker + 2).replace(/^\./, '')
      const baseVal = evaluate(base, ctx)
      const list = toArrayLike(baseVal)
      arr = field ? list.map((el) => readProp(el, field)) : list
    } else {
      arr = toArrayLike(evaluate(arg, ctx))
    }
  } else {
    arr = toArrayLike(arg)
  }
  return arr.map((v) => toNum(v))
}

/**
 * 内置函数表（表达式可调用，如 `now()` / `sum('items[].amount')`）。
 * 与 `{{sum}}` 这类裸标识符（表格页脚经 scope 注入）互不冲突：
 * 前者是 `函数调用` 语法，后者走 resolveRoot 的 scope 分支。
 */
export const FUNCTIONS: Record<string, ExprFunction> = {
  /** 当前系统时间（可接 `| date` 过滤器）：{{ now() | date:'YYYY-MM-DD HH:mm' }} */
  now() {
    return new Date()
  },
  /** 数值数组求和：{{ sum('items[].amount') }} */
  sum(args, ctx) {
    return resolveNumericArray(args[0], ctx).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)
  },
  /** 平均值：{{ avg('items[].qty') }} */
  avg(args, ctx) {
    const arr = resolveNumericArray(args[0], ctx)
    return arr.length ? arr.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) / arr.length : 0
  },
  /** 计数（非空项数）：{{ count('items[].qty') }} */
  count(args, ctx) {
    return resolveNumericArray(args[0], ctx).length
  },
  /** 最小值：{{ min('items[].amount') }} */
  min(args, ctx) {
    const arr = resolveNumericArray(args[0], ctx).filter(Number.isFinite)
    return arr.length ? Math.min(...arr) : 0
  },
  /** 最大值：{{ max('items[].amount') }} */
  max(args, ctx) {
    const arr = resolveNumericArray(args[0], ctx).filter(Number.isFinite)
    return arr.length ? Math.max(...arr) : 0
  },
  /** 长度（数组或字符串）：{{ len(items) }} / {{ len("abc") }} */
  len(args) {
    const v = args[0]
    if (Array.isArray(v)) return v.length
    if (typeof v === 'string') return v.length
    return 0
  },
  /** 条件判断：条件成立返回第二参数，否则第三参数（与 ?: 等价，函数写法更直观） */
  if(args) {
    return isTruthy(args[0]) ? args[1] : args[2]
  },
  /** 非空判断：非 null / 未定义 / 空串 / 空数组 视为非空 */
  notEmpty(args) {
    return !isEmptyValue(args[0])
  },
  /** 为空判断：null / 未定义 / 空串 / 空数组 视为空 */
  isEmpty(args) {
    return isEmptyValue(args[0])
  },
  /** 相等判断（宽松比较，数字与字符串可互通） */
  eq(args) {
    return looseEqual(args[0], args[1])
  },
  /** 多条件「同时成立」才返回 true */
  and(args) {
    return args.length > 0 && args.every((a) => isTruthy(a))
  },
  /** 多条件「任一成立」即返回 true */
  or(args) {
    return args.some((a) => isTruthy(a))
  },
  /** 布尔取反 */
  not(args) {
    return !isTruthy(args[0])
  },
  /** 包含：文本含子串，或数组含元素 */
  contains(args) {
    const hay = args[0]
    const needle = args[1]
    if (Array.isArray(hay)) return hay.includes(needle)
    return String(hay ?? '').includes(String(needle ?? ''))
  },
}

/* ============================== 单元格数据格式 ============================== */

/** 小数位收敛到 [0, 6]，避免 digits 乱填导致 toFixed 抛错 */
function clampDigits(d: unknown): number {
  const n = typeof d === 'number' ? d : Number(d)
  if (!Number.isFinite(n)) return 2
  return Math.min(6, Math.max(0, Math.trunc(n)))
}

/**
 * 按 CellFormat 把原始值格式化为显示字符串。
 * 复用 date/number/currency 的同一套底层工具（formatDate / groupThousands / CURRENCY_SYMBOL），
 * 与 `{{field | date:'...' }}` 过滤器输出完全一致 —— UI 选择即等价于手写对应过滤器。
 * fmt 为 undefined / kind='none'/'text' 时回落默认 stringify（保持原行为）。
 */
export function formatCellValue(raw: unknown, fmt?: CellFormat | null): string {
  if (!fmt || fmt.kind === 'none' || fmt.kind === 'text') return stringifyValue(raw)
  const n = toNum(raw)
  switch (fmt.kind) {
    case 'date':
      return formatDate(raw, fmt.pattern ?? 'YYYY-MM-DD')
    case 'int': {
      const s = n.toFixed(0)
      return fmt.thousands === false ? s : groupThousands(s)
    }
    case 'decimal': {
      const s = n.toFixed(clampDigits(fmt.digits ?? 2))
      return fmt.thousands === false ? s : groupThousands(s)
    }
    case 'currency': {
      const sym = CURRENCY_SYMBOL[String(fmt.code ?? 'CNY').toUpperCase()] ?? ''
      const s = n.toFixed(clampDigits(fmt.digits ?? 2))
      return sym + (fmt.thousands === false ? s : groupThousands(s))
    }
    case 'percent':
      return `${(n * 100).toFixed(clampDigits(fmt.digits ?? 2))}%`
    default:
      return stringifyValue(raw)
  }
}

/* ============================== 插值（{{}}） ============================== */

/**
 * 按单竖线切分过滤器管道，需跳过：
 * - 字符串字面量内的 `|`
 * - 逻辑或 `||`
 */
function splitPipes(src: string): string[] {
  const parts: string[] = []
  let buf = ''
  let quote: string | null = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      buf += ch
      if (ch === '\\' && i + 1 < src.length) {
        buf += src[i + 1]
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '|') {
      if (src[i + 1] === '|') {
        buf += '||'
        i++
        continue
      }
      parts.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  parts.push(buf)
  return parts
}

/** 解析 `filterName:arg1,arg2`，参数走同一套求值器（可用字面量与路径） */
function applyFilter(spec: string, value: unknown, ctx: EvalContext): string {
  const trimmed = spec.trim()
  const colon = trimmed.indexOf(':')
  const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim()
  const filter = FILTERS[name]
  if (!filter) throw new Error(`未知过滤器 "${name}"`)

  let args: unknown[] = []
  if (colon !== -1) {
    const argSrc = trimmed.slice(colon + 1)
    args = splitArgs(argSrc).map((a) => evaluate(a, ctx))
  }
  return filter(value, ...args)
}

/** 按逗号切分过滤器参数，跳过字符串与括号内的逗号 */
function splitArgs(src: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      buf += ch
      if (ch === '\\' && i + 1 < src.length) {
        buf += src[i + 1]
        i++
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf)
  return out
}

/** 值 → 显示字符串的默认规则（数字保留原样，null/undefined 显示空） */
export function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v)
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (v instanceof Date) return formatDate(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export interface InterpolateResult {
  text: string
  /** 求值失败的片段（转 warning，不打断渲染） */
  errors: string[]
}

/**
 * 插值：把 `{{ expr | filter:arg }}` 替换为求值结果（§5.3）。
 * 非 `{{}}` 部分原样保留；单个片段求值失败时输出空串并记录错误。
 */
export function interpolate(template: string, ctx: EvalContext): InterpolateResult {
  const errors: string[] = []
  if (!template.includes('{{')) return { text: template, errors }

  const text = template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, raw: string) => {
    const body = raw.trim()
    if (!body) return ''
    try {
      const [exprSrc, ...filterSpecs] = splitPipes(body)
      let value: unknown = evaluate((exprSrc ?? '').trim(), ctx)
      if (filterSpecs.length === 0) return stringifyValue(value)
      let out = ''
      for (let i = 0; i < filterSpecs.length; i++) {
        out = applyFilter(filterSpecs[i]!, value, ctx)
        value = out
      }
      return out
    } catch (e) {
      errors.push(`{{${body}}}：${e instanceof Error ? e.message : String(e)}`)
      return ''
    }
  })

  return { text, errors }
}

/**
 * 绑定路径取值（§5.2 的 `binding` 字段）。
 * 字段树给出的路径形如 `items[].qty`，其中 `[]` 由解析器忽略，
 * 因此在行上下文中 `items[].qty` 与 `qty` 等价 —— 用户从字段树直接拖入即可用。
 */
export function resolveBinding(path: string, ctx: EvalContext): unknown {
  if (!path) return undefined
  // 行上下文里优先按"去前缀"解释：items[].qty → qty
  if (ctx.row) {
    const tail = path.includes('[].') ? path.slice(path.indexOf('[].') + 3) : path
    try {
      const v = evaluate(tail, { ...ctx })
      if (v !== undefined) return v
    } catch {
      /* 落到全局解析 */
    }
  }
  try {
    return evaluate(path, ctx)
  } catch {
    return undefined
  }
}

/** 测试/调试用：清空 AST 缓存 */
export function __clearExpressionCache(): void {
  astCache.clear()
}
