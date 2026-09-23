/**
 * 数据文件 → 内联数据集（`RenderRequest.datasets`）。
 *
 * 服务端早就有这条通路：`RenderRequest.datasets` → `render()` 里
 * `tpl.datasets.extend(ds)`（`print-server/src/report/mod.rs`），
 * 而且 `sources` 为空也能渲染。缺的只是**把文件变成行**这一步，所以本模块是纯函数，
 * 一行 Rust 都不用动。
 *
 * ## 为什么 CSV / xlsx 要「推断数值」，JSON 不推断
 *
 * 服务端有**两条**数值通路，口径不一样（读源码确认过，不是猜的）：
 *
 * | 通路 | 位置 | 对字符串 "42" 的行为 |
 * | --- | --- | --- |
 * | 聚合求值 `Val::as_num()` | `engine.rs:487` | `s.trim().parse::<f64>()` → **当 42** |
 * | 显示 / 导出 `display()` | `engine.rs:3545` | `(s.clone(), None)` → **`raw_number: None`** |
 *
 * 而 `xlsx.rs:623` 是 `if let Some(n) = cell.raw_number { write_number } else { write_string }`。
 * 于是**字符串数字**的后果是：**求和是对的，导出却是文本格**（不右对齐、不进 Excel 算术、
 * 不按数值排序）。预览和合计都看不出来 —— 正是本项目最怕的那类静默。
 *
 * 所以 CSV / xlsx 这两个**无类型**来源必须把数字转成真正的数字。
 *
 * 但转换要**保守**，判据是**往返一致**：`String(Number(t)) === t` 才转。这条规则一次挡掉
 * 一堆会改坏数据的情况：
 *
 * | 原串 | 转不转 | 为什么 |
 * | --- | --- | --- |
 * | `42` / `-5` / `3.5` | 转 | 无损 |
 * | `13800138000` | 转 | f64 精确（< 2^53），往返一致 |
 * | `007` | **不转** | 转了就丢前导零（工号 / 邮编） |
 * | `3.50` | **不转** | 转了就显示成 `3.5`，改掉了作者的写法 |
 * | `+86` | **不转** | 转了就丢 `+`（手机号） |
 * | `12345678901234567890` | **不转** | f64 会丢精度，往返不一致 |
 * | `1e5` / `.5` / `1.` | **不转** | 正则就不认（只认普通十进制） |
 * | （空） | → `null` | 空值不是 0，聚合时会跳过 |
 *
 * **JSON 不推断**：JSON 自带类型，作者写 `"42"` 就是想要字符串。无类型来源才需要猜，
 * 有类型来源去猜反而是越权。
 *
 * ## 与 Rust 侧的同构
 *
 * `DataRow` = `BTreeMap<String, JsonValue>`（Rust）/ `Record<string, unknown>`（这边）。
 * 字段缺失与显式 `null` 在 Rust 侧都是 `None`，但**本模块一律补齐成矩形**
 * （缺的填 `null`），因为导出侧要靠列名清单决定列宽和表头。
 */

/** 一行数据。与 Rust 的 `DataRow = BTreeMap<String, JsonValue>` 同构 */
export type DataRow = Record<string, unknown>

/** 解析结果：列名（**按首次出现顺序**）+ 行 */
export interface ParsedTable {
  columns: string[]
  rows: DataRow[]
}

/** 解析失败一律抛这个，`message` 直接给用户看 */
export class DatasetParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatasetParseError'
  }
}

/**
 * 无类型文本 → 值。判据见文件头注释：**往返一致才转数字**。
 *
 * 注意非数字时返回**原串**（不 trim）—— trim 只用于判断，不用于改数据。
 */
export function inferScalar(raw: string): unknown {
  const t = raw.trim()
  if (t === '') return null
  // 只认普通十进制：`-?digits(.digits)?`。
  // 刻意不认 `1e5` / `.5` / `1.` / `1,234` —— 认了就得替作者决定语义。
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t)
    // `String(n) === t` 就是「往返一致」：丢了前导零 / 尾随零 / 精度的，都不转
    if (Number.isFinite(n) && String(n) === t) return n
  }
  return raw
}

/**
 * 去重列名。
 *
 * **必须做**：Rust 侧是 `BTreeMap`，同名列会**互相覆盖**——重复表头（比如两列都叫「金额」）
 * 会让后一列静默吃掉前一列。加后缀让两列都活下来。
 */
export function dedupeColumns(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((raw, i) => {
    // 空表头给个位置名，否则列名是空串、UI 上没法指认
    const base = raw.trim() === '' ? `列${i + 1}` : raw.trim()
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}_${n + 1}`
  })
}

/** 在引号外数某个字符出现次数（用来猜分隔符） */
function countOutsideQuotes(line: string, ch: string): number {
  let n = 0
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQ && line[i + 1] === '"') i++
      else inQ = !inQ
    } else if (!inQ && c === ch) n++
  }
  return n
}

/**
 * 猜分隔符：在 `,` `;` `\t` `|` 里取第一行**引号外**出现最多的。
 *
 * 猜错的后果是**整行被当成一列**（而不是静默出错），UI 上列名清单一眼能看出来，
 * 所以这里猜是安全的；但不猜的话，欧洲区 Excel 导出的 `;` 分隔 CSV 会全军覆没。
 */
export function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== '') ?? ''
  let best = ','
  let bestN = 0
  for (const ch of [',', ';', '\t', '|']) {
    const n = countOutsideQuotes(firstLine, ch)
    if (n > bestN) {
      best = ch
      bestN = n
    }
  }
  return best
}

/**
 * 按 RFC 4180 把一个 CSV 切成「行 × 格」矩阵（**不解释表头、不推断类型**）。
 *
 * 处理：BOM、引号内的分隔符 / 换行、`""` 转义、CRLF / LF / CR 三种行尾。
 * 单独抽出来是因为「切格子」和「认表头 / 推类型」是两件事，混在一起没法单测边界。
 */
export function splitCsv(text: string, delimiter?: string): string[][] {
  // 开头可能是 UTF-8 BOM（Excel 导出必带）—— 留着会让第一个列名变成 `\uFEFF名称`
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const d = delimiter ?? sniffDelimiter(src)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < src.length) {
    const c = src[i]
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQ = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQ = true
      i++
      continue
    }
    if (c === d) {
      endField()
      i++
      continue
    }
    if (c === '\r' || c === '\n') {
      // CRLF 算一个行尾
      if (c === '\r' && src[i + 1] === '\n') i++
      endRow()
      i++
      continue
    }
    field += c
    i++
  }
  // 最后一行没有行尾符时补上；纯尾随换行不产生空行
  if (field !== '' || row.length > 0) endRow()

  return rows
}

/** 矩阵 + 表头行号 → 矩形数据集。CSV / xlsx 共用 */
export function rowsFromMatrix(matrix: unknown[][], headerRow = 0): ParsedTable {
  if (matrix.length === 0) throw new DatasetParseError('文件里没有任何行')
  if (headerRow < 0) throw new DatasetParseError('表头行号不能是负数')
  // 用 `=== undefined` 判越界，而不是 `headerRow >= matrix.length`：
  // `noUncheckedIndexedAccess` 下 `matrix[headerRow]` 本来就是 `unknown[] | undefined`，
  // 顺手把这个判据用掉，下面就不用写 `!` 了。
  const headerCells = matrix[headerRow]
  if (headerCells === undefined) {
    throw new DatasetParseError(`表头行号 ${headerRow + 1} 超出范围（共 ${matrix.length} 行）`)
  }

  const rawHeader = headerCells.map((c) => (c == null ? '' : String(c)))
  // ⚠️ **整行表头都空 → 报错**，不能顺手按位置命名成 `列1`/`列2`。
  // 一个表头整行空白的文件，多半**根本没有表头行**；此时照样把第一行当表头，
  // 就会**吃掉第一条数据**（列名变成 `1` / `2` 这种），而界面看着一切正常 ——
  // 少一行数据是看不出来的。这条是**可判定**的，所以报错而不是猜。
  // 只有**部分**列为空时才按位置命名（`列2`），那种情况列名是有意义的。
  if (rawHeader.every((h) => h.trim() === '')) {
    throw new DatasetParseError('表头整行都是空的 —— 这个文件可能没有表头行，请补一行列名')
  }
  const columns = dedupeColumns(rawHeader)
  const width = columns.length

  const body = matrix.slice(headerRow + 1)
  const rows: DataRow[] = []
  // `entries()` 而不是 `body[r]`：后者在 `noUncheckedIndexedAccess` 下是
  // `unknown[] | undefined`，还得再补一次判空
  for (const [r, cells] of body.entries()) {
    // 整行都空 → 跳过（Excel / CSV 常见的尾随空行）
    if (cells.every((c) => c == null || String(c).trim() === '')) continue
    // ⚠️ **列数不匹配要报错，不能静默截断或补空**：
    // 多出来的值丢掉 = 用户看不见数据没了；少的值补空 = 分不清「本来就没有」和「解析错了」。
    if (cells.length !== width) {
      throw new DatasetParseError(
        `第 ${headerRow + r + 2} 行有 ${cells.length} 格，表头是 ${width} 列 —— 列数不一致（多余的分隔符？）`,
      )
    }
    const row: DataRow = {}
    // 遍历 `columns` 取列名，而不是 `columns[c]` —— 后者是 `string | undefined`
    for (const [c, col] of columns.entries()) {
      const v = cells[c]
      row[col] = typeof v === 'string' ? inferScalar(v) : (v ?? null)
    }
    rows.push(row)
  }
  if (rows.length === 0) throw new DatasetParseError('只有表头，没有数据行')
  return { columns, rows }
}

/** CSV 文本 → 数据集（表头固定第一行） */
export function parseCsv(text: string): ParsedTable {
  const matrix = splitCsv(text)
  // `splitCsv` 保证「纯尾随换行」不产生空行，但空文件会给出一行空串
  const nonEmpty = matrix.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonEmpty.length === 0) throw new DatasetParseError('文件是空的')
  return rowsFromMatrix(nonEmpty as unknown[][], 0)
}

/** 从一个对象里挑出那个「装着行的数组」 */
function pickArrayFromObject(obj: Record<string, unknown>): { key: string; arr: unknown[] } {
  const arrKeys: string[] = []
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k])) arrKeys.push(k)
  }
  if (arrKeys.length === 0) {
    throw new DatasetParseError(
      `JSON 对象里没有数组字段（找到的字段：${Object.keys(obj).join(' / ') || '无'}）—— 需要一个行数组`,
    )
  }
  if (arrKeys.length > 1) {
    // 多个候选就**报错让人选**，不猜。猜错的后果是渲染出一张别的表，还看不出错。
    throw new DatasetParseError(
      `JSON 对象里有多个数组字段（${arrKeys.join(' / ')}）—— 分不清该用哪个，请直接给数组`,
    )
  }
  // 到这里 `arrKeys` 恰好 1 个元素。用循环取出而不是 `arrKeys[0]`，
  // 是为了避开 `noUncheckedIndexedAccess` 下的 `string | undefined`。
  for (const key of arrKeys) {
    return { key, arr: obj[key] as unknown[] }
  }
  // 不可达：上面已排除「0 个」和「多个」
  throw new DatasetParseError('内部错误：数组字段取不到')
}

/**
 * JSON 文本 → 数据集。
 *
 * **不做数值推断**（理由见文件头）：JSON 自带类型，作者写 `"42"` 就是要字符串。
 *
 * 接受两种形状：
 * 1. `[{...}, {...}]` —— 对象数组
 * 2. `{ 任意字段: [{...}] }` —— 只有一个数组字段的对象（取它）
 *
 * 也接受**标量数组** `[1, 2, 3]` → 单列 `值`（贴一个 id 列表进来是常见用法）。
 */
export function parseJsonRows(text: string): ParsedTable {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new DatasetParseError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }

  let arr: unknown[]
  if (Array.isArray(data)) {
    arr = data
  } else if (data !== null && typeof data === 'object') {
    arr = pickArrayFromObject(data as Record<string, unknown>).arr
  } else {
    throw new DatasetParseError('JSON 顶层既不是数组也不是对象 —— 需要一个行数组')
  }

  if (arr.length === 0) throw new DatasetParseError('JSON 里的数组是空的，没有数据行')

  // 标量数组 → 单列
  if (arr.every((v) => v === null || typeof v !== 'object')) {
    return { columns: ['值'], rows: arr.map((v) => ({ 值: v ?? null })) }
  }
  const bad = arr.findIndex((v) => v === null || typeof v !== 'object' || Array.isArray(v))
  if (bad >= 0) {
    throw new DatasetParseError(
      `第 ${bad + 1} 个元素不是对象（是${Array.isArray(arr[bad]) ? '数组' : typeof arr[bad]}）—— 行必须是对象`,
    )
  }

  // 列名 = 所有行键的并集，**按首次出现顺序**（不是排序，作者看文件时的顺序更直觉）
  const columns: string[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    for (const k of Object.keys(item as Record<string, unknown>)) {
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
  }
  const rows = arr.map((item) => {
    const src = item as Record<string, unknown>
    const row: DataRow = {}
    // 补齐成矩形：缺的键填 null，导出侧要靠列名清单定表头
    for (const c of columns) row[c] = c in src ? src[c] : null
    return row
  })
  return { columns, rows }
}

/**
 * 按文件名后缀选解析器。**认不出后缀就报错**，不猜格式 ——
 * 猜错会渲染出一张结构不对的表，而界面看着是「成功」的。
 */
export function parseDatasetFile(fileName: string, content: string): ParsedTable {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    // .tsv 按 Tab 切，别让 sniff 去猜（内容里可能正好有逗号）
    return ext === 'tsv' ? parseCsvWithDelimiter(content, '\t') : parseCsv(content)
  }
  if (ext === 'json') return parseJsonRows(content)
  throw new DatasetParseError(`不认识的扩展名 .${ext} —— 目前支持 .csv / .tsv / .json / .xlsx`)
}

/** `parseCsv` 的显式分隔符版本（.tsv 用） */
export function parseCsvWithDelimiter(text: string, delimiter: string): ParsedTable {
  const matrix = splitCsv(text, delimiter)
  const nonEmpty = matrix.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonEmpty.length === 0) throw new DatasetParseError('文件是空的')
  return rowsFromMatrix(nonEmpty as unknown[][], 0)
}
