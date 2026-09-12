/**
 * CSV 解析 —— 纯前端、零依赖（可变数据打印的本地数据源导入用）
 *
 * 支持：
 * - 带引号字段（"a,b" 内的逗号保留）
 * - 引号转义（"" 表示一个 "）
 * - 引号内换行（整行跨多行，常见于地址字段）
 * - CRLF / LF / 老式 CR 换行
 * - UTF-8 BOM 自动剥离
 *
 * 设计取舍：CSV 单元格一律作为字符串返回，不擅自做数字/日期强转。
 * 原因：手机号、邮编、订单号等带前导零的字段一旦被转成数字会丢信息；
 * 需要数值格式时，渲染期的 binding.format（int/decimal/currency）会自行把字符串转成数字。
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const n = src.length
  let i = 0

  while (i < n) {
    const c = src[i]!

    // 提交当前行（跳过完全空白行：仅有单个空字段）
    const pushRow = (): void => {
      row.push(field)
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      field = ''
    }

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }

    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\r') {
      pushRow()
      if (src[i + 1] === '\n') i += 2
      else i++
      continue
    }
    if (c === '\n') {
      pushRow()
      i++
      continue
    }
    field += c
    i++
  }

  // 收尾：还有未提交的字段/行
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
  }
  return rows
}

/**
 * CSV 文本 → 记录数组（首行作表头，其余每行一个对象）。
 * 空行（仅一个空单元格）自动跳过。表头空列名补齐为 col{序号}。
 */
export function csvToRecords(text: string): Record<string, unknown>[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []

  const header = rows[0]!.map((h, idx) => h.trim() || `col${idx + 1}`)
  const records: Record<string, unknown>[] = []

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!
    // 整行只有一个空单元格 → 视为空行跳过
    if (cells.length === 1 && cells[0]!.trim() === '') continue

    const obj: Record<string, unknown> = {}
    for (let c = 0; c < header.length; c++) {
      obj[header[c]!] = cells[c] ?? ''
    }
    records.push(obj)
  }
  return records
}
