/**
 * 数据导入解析 —— 支持 CSV / JSON / Excel(xlsx, xls)
 *
 * 纯前端、零后端。CSV 走 csv.ts 零依赖解析；Excel 用 xlsx 动态 import（自动拆成按需 chunk）。
 *
 * 约定（与导入弹窗一致）：
 * - 导入文件的第一行作为列标题（表名取自文件名）；其余每行作为一条记录。
 * - 解析结果交给 DataImportModal 做「预览 / 列改名 / 删列 / 删行」，确认后才落为
 *   画布上的「内嵌数据表格」（TableControl.data），从而与 dataSource 字段绑定彻底解耦。
 */
import { csvToRecords } from './csv'
import type { ImportColumn } from '@/types/data-import'

/** 转口导出：ImportColumn 已下沉到 types 层（排版引擎要用，不能反向依赖 design） */
export type { ImportColumn }

export interface ParsedData {
  sourceName: string
  columns: ImportColumn[]
  rows: Array<Record<string, unknown>>
}

/** 把任意 JSON 解析结果规整为记录数组（兼容对象数组 / {records|data|items} 信封） */
function normalizeJsonRecords(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) {
    return input.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const arr = obj.records ?? obj.data ?? obj.items
    if (Array.isArray(arr)) {
      return arr.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]
    }
  }
  return []
}

/** 从记录数组推导列（取所有行的 key 并集，保留首次出现顺序；空键名补 col{序号}） */
function deriveColumns(rows: Array<Record<string, unknown>>): ImportColumn[] {
  const seen = new Map<string, string>()
  for (const row of rows) {
    for (const rawKey of Object.keys(row)) {
      const key = rawKey.trim() || `col${seen.size + 1}`
      if (!seen.has(key)) seen.set(key, key)
    }
  }
  return [...seen.values()].map((key) => ({ key, title: key }))
}

export async function parseDataFile(file: File): Promise<ParsedData> {
  const name = file.name
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const buf = await file.arrayBuffer()
  let rows: Array<Record<string, unknown>>

  if (ext === 'csv') {
    rows = csvToRecords(new TextDecoder('utf-8').decode(buf))
  } else if (ext === 'json') {
    rows = normalizeJsonRecords(JSON.parse(new TextDecoder('utf-8').decode(buf)))
  } else if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheetName = wb.SheetNames[0]
    const sheet = sheetName ? wb.Sheets[sheetName] : undefined
    if (!sheet) throw new Error('Excel 文件中没有可读取的工作表')
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }) as Record<string, unknown>[]
  } else {
    throw new Error(`不支持的文件类型：.${ext}（仅支持 .csv / .json / .xlsx / .xls）`)
  }

  if (rows.length === 0) throw new Error('文件中没有可解析的数据行')

  return { sourceName: name, columns: deriveColumns(rows), rows }
}
