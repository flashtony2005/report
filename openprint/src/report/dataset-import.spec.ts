import { describe, it, expect } from 'vitest'
import {
  DatasetParseError,
  dedupeColumns,
  inferScalar,
  parseCsv,
  parseCsvWithDelimiter,
  parseDatasetFile,
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
