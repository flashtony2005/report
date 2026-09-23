import { describe, it, expect } from 'vitest'
import {
  DatasetParseError,
  dedupeColumns,
  extensionForContentType,
  fileExtension,
  fileNameFromUrl,
  inferScalar,
  isKnownExtension,
  parseCsv,
  parseCsvWithDelimiter,
  parseDatasetFile,
  parseDatasetFileAsync,
  parseJsonRows,
  rowsFromMatrix,
  sniffDelimiter,
  splitCsv,
} from './dataset-import'

/**
 * `inferScalar` 的判据是**往返一致**（`String(Number(t)) === t`）。
 *
 * 下面两张表是**故意**逐个钉的：每一条都对应一个「转了就把数据改坏了」的场景。
 * 改判据时这些必须一起改 —— 它们不是「顺手加的边界」，是这套规则的**全部理由**。
 */
describe('inferScalar —— 往返一致才转数字', () => {
  const NUMERIC: Array<[string, number]> = [
    ['42', 42],
    ['-5', -5],
    ['0', 0],
    ['3.5', 3.5],
    ['13800138000', 13800138000],
    ['  42  ', 42], // 判断时 trim，所以能转
  ]

  it('这些**必须**转成数字（否则导出成文本格）', () => {
    for (const [raw, want] of NUMERIC) {
      expect(inferScalar(raw), `${raw} 应当转成 ${want}`).toBe(want)
    }
  })

  const KEEP_STRING: Array<[string, string]> = [
    ['007', '转了会丢前导零（工号 / 邮编）'],
    ['3.50', '转了会显示成 3.5，改掉作者写法'],
    ['+86', '转了会丢 +（手机号）'],
    ['12345678901234567890', 'f64 会丢精度'],
    ['1e5', '科学计数法不在判据里'],
    ['.5', '没写前导零'],
    ['1.', '没写小数位'],
    ['1,234', '千分位'],
    ['abc', '不是数字'],
    ['2026-09-23', '日期不是数字'],
  ]

  it('这些**必须**保持字符串（每一格都对应一种数据被改坏的场景）', () => {
    for (const [raw, why] of KEEP_STRING) {
      expect(inferScalar(raw), `${raw} 不该转：${why}`).toBe(raw)
    }
  })

  it('空串 / 纯空白 → null（空值不是 0，聚合时会跳过）', () => {
    expect(inferScalar('')).toBeNull()
    expect(inferScalar('   ')).toBeNull()
  })

  it('非数字时返回原串**不 trim** —— trim 只用于判断，不改数据', () => {
    expect(inferScalar('  abc  ')).toBe('  abc  ')
  })
})

describe('splitCsv —— RFC 4180 切格', () => {
  it('引号里的分隔符不算分隔符', () => {
    expect(splitCsv('a,b\n"x,y",z')).toEqual([
      ['a', 'b'],
      ['x,y', 'z'],
    ])
  })

  it('引号里的换行不算换行', () => {
    expect(splitCsv('a,b\n"line1\nline2",z')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'z'],
    ])
  })

  it('`""` 是一个字面引号', () => {
    expect(splitCsv('a\n"he said ""hi"""')).toEqual([['a'], ['he said "hi"']])
  })

  it('三种行尾都认（CRLF / LF / CR）', () => {
    expect(splitCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(splitCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(splitCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('CRLF 只算**一个**行尾（不算出一行空的）', () => {
    expect(splitCsv('a\r\nb')).toEqual([['a'], ['b']])
  })

  it('尾随换行不产生空行', () => {
    expect(splitCsv('a,b\n')).toEqual([['a', 'b']])
  })

  it('开头 BOM 被剥掉（否则第一个列名会带 \\uFEFF）', () => {
    expect(splitCsv('\uFEFFa,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('sniffDelimiter —— 猜分隔符', () => {
  it('逗号', () => expect(sniffDelimiter('a,b,c')).toBe(','))
  it('分号（欧洲区 Excel 导出）', () => expect(sniffDelimiter('a;b;c')).toBe(';'))
  it('Tab', () => expect(sniffDelimiter('a\tb\tc')).toBe('\t'))
  it('管道符', () => expect(sniffDelimiter('a|b|c')).toBe('|'))
  it('单列（没有分隔符）回落成逗号', () => expect(sniffDelimiter('abc')).toBe(','))
  it('引号里的分隔符不参与计数', () => {
    // 第一个字段里有两个分号，真实分隔符是逗号 → 必须猜逗号
    expect(sniffDelimiter('"a;b;c",d')).toBe(',')
  })
})

describe('dedupeColumns', () => {
  it('重名加后缀 —— 否则 BTreeMap 会**互相覆盖**，后一列静默吃掉前一列', () => {
    expect(dedupeColumns(['金额', '金额', '金额'])).toEqual(['金额', '金额_2', '金额_3'])
  })

  it('空表头给位置名，不然列名是空串没法指认', () => {
    expect(dedupeColumns(['a', '', 'c'])).toEqual(['a', '列2', 'c'])
  })

  it('表头两侧空白被去掉', () => {
    expect(dedupeColumns([' a ', 'b'])).toEqual(['a', 'b'])
  })
})

describe('rowsFromMatrix', () => {
  it('正常矩阵：表头 + 数据，并推断数值', () => {
    const t = rowsFromMatrix([
      ['城市', '金额'],
      ['上海', '100'],
    ])
    expect(t.columns).toEqual(['城市', '金额'])
    expect(t.rows).toEqual([{ 城市: '上海', 金额: 100 }])
  })

  it('整行都空的行被跳过（Excel 常见的尾随空行）', () => {
    const t = rowsFromMatrix([['a'], ['1'], [''], ['   '], ['2']])
    expect(t.rows.map((r) => r.a)).toEqual([1, 2])
  })

  it('⚠️ 列数不一致**报错**，不静默截断也不静默补空', () => {
    const run = () =>
      rowsFromMatrix([
        ['a', 'b'],
        ['1', '2', '3'],
      ])
    expect(run).toThrow(DatasetParseError)
    expect(run).toThrow(/第 2 行有 3 格，表头是 2 列/)
  })

  it('只有表头 → 报错', () => {
    expect(() => rowsFromMatrix([['a', 'b']])).toThrow(/只有表头/)
  })

  it('空矩阵 → 报错', () => {
    expect(() => rowsFromMatrix([])).toThrow(/没有任何行/)
  })

  it('表头行号越界 → 报错', () => {
    expect(() => rowsFromMatrix([['a']], 5)).toThrow(/超出范围/)
  })

  it('⚠️ 表头整行空白 → 报错（多半是文件根本没有表头行）', () => {
    // 若这里不报错、按位置命名成 列1/列2，第一行数据就会被当成表头**吃掉** ——
    // 少一行数据，而界面看着一切正常。
    expect(() => rowsFromMatrix([['', '']])).toThrow(/表头整行都是空的/)
    expect(() => rowsFromMatrix([['   ', '\t']])).toThrow(/表头整行都是空的/)
  })

  it('列名是数字时**无法**判定它是不是表头 —— 照常处理（本模块只拦「整行空白」）', () => {
    // 这条钉的是**能力边界**，不是「我们做对了」：一份无表头的 `1,2 / 3,4` 会被
    // 当成「表头是 1、2」，于是第一条数据被吃掉。数字当列名在语法上是合法的，
    // 判定不了，所以不猜。要拦住它只能靠作者补一行列名。
    const t = rowsFromMatrix([
      ['1', '2'],
      ['3', '4'],
    ])
    expect(t.columns).toEqual(['1', '2'])
    expect(t.rows).toEqual([{ '1': 3, '2': 4 }])
  })
})

describe('parseCsv', () => {
  it('端到端：BOM + 引号里的逗号 + 数值推断', () => {
    const t = parseCsv('\uFEFF城市,金额\n"上海, 浦东",100\n北京,3.50')
    expect(t.columns).toEqual(['城市', '金额'])
    expect(t.rows).toEqual([
      { 城市: '上海, 浦东', 金额: 100 },
      // 3.50 **不转**（往返不一致）→ 字符串。这正是「保守」的意义：保住作者的写法
      { 城市: '北京', 金额: '3.50' },
    ])
  })

  it('分号分隔的 CSV 也能解析（sniff 猜出来）', () => {
    expect(parseCsv('a;b\n1;2').columns).toEqual(['a', 'b'])
  })

  it('空文件 → 报错', () => {
    expect(() => parseCsv('')).toThrow(/文件是空的/)
    expect(() => parseCsv('\n\n')).toThrow(/文件是空的/)
  })
})

describe('parseJsonRows', () => {
  it('对象数组', () => {
    const t = parseJsonRows('[{"a":1,"b":"x"},{"a":2,"b":"y"}]')
    expect(t.columns).toEqual(['a', 'b'])
    expect(t.rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ])
  })

  it('列名取所有行的**并集**，按首次出现顺序；缺的补 null', () => {
    const t = parseJsonRows('[{"a":1},{"b":2},{"a":3}]')
    expect(t.columns).toEqual(['a', 'b'])
    expect(t.rows).toEqual([
      { a: 1, b: null },
      { a: null, b: 2 },
      { a: 3, b: null },
    ])
  })

  it('**不推断数值**：JSON 里写成字符串就是字符串', () => {
    const t = parseJsonRows('[{"a":"42"}]')
    expect(t.rows[0]).toEqual({ a: '42' })
  })

  it('单个数组字段的对象：取那个数组', () => {
    expect(parseJsonRows('{"data":[{"a":1}]}').rows).toEqual([{ a: 1 }])
  })

  it('⚠️ 多个数组字段 → 报错让人选，不猜', () => {
    expect(() => parseJsonRows('{"a":[{"x":1}],"b":[{"y":2}]}')).toThrow(/多个数组字段/)
  })

  it('对象里没有数组 → 报错并列出实际字段', () => {
    expect(() => parseJsonRows('{"a":1,"b":2}')).toThrow(/没有数组字段.*a \/ b/)
  })

  it('标量数组 → 单列「值」', () => {
    const t = parseJsonRows('[1,2,3]')
    expect(t.columns).toEqual(['值'])
    expect(t.rows).toEqual([{ 值: 1 }, { 值: 2 }, { 值: 3 }])
  })

  it('数组里混了非对象 → 报错并指出第几个', () => {
    expect(() => parseJsonRows('[{"a":1},5]')).toThrow(/第 2 个元素不是对象/)
  })

  it('顶层既不是数组也不是对象 → 报错', () => {
    expect(() => parseJsonRows('42')).toThrow(/既不是数组也不是对象/)
  })

  it('非法 JSON → 报错', () => {
    expect(() => parseJsonRows('{oops')).toThrow(/JSON 解析失败/)
  })

  it('空数组 → 报错', () => {
    expect(() => parseJsonRows('[]')).toThrow(/数组是空的/)
  })
})

describe('parseDatasetFile —— 按后缀分发', () => {
  it('.csv 走 CSV', () => {
    expect(parseDatasetFile('a.csv', 'x\n1').rows).toEqual([{ x: 1 }])
  })

  it('.json 走 JSON', () => {
    expect(parseDatasetFile('a.json', '[{"x":1}]').rows).toEqual([{ x: 1 }])
  })

  it('.tsv 按 Tab 切，不让 sniff 去猜', () => {
    // 内容里有逗号，若走 sniff 会猜逗号 → 整行一列
    const t = parseDatasetFile('a.tsv', 'a,b\tc\n1,2\t3')
    expect(t.columns).toEqual(['a,b', 'c'])
  })

  it('⚠️ 不认识的扩展名 → 报错，不猜格式', () => {
    expect(() => parseDatasetFile('a.pdf', 'x')).toThrow(/不认识的扩展名 \.pdf/)
  })

  it('大小写不敏感', () => {
    expect(parseDatasetFile('A.CSV', 'x\n1').rows).toEqual([{ x: 1 }])
  })
})

describe('parseCsvWithDelimiter', () => {
  it('显式分隔符优先于 sniff', () => {
    expect(parseCsvWithDelimiter('a;b\n1;2', ';').columns).toEqual(['a', 'b'])
  })
})

/**
 * `Date` 格的处理（xlsx 走 `raw: true` + `cellDates: true` 时会拿到 `Date`）。
 *
 * 判据是**UTC 零点输出纯日期**，真带时间的输出完整 ISO。
 * 直接 `JSON.stringify(Date)` 会得到 `2024-01-02T00:00:00.000Z` ——
 * 一列日期全是这种带时分秒的串，报表里没法看，而时分秒通常**不是作者写的**，
 * 是 Excel 序列号换算出来的噪声。
 */
describe('rowsFromMatrix —— Date 格', () => {
  it('纯日期格（UTC 零点）→ `YYYY-MM-DD`', () => {
    const t = rowsFromMatrix([['日期'], [new Date('2024-01-02T00:00:00.000Z')]])
    expect(t.rows).toEqual([{ 日期: '2024-01-02' }])
  })

  it('真带时间的格 → 完整 ISO（不截断，信息不丢）', () => {
    const t = rowsFromMatrix([['时刻'], [new Date('2024-01-02T08:30:00.000Z')]])
    expect(t.rows).toEqual([{ 时刻: '2024-01-02T08:30:00.000Z' }])
  })

  it('`null` 格仍是 `null`，不是字符串 `"null"`', () => {
    const t = rowsFromMatrix([['a', 'b'], [null, 1]])
    expect(t.rows).toEqual([{ a: null, b: 1 }])
  })
})

/**
 * `parseDatasetFileAsync` —— 异步入口，`.xlsx` / `.xls` 走 SheetJS，其余走同步解析器。
 *
 * 这里只测**文本那几条**（csv / json / txt）：`.xlsx` 要真的 SheetJS 包，
 * 而 `ts-test.sh` 的临时目录里没有 `node_modules`（只有借来的 vitest），
 * 所以 xlsx 那条在 `designer-react` 的 vitest 里测 ——
 * 见 `designer-react/src/report/dataset-import-xlsx.spec.ts`。
 */
describe('parseDatasetFileAsync —— 文本来源', () => {
  it('.csv 走同步解析器（含数值推断）', async () => {
    const t = await parseDatasetFileAsync(new File(['城市,金额\n上海,1234.5'], 'a.csv'))
    expect(t.columns).toEqual(['城市', '金额'])
    expect(t.rows).toEqual([{ 城市: '上海', 金额: 1234.5 }])
  })

  it('.json 不做数值推断（JSON 自带类型）', async () => {
    const t = await parseDatasetFileAsync(new File(['[{"金额":"1234.5"}]'], 'a.json'))
    // 作者写的就是字符串 → 保持字符串（与 CSV 相反）
    expect(t.rows).toEqual([{ 金额: '1234.5' }])
  })

  it('.txt 当 CSV 处理', async () => {
    const t = await parseDatasetFileAsync(new File(['x\n1'], 'a.txt'))
    expect(t.rows).toEqual([{ x: 1 }])
  })

  it('⚠️ 解析失败要抛，不返回空表', async () => {
    await expect(parseDatasetFileAsync(new File(['[1,2'], 'a.json'))).rejects.toThrow(
      DatasetParseError,
    )
  })

  it('⚠️ 不认识的扩展名 → 报错（且提示 xlsx 要走异步入口）', async () => {
    await expect(parseDatasetFileAsync(new File(['x'], 'a.pdf'))).rejects.toThrow(
      /parseDatasetFileAsync/,
    )
  })
})

describe('fileExtension', () => {
  it('取最后一段后缀并小写化', () => {
    expect(fileExtension('a/b/A.CSV')).toBe('csv')
  })

  it('查询串 / 锚点不算后缀', () => {
    expect(fileExtension('sales.csv?token=1')).toBe('csv')
    expect(fileExtension('sales.json#top')).toBe('json')
  })

  it('没有后缀 → 空串', () => {
    expect(fileExtension('/api/sales')).toBe('')
  })

  it('⚠️ 目录名里的点不算后缀（`/api/v1.0/data` 没有后缀）', () => {
    // 不先取 basename 的话这里会得出 `0/data` —— 一个「看着像后缀、其实不是」的
    // 返回值，迟早会被别处直接当后缀用上。
    expect(fileExtension('/api/v1.0/data')).toBe('')
    expect(isKnownExtension(fileExtension('/api/v1.0/data'))).toBe(false)
  })
})

describe('extensionForContentType', () => {
  const CASES: Array<[string, string]> = [
    ['application/json', 'json'],
    ['application/json; charset=utf-8', 'json'],
    ['text/json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['text/csv', 'csv'],
    ['text/csv;charset=gbk', 'csv'],
    ['text/tab-separated-values', 'tsv'],
    ['text/plain', 'txt'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.ms-excel', 'xls'],
  ]
  it('认得的 mime 都要认出来（大小写 / 参数不影响）', () => {
    for (const [mime, want] of CASES) {
      expect(extensionForContentType(mime), `${mime} → ${want}`).toBe(want)
    }
  })

  it('⚠️ 认不出返回 null，**不猜**', () => {
    // octet-stream 等于「什么都没说」，猜它就是在替作者决定格式
    for (const mime of ['application/octet-stream', 'image/png', '', '  ', 'text/html']) {
      expect(extensionForContentType(mime), `${mime} 不该认出`).toBeNull()
    }
  })
})

describe('fileNameFromUrl', () => {
  it('取最后一段，去掉查询串与锚点', () => {
    expect(fileNameFromUrl('http://a/b/sales.csv?x=1#y')).toBe('sales.csv')
  })

  it('百分号编码要还原', () => {
    expect(fileNameFromUrl('http://a/%E9%94%80%E5%94%AE.csv')).toBe('销售.csv')
  })

  it('取不到就给中性名 data（后续靠 Content-Type 补后缀）', () => {
    expect(fileNameFromUrl('http://a/')).toBe('data')
    expect(fileNameFromUrl('http://a')).toBe('data')
  })

  it('⚠️ 畸形百分号编码不能抛（一个拼错的 URL 不该崩在解析文件名这步）', () => {
    expect(fileNameFromUrl('http://a/%E0%A4%A.csv')).toBe('%E0%A4%A.csv')
  })
})
