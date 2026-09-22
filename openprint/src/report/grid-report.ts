/**
 * 网格报表的纯函数层（无 DOM / 无 Univer 依赖，便于单测）
 *
 * 职责：
 * - 由「分组字段 + 数值字段」或「画布表格列」生成 ReportTemplate（服务端 xpt 的 JSON 等价物）
 * - 把服务端展开结果转成 Univer 工作簿数据
 *
 * 真正的展开/分组/汇总算法在 print-server（Rust）里，前端只做描述与展示。
 */

/** 水平对齐（与 Rust `HAlign` 同名同值） */
export type HAlign = 'left' | 'center' | 'right'

/** 垂直对齐（与 Rust `VAlign` 同名同值） */
export type VAlign = 'top' | 'middle' | 'bottom'

/**
 * 作者定义的格子样式 —— **不是**设计器那套语义高亮。
 *
 * 设计器网格里的颜色标的是「这格什么角色」（扩展 / 字段 / 表达式…），
 * 不会导出；这里设的才会真的写进 xlsx。
 *
 * 刻意**不含边框**：Univer 的 `bd` 实测完全不渲染，设了在设计器里看不见，
 * 那就成了「设了没反应」的静默失败。宁可不给，也不给一个看不见的开关。
 *
 * 颜色只认 `#RRGGBB`；写成 `red` / `rgb(...)` 会在导出时**报错**（不静默丢弃）。
 */
export interface CellStyle {
  bold?: boolean | null
  italic?: boolean | null
  /** 字号，单位 pt */
  font_size?: number | null
  /** 字色，`#RRGGBB` */
  color?: string | null
  /** 底色，`#RRGGBB` */
  bg?: string | null
  h_align?: HAlign | null
  v_align?: VAlign | null
}

/**
 * 图片格：这格不出文本，出图片（logo / 产品图 / 二维码 / 客户端栅格化好的图表）。
 *
 * ## 为什么只收 data URI
 *
 * `src` 只认 `data:image/...;base64,...`（自包含），**故意不做文件路径** ——
 * 服务端按模板里的字符串读本地文件，等于把模板变成一个任意文件读取原语，
 * 而模板是可以被导入 / 分享的。少一条通路少一类洞。
 *
 * ## 为什么客户端栅格化是对的
 *
 * 图表是前端画的（chartkit）。与其在 Rust 里再实现一遍折线 / 柱状，
 * 不如让客户端把图表转成 PNG 的 data URI 塞进图片格 —— 服务端只管嵌字节。
 * 这正是「图表进服务端报表」缺的那一半。
 *
 * 只支持 png / jpeg / gif / bmp（xlsx 真能嵌的四种）；webp / svg 会被**明确拒绝**。
 */
export interface CellImage {
  /**
   * 来源：`literal`（缺省，`src` 就是图片本身）/ `value`（取本格算出来的值当 `src`，
   * 用于「一列产品图」：`field: photo` + `image.from: 'value'`）。
   *
   * 服务端对 `value` 是大小写不敏感匹配、其余一律当 `literal`；这里收窄成两个字面量
   * 是为了让设计器给得出一个下拉框。
   */
  from?: 'literal' | 'value' | null
  /** `data:image/...;base64,...` */
  src: string
}

/** 能嵌进 xlsx 的图片类型（= Rust 侧 `parse_image_data_uri` 的白名单） */
export type ImageKind = 'png' | 'jpeg' | 'gif' | 'bmp'

/**
 * 校验 `data:image/...;base64,...`，认出来返回图片类型，否则返回 `null`。
 *
 * **判据必须与 Rust 的 `parse_image_data_uri` 保持一致，改一处要改两处。**
 * 两个方向都要顾：
 * - 这里更宽 → 设计器放行、导出时才报错，用户白填一次；
 * - 这里更严 → 服务端明明能嵌的图，在设计器里被拦下。
 *
 * 所以白名单只列 xlsx 真能嵌的四种（webp / svg 服务端明确拒绝，这里也拒）。
 * 只**校验**不解码：设计器只需要知道「能不能用 / 怎么显示」，真正的解码在服务端。
 */
export function parseImageDataUri(src: string): ImageKind | null {
  const s = src.trim()
  if (!s.startsWith('data:')) return null
  const comma = s.indexOf(',')
  if (comma < 0) return null
  const meta = s.slice(5, comma).toLowerCase()
  if (!meta.endsWith(';base64')) return null
  const mime = meta.slice(0, -';base64'.length).trim()
  const kind: ImageKind | null =
    mime === 'image/png'
      ? 'png'
      : mime === 'image/jpeg' || mime === 'image/jpg'
        ? 'jpeg'
        : mime === 'image/gif'
          ? 'gif'
          : mime === 'image/bmp'
            ? 'bmp'
            : null
  if (!kind) return null
  // 服务端的解码器会剥空白、并依次试 标准 / no-pad / URL-safe 四种字母表，
  // 所以这里的字母表要把四种的并集都收进来 —— 收窄了会误拦合法图。
  const payload = s.slice(comma + 1).replace(/\s+/g, '')
  if (!payload) return null
  if (!/^[A-Za-z0-9+/=_-]+$/.test(payload)) return null
  return kind
}

/** `CellImage.from` 是不是「取本格的值当图片源」（与服务端同样只认 `value`） */
export function isValueImage(from: string | null | undefined): boolean {
  return (from ?? '').trim().toLowerCase() === 'value'
}

/** 服务端认的码制（= Rust 侧 `normalise_symbology` 的白名单，别名会归一） */
export type BarcodeSymbology = 'qr' | 'code128'

/**
 * 条码格：这格不出文本，出一个条码 / 二维码。
 *
 * ## 为什么服务端自己编码，而不是让客户端给位图
 *
 * 图片格走的是「客户端栅格化、服务端只嵌字节」那条路，条码**故意不走**：
 * 编码是纯计算，自研编码器在 Rust 里跑一遍就出位矩阵，不必让每个调用方
 * 都带一个编码库。更关键的是**数据驱动** —— `from: 'value'` 时内容是本格
 * 算出来的值，那是服务端的计算结果，客户端根本拿不到；让客户端编就等于
 * 要求客户端把整列数据也自己算一遍。
 *
 * ## 与 image / chart 的关系
 *
 * 三个都是「非文本格子」，区别在**内容从哪来**：
 * - `image`：内容是一段 data URI（图是作者给的，服务端只管嵌）；
 * - `chart`：内容是从**别的格子**算出来的（读整列数据，一个声明只画一份）；
 * - `barcode`：内容是**本格自己的文本**编码成的。
 *
 * 所以条码在展开行里的行为跟**图片**一样：N 行出 N 个条码 ——
 * 这正是主场景「一列订单号，每行一个条码」。照抄图表那套「只画一份」
 * 会变成「N 行订单只有一个条码」，是错的。
 *
 * 三者同时声明时优先级 `图片 > 图表 > 条码`，由服务端**一个判据**决定
 * （`GridCell.graphic()`），被盖住的在引擎里就不生成、并进 `warnings`。
 *
 * ## 能力边界（**刻意不做**的，免得被当成缺口反复提）
 *
 * - 二维码只做**字节模式 + 纠错等级 M + 版本 1~10**（上限 213 字节）；
 *   数字 / 字母数字模式、L/Q/H 等级、版本 11+ 都不做，超了**明确报错**。
 * - Code128 **不在符号中途切换码集**：切换是启发式，猜错的表现是
 *   「能扫但内容是错的」，比扫不出来更糟。
 * - 没有条码下方的人可读文字（HRI）：HTML 侧画得出来、位图侧画不出来，
 *   两边不一致比两边都没有更糟。
 * - 码制只有 QR + Code128；EAN / UPC / Code39 会被**明确拒绝**（不静默降级成二维码）。
 */
export interface CellBarcode {
  /**
   * 来源：`literal`（缺省，`value` 就是内容）/ `value`（取本格算出来的值当内容）。
   *
   * `value` 是为了「一列订单号条码」：`field: order_no` + `from: 'value'`，
   * 每行的内容从数据里来。与服务端同样只认 `value`（大小写不敏感）。
   */
  from?: 'literal' | 'value' | null
  /** 要编码的原文（`from: 'value'` 时忽略）。空串会**报错**，不是静默出空白。 */
  value: string
  /**
   * 码制：`qr`（缺省）| `code128`；`qrcode` / `code-128` 这类别名也认。
   *
   * 认不出来**只坏这一格**（该格出 `[条码: 原因]` 并告警），不整表报错 ——
   * 所以这里收窄成两个字面量是为了让设计器给得出下拉框，
   * 不是说服务端只认这两种写法。
   */
  symbology?: BarcodeSymbology | null
  /**
   * Code128 的 GS1-128 模式（起始符后插一个 FNC1）。非 Code128 时忽略。
   *
   * 显式开关而不是靠内容前缀猜：GS1 的载荷里看不出来「要不要 FNC1」，
   * 猜错了是**条码能扫但内容不对**，最难查。
   */
  gs1?: boolean | null
}

/**
 * 服务端认的码制清单（= Rust `SYMBOLOGIES`）。
 *
 * 设计器的下拉框从这个清单生成，单测再断言「下拉项 == 这个清单」——
 * 免得以后服务端加了码制、界面还是老的两项，而**界面上看不出来少了一个**。
 */
export const BARCODE_SYMBOLOGIES: readonly BarcodeSymbology[] = ['qr', 'code128']

/**
 * 各码制的容量上限（**字节**，不是字符）。
 *
 * 与 Rust 的 `MAX_QR_BYTES` / `MAX_CODE128_BYTES` 一致，**改一处要改两处**。
 * 注意按 UTF-8 字节算：一个汉字 3 字节，所以「看起来 100 个字」的二维码
 * 其实已经超了 213。
 */
export const BARCODE_MAX_BYTES: Record<BarcodeSymbology, number> = {
  /** 版本 10 + 纠错等级 M + 字节模式的上限 */
  qr: 213,
  /** Code128 的保守上限（码集与内容相关，见 barcode.rs） */
  code128: 48,
}

/**
 * 归一化码制（与 Rust `normalise_symbology` **同一套别名**）。
 *
 * **判据必须与 Rust 保持一致，改一处要改两处。** 空值回落到服务端缺省 `qr`；
 * 认不出来返回 `null` —— 服务端此时只坏这一格（该格出 `[条码: 原因]` 并告警），
 * 不整表报错，所以设计器也**只提示、不拦**。
 */
export function normaliseSymbology(opt: string | null | undefined): BarcodeSymbology | null {
  const raw = (opt ?? '').trim().toLowerCase()
  if (!raw) return 'qr'
  if (raw === 'qr' || raw === 'qrcode' || raw === 'qr_code' || raw === 'qr-code') return 'qr'
  if (raw === 'code128' || raw === 'code-128' || raw === 'code_128') return 'code128'
  return null
}

/**
 * `gs1` 只对 Code128 有意义（起始符后插一个 FNC1）。
 *
 * 设计器据此决定要不要显示那个开关 —— 码制是 `qr` 时显示一个设了不起作用的开关，
 * 就是「设了没反应」。服务端同样忽略它（不报错）。
 */
export function isGs1Relevant(symbology: string | null | undefined): boolean {
  return normaliseSymbology(symbology) === 'code128'
}

/** UTF-8 字节数（`TextEncoder` 不一定有，自己数一遍，与 Rust `str::len()` 同口径） */
export function utf8ByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i) as number
    // 代理对占两个 code unit，一次吃掉
    if (c > 0xffff) i++
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** `CellBarcode.from` 是不是「取本格的值当条码内容」（与服务端同样只认 `value`） */
export function isValueBarcode(from: string | null | undefined): boolean {
  return (from ?? '').trim().toLowerCase() === 'value'
}

/**
 * 条码声明的「会被服务端拒绝」检查；没问题返回 `null`。
 *
 * 为什么设计器要**重算一遍**：这四条判据在 Rust 侧已经有了，但只在**导出/预览时**
 * 才生效 —— 作者填完要等一次请求才知道填错了。设计器先说，省一轮往返。
 *
 * **判据必须与 Rust 保持一致，改一处要改两处。**
 * 两个方向都要顾：这里更宽 → 设计器放行、导出时才报错；这里更严 →
 * 服务端明明能编的，在设计器里被拦下。
 *
 * 只**提示**不**拦**（与图片那段一致）：服务端是「只坏这一格」，不是整表失败。
 *
 * 刻意**不收 `payload` 参数** —— 内容就是声明里的 `value`，让调用方另传一份
 * 迟早会传岔（`from: value` 时根本不知道内容是什么）。
 */
export function barcodeProblem(bc: CellBarcode | null | undefined): string | null {
  if (!bc) return null
  const sym = normaliseSymbology(bc.symbology)
  if (!sym) {
    return `不认识的码制「${(bc.symbology ?? '').trim()}」，支持：${BARCODE_SYMBOLOGIES.join(' / ')}`
  }
  // `from: 'value'` 时内容来自数据，**设计期拿不到** → 只校验码制。
  // 容量 / ASCII 那几条要等展开完才知道，只能由服务端判。
  if (isValueBarcode(bc.from)) return null
  const payload = bc.value ?? ''
  if (!payload) return '条码内容为空'
  if (sym === 'code128') {
    // 顺序与 Rust `code128_pick_set` 严格一致，否则同一份内容两边结论会不同
    const cps = [...payload].map((ch) => ch.codePointAt(0) as number)
    if (cps.some((c) => c > 0x7f)) return 'Code128 只收 ASCII，中文 / 全角请改用二维码'
    const hasControl = cps.some((c) => c < 0x20)
    if (hasControl && cps.some((c) => c > 0x5f)) {
      return '内容里既有控制字符（只有码集 A 能表示）又有大写字母 / 符号（只有码集 B 能表示），一个码集装不下'
    }
    if (cps.includes(0x7f)) return 'Code128 表示不了 DEL(0x7F)'
  }
  const n = utf8ByteLength(payload)
  const max = BARCODE_MAX_BYTES[sym]
  if (n > max) {
    return sym === 'code128'
      ? `内容 ${n} 字节，超过排版上限 ${max} 字节（Code128 不是装不下，是列里画不下）`
      : `内容 ${n} 字节，超过 ${sym} 的上限 ${max} 字节`
  }
  return null
}

/** 服务端认的图表类型（= Rust 侧 `resolve_chart` 的白名单） */
export type CellChartKind = 'bar' | 'line' | 'pie'

/**
 * 图表类型清单（= Rust `resolve_chart` 的白名单）。
 *
 * 设计器的下拉框从这个清单生成，单测再断言「下拉项 == 这个清单」——
 * 免得以后服务端加了类型、界面还是老的三项，而**界面上看不出来少了一个**。
 */
export const CHART_KINDS: readonly CellChartKind[] = ['bar', 'line', 'pie']

/**
 * 图表声明的「会被服务端拒绝」检查；没问题返回 `null`。
 *
 * 与 `barcodeProblem` 同一套路：判据在 Rust 侧已有，但那要等一次请求才生效，
 * 设计器先说省一轮往返。**只提示不拦** —— 服务端是「只坏这一格」。
 *
 * 最常填错的是**把数据格的位置填成了值**（比如 `categories: ['华东']`）——
 * 这里填的是**模板坐标**（`A3`），所以先校验形状，再让服务端判坐标存不存在。
 */
export function chartProblem(ch: CellChart | null | undefined): string | null {
  if (!ch) return null
  if (ch.kind && !CHART_KINDS.includes(ch.kind as CellChartKind)) {
    return `不认识的图表类型「${ch.kind}」，支持：${CHART_KINDS.join(' / ')}`
  }
  const cats = (ch.categories ?? []).map((c) => c.trim()).filter(Boolean)
  const series = (ch.series ?? []).filter((s) => (s?.from ?? '').trim())
  if (series.length === 0) return '至少要配一条数据序列（填数值所在格的模板坐标，如 B3）'
  const badPos = [...cats, ...series.map((s) => s.from.trim())].find((p) => parsePos(p) === null)
  if (badPos) return `「${badPos}」不像模板坐标（应形如 A3）`
  if (series.length > 1 && (ch.kind ?? 'bar') === 'pie') {
    return '饼图只用第一条序列，配多条会被服务端拒绝'
  }
  // 类目数留空是允许的（服务端用序号 1、2…）。
  // 「类目数 == 每条序列的点数」只能等展开完才知道，那是服务端的活，这里判不了。
  return null
}

/**
 * 图表格：这格不出文本，出一张图表（柱状 / 折线 / 饼图）。
 *
 * ## 数据来源写的是「模板位置名」
 *
 * 图表画的是**展开之后**的数据（3 个地区 → 3 根柱子），但作者写模板时只知道
 * 模板坐标（`A3` = 地区列）。服务端靠 `GridCell.pos` 反查「`A3` 展开成了哪几个
 * 输出格」，所以这里填的是模板坐标而不是输出行列 —— 输出行列要等展开完才知道，
 * 作者不可能写得出。
 *
 * - 纵向分组报表：`categories: ['A3']` + `series: [{ from: 'B3' }]` → 3 根柱子；
 * - 横向交叉表：`categories: ['B2']` + `series: [{ from: 'B3' }]` → 同样是 3 根。
 *
 * ## 数量必须对得上
 *
 * 类目数与每条序列的点数**必须完全相等**，否则整张图不出，该格显示
 * `[图表: 原因]` 并进 `warnings`。不截断也不补零 —— 那两种都是
 * 「图看着对、数据是错的」。最常见的错法是把类目指到表头那种不展开的格子上。
 */
export interface CellChart {
  /** 图表类型；认不出来只坏这一格（该格出 `[图表: 原因]`），不整表报错 */
  kind?: string | null
  /** 类目来源：模板位置名列表，如 `['A3']`；留空则用序号 `1`、`2`… */
  categories?: string[]
  /** 数据序列；`pie` 只用第一条 */
  series?: CellChartSeries[]
  /** 图表标题（画在顶部居中） */
  title?: string | null
}

/** 一条数据序列的**声明**（数值还没解析出来） */
export interface CellChartSeries {
  /** 序列名（图例 / 饼图扇区名）；留空则回落用 `from` 那个位置名 */
  name?: string | null
  /** 数值来源：模板位置名，如 `'B3'` */
  from: string
}

/** 解析完成的图表：类目与数值都是展开后的真实数据（服务端算好回传） */
export interface ResolvedChart {
  /** 已归一化的类型：`bar` | `line` | `pie`（小写） */
  kind: string
  categories: string[]
  series: ResolvedChartSeries[]
  title?: string | null
}

/** 解析完成的一条序列 */
export interface ResolvedChartSeries {
  /** 序列名（已回落：作者没写就用 `from`） */
  name: string
  /**
   * 与 `ResolvedChart.categories` **等长**；缺测的位置是 `null`
   * （图上画成空档，**不补 0** —— 「空着」和「就是 0」在报表里是两回事）。
   */
  data: (number | null)[]
}

/**
 * 解析完成的条码：位矩阵已经算好了（服务端编码器产出，三端共用同一份）。
 *
 * 与 `CellBarcode` 的区别是「声明 vs 结果」，正如 `ResolvedChart` 之于 `CellChart`。
 */
export interface ResolvedBarcode {
  /** 已归一化的码制：`qr` | `code128`（小写） */
  symbology: string
  /**
   * 位矩阵：每行一个字符串，`'1'` = 黑。**静区已含在内**，一维码已拉伸成面。
   *
   * 用字符串而不是布尔二维数组：报表**每一行**都可能带条码，
   * 一张 65×65 的二维码用 `true,` 序列化是 5 倍体积差。
   * 附带好处是 JSON 里肉眼就能看出这是个二维码。
   */
  rows: string[]
  /** 原文（给 HTML 的 `alt` / Excel 的替代文字 / 排查用） */
  text: string
}

export interface GridCell {
  text: string
  pos: string
  rowspan: number
  colspan: number
  raw_number?: number | null
  /** Excel 数字格式串（由 NumFmt 推导），xlsx 导出时套到数值格上 */
  num_format?: string | null
  /** Excel 公式（仅 cell.model.export_formula 且表达式可翻译时非空）；HTML 预览用 text */
  formula?: string | null
  /**
   * 作者定义的样式；空表示该格没设样式，走导出器的默认外观。
   * HTML 预览目前不用它（预览的配色是语义高亮，两套东西别混）。
   */
  style?: CellStyle | null
  /**
   * 图片格：**已解析**的 data URI。有值时这格出图片不出文本
   * （`text` 降级成 `alt=`）。
   *
   * 只存 data URI 不存路径：预览（浏览器）、HTML 导出、xlsx 导出三边都能直接用，
   * 且 HTML 天然自包含。代价是同一张图重复 N 行会在 JSON 里重复 N 份。
   */
  image?: string | null
  /**
   * 图表格：**已解析**的图表（类目 + 各序列数值，数值已是展开后的真实数据）。
   * 有值时这格出图表不出文本（`text` 降级成 alt / 失败原因）。
   */
  chart?: ResolvedChart | null
  /**
   * 条码格：**已编码**的位矩阵（`'1'` = 黑，静区已含）。
   * 有值时这格出条码不出文本（`text` 降级成 alt / 失败原因）。
   *
   * 与 `chart` 一样存**算好的结果**而不是声明：预览、HTML、xlsx 三边
   * 拿到的是同一份位矩阵，不会各自再编一遍（那样迟早对不上）。
   *
   * ⚠️ 与 `image` / `chart` 的优先级是 `图片 > 图表 > 条码`，被盖住时
   * 服务端**连编都不编** —— 所以「有值 ⟹ 它就是这格要画的那个」。
   */
  barcode?: ResolvedBarcode | null
}

export interface RenderedSheet {
  name: string
  rows: GridCell[][]
}

/** 分页配置（页面级：按数据行数切页，表头/表尾每页重复） */
export interface PageConfig {
  /** 每页容纳的**数据**行数（不含重复的表头/表尾） */
  rows_per_page?: number
  /** 每页顶部重复的模板行数（表头） */
  repeat_header_rows?: number
  /** 每页底部重复的模板行数（表尾 / 签字栏等） */
  repeat_footer_rows?: number
}

export interface RenderResponse {
  sheets: RenderedSheet[]
  html: string
  /** 展开中间结果（仅 dump=true 时返回）：`seq | pos | 文本 <- 层次坐标 | 行父 | 列父` */
  dump?: string | null
  /** 分页结果（仅模板配了 page 时返回）：每页一个 sheet，名字带 ` (i/n)` */
  pages?: RenderedSheet[] | null
  /** 逐页 HTML，与 pages 一一对应 */
  pages_html?: string[] | null
  /**
   * 会静默产出错误数据的可疑情况（父格查不到、表达式解析失败等）。
   * 不中断渲染，但调用方应当展示给用户。
   */
  warnings?: string[] | null
}

export type ExpandDir = 'r' | 'c'

/** 交叉表数值格的聚合方式：同一 (行分组, 列分组) 交集里通常有多行数据 */
export type AggType = 'sum' | 'count' | 'avg' | 'min' | 'max'

/**
 * 数值显示格式（与设计器控件的 `CellFormat` 同形；服务端 `NumFmt` 与之逐字段对应）。
 *
 * 不配置则走服务端全局兜底：整数带千分位、非整数两位小数。
 */
export interface CellFormatSpec {
  kind: 'text' | 'int' | 'decimal' | 'currency' | 'percent'
  /** 小数位数；int 默认 0，decimal/currency/percent 默认 2 */
  digits?: number
  /** 千分位；int/decimal/currency 默认 true */
  thousands?: boolean
  /** 货币代码（kind=currency），默认 CNY */
  code?: string
}

export interface CellModel {
  ds?: string
  field?: string
  agg?: AggType
  expand_type?: ExpandDir
  row_parent?: string
  /**
   * 跨数据集关联键：本格的数据集用这个字段去**匹配父格当前行的同名字段值**。
   *
   * 父子格在不同数据集时（一个 sheet 可以有多个数据集，每个数据源一条 SQL），
   * 光靠行下标对不上号，必须有个键。不写就是没有关联依据 —— 服务端会告警并出空，
   * 绝不按行号硬凑（硬凑出来的是看着正常、其实错的数据）。
   */
  join_on?: string
  col_parent?: string
  /** 列向定位：本格排在目标 pos 所占列区间之后（列数随数据变化时用它，避免写死列号） */
  col_after?: string
  value_expr?: string
  expand_expr?: string
  /** 展开条数下限：不足时补空值（「默认留 N 个空行」） */
  expand_min_count?: number
  /** 展开条数上限：超过的丢弃（「只显示前 N 条」） */
  expand_max_count?: number
  /** 展开集为空时保留该格（值为 null）；缺省会连同子格一起删除 */
  keep_expand_empty?: boolean
  /** 数值显示格式（小计 / 合计格应与所在数值列一致） */
  format?: CellFormatSpec
  /**
   * 展示期表达式（第三值阶段）：可用 `value` 指代本格的值，
   * 如 `IF(value >= 1000, "大额", "小额")`。
   * 只影响展示文本，不影响导出到 xlsx 的原始数值。
   */
  format_expr?: string
  /**
   * 字典翻译：原始值文本 → 展示文本，如 `{ "1": "是", "0": "否" }`。
   * 键取未套数字格式的原始文本；命中不了就回落到 format / 全局兜底。
   */
  dict?: Record<string, string>
  /**
   * 行测试表达式：返回假则**整行删除**（本格连同子树一起不占位）。
   * 应挂在「决定这一行」的单元格上（如分组格），挂在叶子格上只会删掉那一格。
   */
  row_test_expr?: string
  /** 列测试表达式：返回假则整列删除 */
  col_test_expr?: string
  /**
   * 导出 xlsx 时把 value_expr 翻译成 Excel 公式（而非写死算好的值），
   * 导出后在 Excel 里改明细，小计 / 合计会跟着重算。
   * 翻不出来（如 PROPORTION / 条件表达式）会回落写值并告警。
   */
  export_formula?: boolean | null
  /**
   * 作者定义的格子样式（粗体 / 斜体 / 字号 / 字色 / 底色 / 对齐）。
   * 这是**唯一**会导出到 xlsx 的样式来源，语义高亮不算。
   */
  style?: CellStyle | null
  /**
   * 把这格画成图片。放在 `CellModel` 上是为了让**数据驱动的图片**
   *（`field: photo` + `image.from: 'value'`）能随展开逐行取源。
   */
  image?: CellImage | null
  /**
   * 把这格画成图表（柱状 / 折线 / 饼图）。
   *
   * 与 `image` 是同一族「非文本格子」，区别是图表的数据从**别的格子**算出来，
   * 所以要带一组模板坐标（见 `CellChart`）。
   */
  chart?: CellChart | null
  /**
   * 把这格画成条码 / 二维码（见 `CellBarcode`）。
   *
   * 放在 `CellModel` 上是为了让**数据驱动的条码**（`field: order_no` +
   * `barcode.from: 'value'`）能随展开逐行取内容。
   */
  barcode?: CellBarcode | null
}

export interface CellTpl {
  pos?: string
  value?: string | number | null
  model?: CellModel
  /** 向右合并列数（merge_across + 1 == colspan） */
  merge_across?: number
  /** 向下合并行数（merge_down + 1 == rowspan）；多级列表头的表头格用它纵跨所有列头行 */
  merge_down?: number
  /** 横向铺到行尾；列数随数据变化时标题/表头无法写死合并宽度 */
  merge_to_end?: boolean
  /**
   * 把这格画成图片。放在 `CellTpl` 上是为了让**静态图片**（logo / 二维码）
   * 不必为了一个 data URI 去建 `CellModel`。
   */
  image?: CellImage | null
  /** 把这格画成图表。同样放在 `CellTpl` 上，让「一张固定图表」不必建 `CellModel`。 */
  chart?: CellChart | null
  /** 把这格画成条码 / 二维码。同样放在 `CellTpl` 上，让「一个固定二维码」不必建 `CellModel`。 */
  barcode?: CellBarcode | null
}

export interface RowTpl {
  cells: CellTpl[]
}

export interface SheetTpl {
  name: string
  rows: RowTpl[]
  /** 分页配置；缺省不分页 */
  page?: PageConfig | null
  /**
   * 循环变量：按该字段的不同取值把本 sheet 复制成 N 张，每值一张，
   * 每张只看到属于该值的行（「一个客户一张表」）。生成的 sheet 名为 `原名 - 取值`。
   */
  loop_field?: string | null
}

export interface ReportTemplate {
  sheets: SheetTpl[]
  datasets?: Record<string, Record<string, unknown>[]>
}

/** 服务端现查的数据源声明（字段与 /api/data/rows 的 DataQuery 对齐） */
export interface ReportSource {
  name: string
  connId?: string
  engine?: string
  database?: string
  table?: string
  fields?: string
  limit?: number
  where?: string
  params?: unknown[]
}

export interface RenderRequest {
  template: ReportTemplate
  datasets?: Record<string, Record<string, unknown>[]>
  sources?: ReportSource[]
  /** 输出展开中间结果，用于排查扩展 / 求值问题 */
  dump?: boolean | null
}

/** 列下标 → Excel 列名：0 → A，26 → AA */
export function colName(idx: number): string {
  let n = idx
  let s = ''
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s
    if (n < 26) break
    n = Math.floor(n / 26) - 1
  }
  return s
}

/** 行列下标 → 位置名（0 基）：(0, 2) → "A3" */
export function cellPos(row: number, col: number): string {
  return `${colName(col)}${row + 1}`
}

/** `items[].amount` / `items.amount` → `amount` */
export function stripArrayPrefix(field: string): string {
  return field.replace(/^items(\[\])?\./, '')
}

/** 内置中文别名（面向常见业务字段），显式别名优先于它 */
export const DEFAULT_FIELD_LABELS: Record<string, string> = {
  region: '地区',
  city: '城市',
  province: '省份',
  salesman: '销售员',
  name: '姓名',
  amount: '金额',
  qty: '数量',
  price: '单价',
  month: '月份',
  year: '年份',
  date: '日期',
  product: '产品',
  category: '类别',
  dept: '部门',
  status: '状态',
}

/** 字段 → 显示名：显式别名 > 内置中文别名 > 字段原名 */
export function labelOf(field: string, aliases?: Record<string, string>): string {
  return aliases?.[field] || DEFAULT_FIELD_LABELS[field] || field
}

/** 取某数值字段的显示格式；未配置 → undefined（服务端走全局兜底口径） */
function fmtOf(
  field: string,
  map?: Record<string, CellFormatSpec>,
): CellFormatSpec | undefined {
  return map?.[field]
}

/** 解析参数输入框：空 → []；否则必须是 JSON 数组 */
export function parseParams(text: string): { ok: boolean; params?: unknown[]; message?: string } {
  const t = text.trim()
  if (!t) return { ok: true, params: [] }
  try {
    const v: unknown = JSON.parse(t)
    if (Array.isArray(v)) return { ok: true, params: v }
    return { ok: false, message: '参数需为 JSON 数组，如 ["华东", 1000]' }
  } catch (e) {
    return { ok: false, message: `参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }
  }
}

function cell(
  value: string | null,
  model?: CellModel,
  mergeAcross = 0,
  extra?: { mergeDown?: number; mergeToEnd?: boolean },
): CellTpl {
  const out: CellTpl = {
    pos: undefined,
    value: value ?? undefined,
    model,
    merge_across: mergeAcross,
  }
  if (extra?.mergeDown) out.merge_down = extra.mergeDown
  if (extra?.mergeToEnd) out.merge_to_end = true
  return out
}

/** 按索引写单元格，中间空位补占位格（服务端会跳过无值无模型的格子） */
function setCell(list: CellTpl[], idx: number, c: CellTpl): void {
  while (list.length < idx) list.push(cell(null))
  list[idx] = c
}

export interface GroupTemplateOptions {
  sheetName?: string
  /** 数据集名，需与 ReportSource.name 对应 */
  ds?: string
  /** 分组字段，从粗到细，如 ['region', 'city'] */
  groupFields: string[]
  /** 需要汇总的数值字段 */
  valueField: string
  /**
   * 数值字段在**每组内**的聚合方式，默认 sum。
   *
   * 必须聚合：一个分组下往往有多行明细（如「华东」下有 4 个城市），
   * 只取首行会把 37,900 显示成 12,000，后续小计/总计也跟着错。
   */
  agg?: AggType
  /** 字段 → 中文别名（表头与小计标签用它），缺省回落到内置别名表 */
  aliases?: Record<string, string>
  /** 字段 → 数值显示格式（表头不受影响；小计 / 总计沿用数值列的格式） */
  valueFormats?: Record<string, CellFormatSpec>
  /** 标题（留空则不输出标题行） */
  title?: string
  /** 分页配置；缺省不分页（整张表一次输出） */
  page?: PageConfig
}

/**
 * 生成「分组汇总」模板：N 级分组 + 各级小计/合计 + 总计。
 *
 * 布局（以 2 级分组为例）：
 *   row0 标题（merge_to_end，铺满整行）
 *   row1 表头
 *   row2 分组格 A3/B3 + 数值格 C3（行展开，组内按 agg 聚合）
 *   row3 末级小计（挂最深主格）
 *   row4 总计（标签横跨所有分组列）
 */
export function buildGroupTemplate(opts: GroupTemplateOptions): ReportTemplate {
  const ds = opts.ds ?? 'ds1'
  const aliases = opts.aliases ?? {}
  const groups = opts.groupFields.filter((f) => !!f)
  const cols = groups.length + 1
  const valueCol = cols - 1
  /** 数值列格式：明细 / 小计 / 总计保持一致 */
  const vfmt = fmtOf(opts.valueField, opts.valueFormats)
  const rows: RowTpl[] = []

  if (opts.title) {
    rows.push({ cells: [cell(opts.title, undefined, 0, { mergeToEnd: true })] })
  }

  // 表头（用中文化后的显示名）
  const headerRow = rows.length
  rows.push({
    cells: [
      ...groups.map((f) => cell(labelOf(f, aliases))),
      cell(labelOf(opts.valueField, aliases)),
    ],
  })

  // 明细行：分组格链式 row_parent，数值格挂最深分组格
  const detailRow = rows.length
  const valuePos = cellPos(detailRow, valueCol)
  const detail: CellTpl[] = groups.map((f, i) =>
    cell(null, {
      ds,
      field: f,
      expand_type: 'r',
      row_parent: i === 0 ? undefined : cellPos(detailRow, i - 1),
    }),
  )
  detail.push(
    cell(null, {
      ds,
      field: opts.valueField,
      agg: opts.agg ?? 'sum',
      row_parent: cellPos(detailRow, Math.max(0, groups.length - 1)),
      format: vfmt,
    }),
  )
  rows.push({ cells: detail })

  // 小计行：从次深级往上，最深一级不单独小计（每个明细行本身就是一行）
  for (let k = groups.length - 2; k >= 0; k--) {
    const parentPos = cellPos(detailRow, k)
    const g = labelOf(groups[k]!, aliases)
    const label = k === groups.length - 2 ? `${g}小计` : `${g}合计`
    const row: CellTpl[] = new Array(cols).fill(null).map(() => cell(null))
    row[k] = cell(label, { ds, row_parent: parentPos })
    row[valueCol] = cell(null, {
      ds,
      row_parent: parentPos,
      value_expr: `${valuePos}[${parentPos}:+0].sum()`,
      format: vfmt,
    })
    rows.push({ cells: row })
  }

  // 总计：标签横跨所有分组列（单级分组时 cols-2 = 0，不会与数值列撞在同一格）
  const totalRow: CellTpl[] = new Array(cols).fill(null).map(() => cell(null))
  totalRow[0] = cell('总计', undefined, Math.max(0, cols - 2))
  totalRow[valueCol] = cell(null, { ds, value_expr: `${valuePos}.sum()`, format: vfmt })
  rows.push({ cells: totalRow })

  void headerRow
  return { sheets: [{ name: opts.sheetName ?? '分组汇总', rows }] }
}

export interface DetailTemplateOptions {
  sheetName?: string
  ds?: string
  /** 列定义：title 为表头文字，field 为字段名（允许 items[]. 前缀） */
  columns: Array<{ title?: string; field?: string }>
  /** 字段 → 中文别名（列没有 title 时用它兜底） */
  aliases?: Record<string, string>
  /** 字段 → 数值显示格式（仅对配置了的数值列生效） */
  valueFormats?: Record<string, CellFormatSpec>
  title?: string
  /** 分页配置；缺省不分页 */
  page?: PageConfig
}

/**
 * 由「设计器画布里的表格控件」生成明细表模板。
 *
 * 首列纵向展开（不带 field → 每个数据行一个实例），其余列取字段值并挂首列为主格。
 */
export function buildDetailTemplate(opts: DetailTemplateOptions): ReportTemplate {
  const ds = opts.ds ?? 'ds1'
  const cols = opts.columns.filter((c) => !!c.field)
  if (cols.length === 0) {
    throw new Error('表格没有可映射的字段列')
  }
  const rows: RowTpl[] = []
  if (opts.title) {
    rows.push({ cells: [cell(opts.title, undefined, 0, { mergeToEnd: true })] })
  }
  rows.push({
    cells: cols.map((c) => cell(c.title || labelOf(stripArrayPrefix(c.field ?? ''), opts.aliases))),
  })

  const detailRow = rows.length
  const firstPos = cellPos(detailRow, 0)
  rows.push({
    cells: cols.map((c, i) =>
      cell(null, {
        ds,
        field: i === 0 ? undefined : stripArrayPrefix(c.field ?? ''),
        expand_type: i === 0 ? 'r' : undefined,
        row_parent: i === 0 ? undefined : firstPos,
        format: i === 0 ? undefined : fmtOf(stripArrayPrefix(c.field ?? ''), opts.valueFormats),
      }),
    ),
  })

  return { sheets: [{ name: opts.sheetName ?? '明细表', rows, page: opts.page }] }
}

export interface CrossTemplateOptions {
  sheetName?: string
  ds?: string
  /** 行分组字段（纵向展开），从粗到细 */
  rowFields: string[]
  /** 列分组字段（横向展开），从粗到细 */
  colFields: string[]
  /** 数值字段；多个则在每个列分组下并排展开 */
  valueFields: string[]
  /** 数值格的聚合方式，默认 sum（交叉表一个格子里通常落多行数据） */
  agg?: AggType
  /** 是否输出行合计 / 列合计 / 总计，默认 true */
  totals?: boolean
  /** 字段 → 中文别名（各级表头与「xx合计」用它），缺省回落到内置别名表 */
  aliases?: Record<string, string>
  /** 字段 → 数值显示格式（数值格 / 行合计 / 列合计 / 总计 一致套用） */
  valueFormats?: Record<string, CellFormatSpec>
  title?: string
  /** 分页配置；缺省不分页（整张表一次输出） */
  page?: PageConfig
}

/**
 * 生成「交叉表」模板：行字段纵向展开 × 列字段横向展开 × 数值字段。
 *
 * 布局（1 行字段 / 2 级列字段 / 2 数值字段）：
 * ```text
 *   r0 标题（merge_to_end，铺满整行）
 *   r1 行字段表头(rs=3) | 年份(列展开)          | 金额合计(rs=3) | 数量合计(rs=3)
 *   r2                  | 月份(列展开,col_parent) |
 *   r3                  | 金额 | 数量 | 金额 | 数量 |
 *   r4 行字段(行展开)    | 数值格(挂最深行格×最深列格) | 行合计…
 *   r5 合计             | 列合计…                | 总计…
 * ```
 *
 * 两条关键约束：
 * 1. **合计列的物理列号取决于数据里有多少个列分组**，写死会被覆盖 → 统一用 `col_after`
 *    让服务端在列布局第二遍推算（第 1 个跟在最深列展开格之后，第 n 个跟第 n-1 个之后）
 * 2. **表头格纵跨所有列头行** → 行字段表头与合计表头放在第一行列头并声明 `merge_down`，
 *    否则 N 级列头下表头块会出现半空的行
 */
export function buildCrossTemplate(opts: CrossTemplateOptions): ReportTemplate {
  const ds = opts.ds ?? 'ds1'
  const aliases = opts.aliases ?? {}
  const rowFs = opts.rowFields.filter(Boolean)
  const colFs = opts.colFields.filter(Boolean)
  const valFs = opts.valueFields.filter(Boolean)
  if (rowFs.length === 0 || colFs.length === 0 || valFs.length === 0) {
    throw new Error('交叉表需要至少一个行字段、一个列字段和一个数值字段')
  }
  const withTotals = opts.totals !== false
  /** 每个数值字段的显示格式（数值格与各类合计格共用） */
  const vfmt = valFs.map((f) => fmtOf(f, opts.valueFormats))
  /** 多值字段时补一列表头行，标明每个列分组下并排的是哪个指标 */
  const hasMetricRow = valFs.length > 1
  const rows: RowTpl[] = []

  if (opts.title) rows.push({ cells: [cell(opts.title, undefined, 0, { mergeToEnd: true })] })

  // ---- 列头：每个列字段一层，逐层 col_parent 链式 ----
  const headerStart = rows.length
  const colPos: string[] = []
  colFs.forEach((f, c) => {
    const r: CellTpl[] = []
    setCell(r, rowFs.length + c, cell(null, {
      ds,
      field: f,
      expand_type: 'c',
      col_parent: c === 0 ? undefined : colPos[c - 1],
    }))
    colPos.push(cellPos(headerStart + c, rowFs.length + c))
    rows.push({ cells: r })
  })

  const leafColPos = colPos[colPos.length - 1]!
  /** 表头块行数：各级列头 +（多值字段时）指标子表头 */
  const headerRows = colFs.length + (hasMetricRow ? 1 : 0)
  const valueRowIdx = headerStart + headerRows
  /** 数值单元格起始模板列 = 行字段数 + 列字段数 - 1（与最深列展开格同列） */
  const valueCol0 = rowFs.length + colFs.length - 1
  const valPos = valFs.map((_, j) => cellPos(valueRowIdx, valueCol0 + j))
  const totalCol0 = valueCol0 + valFs.length
  const mergeDown = headerRows - 1

  // 第一行列头：行字段表头（纵跨整个表头块）+ 合计列表头（同样纵跨）
  const firstHeader = rows[headerStart]!
  rowFs.forEach((f, i) =>
    setCell(firstHeader.cells, i, cell(labelOf(f, aliases), undefined, 0, { mergeDown })),
  )
  if (withTotals) {
    let prev: string | undefined
    valFs.forEach((f, j) => {
      const col = totalCol0 + j
      setCell(
        firstHeader.cells,
        col,
        cell(`${labelOf(f, aliases)}合计`, { ds, col_after: prev ?? leafColPos }, 0, { mergeDown }),
      )
      prev = cellPos(headerStart, col)
    })
  }

  // 指标子表头：每个列分组下并排的「金额 / 数量」，各自挂最深列展开格
  if (hasMetricRow) {
    const sub: CellTpl[] = []
    valFs.forEach((f, j) => {
      setCell(sub, valueCol0 + j, cell(labelOf(f, aliases), { ds, col_parent: leafColPos }))
    })
    rows.push({ cells: sub })
  }

  // ---- 明细行：行字段链式展开 + 数值格挂 (最深行格, 最深列格) ----
  const rowPos: string[] = []
  const valueRow: CellTpl[] = []
  rowFs.forEach((f, i) => {
    setCell(valueRow, i, cell(null, {
      ds,
      field: f,
      expand_type: 'r',
      row_parent: i === 0 ? undefined : rowPos[i - 1],
    }))
    rowPos.push(cellPos(valueRowIdx, i))
  })
  const leafRowPos = rowPos[rowPos.length - 1]!
  valFs.forEach((f, j) => {
    setCell(valueRow, valueCol0 + j, cell(null, {
      ds,
      field: f,
      agg: opts.agg ?? 'sum',
      row_parent: leafRowPos,
      col_parent: leafColPos,
      format: vfmt[j],
    }))
  })
  if (withTotals) {
    let prev: string | undefined
    valFs.forEach((_f, j) => {
      const col = totalCol0 + j
      setCell(valueRow, col, cell(null, {
        ds,
        row_parent: leafRowPos,
        col_after: prev ?? leafColPos,
        value_expr: `${valPos[j]}[${leafRowPos}:+0].sum()`,
        format: vfmt[j],
      }))
      prev = cellPos(valueRowIdx, col)
    })
  }
  rows.push({ cells: valueRow })

  // ---- 合计行：列合计（沿 col_parent 链汇总）+ 总计 ----
  if (withTotals) {
    const totalRowIdx = rows.length
    const totalRow: CellTpl[] = []
    setCell(totalRow, 0, cell('合计'))
    valFs.forEach((_f, j) => {
      setCell(totalRow, valueCol0 + j, cell(null, {
        ds,
        col_parent: leafColPos,
        value_expr: `${valPos[j]}[${leafColPos}:+0].sum()`,
        format: vfmt[j],
      }))
    })
    let prev: string | undefined
    valFs.forEach((_f, j) => {
      const col = totalCol0 + j
      setCell(totalRow, col, cell(null, {
        ds,
        col_after: prev ?? leafColPos,
        value_expr: `${valPos[j]}.sum()`,
        format: vfmt[j],
      }))
      prev = cellPos(totalRowIdx, col)
    })
    rows.push({ cells: totalRow })
  }

  return { sheets: [{ name: opts.sheetName ?? '交叉表', rows }] }
}

/** 表头样式 id（Univer IStyleData：加粗 + 居中 + 浅蓝底） */
const HEADER_STYLE_ID = 'grid-hdr'
/** 当前选中格 */
export const SELECTED_STYLE_ID = 'tpl-selected'
/** 选中格的**主格**（row_parent / col_parent 指向的格） */
export const PARENT_STYLE_ID = 'tpl-parent'
/**
 * 主格高亮色。
 *
 * 画布上「选中一格 → 点亮它的主格」是在 **Univer 上直接改底色** 做的（不重建工作簿，
 * 否则会丢选区），所以 UI 侧要自己拿这个色去涂、去还原。
 * 和 `PARENT_STYLE_ID` 的底色同源 —— 两条路画出来的主格必须同色，故只留这一份常量。
 */
export const PARENT_HIGHLIGHT = '#FFE8D6'
/**
 * 图片格在 Univer 网格里的占位文字。
 *
 * Univer 画不了图片（它的样式通道只有底色 + 字色，见文件头《Univer 实际能画什么》），
 * 而 `from: value` 的图片格文本是空的 —— 不补占位的话那格在模板网格里**完全看不见**，
 * 作者会以为「设了没反应」。它只是**设计态**的标记，不进模板、不进导出。
 */
export const IMAGE_CELL_TEXT = '[图片]'

/**
 * 设计态语义样式 —— 把非线性语义编码进格子外观。
 *
 * **为什么只能走样式、不能往文本里加标记**：格子里显示的文本就是**回写载体**
 * （`formatCellText` 输出 `=...`，`SheetValueChanged` 再 `parseCellText`
 * 还原成 model）。往文本里塞 `↓` 这类标记，用户一编辑就会把整格的 model
 * 冲成字面量 —— 静默丢数据，比不标还糟。
 *
 * 两个正交维度，各管一件事（超过两个维度用户就记不住了）：
 *
 * - **底色 = 这一格会不会"长"出来**（扩展方向）
 *   纵向 `r` 往下长行、横向 `c` 往右长列。这是决定报表形状的属性，最该被看见。
 * - **字色 = 内容从哪儿来**（字段绑定 / 表达式 / 静态文本）
 *   `=ds1.city` 和字面量「城市」在格子里长得几乎一样，不标分不清。
 *
 * **为什么只有两个维度、没有第三个**：试过用 `bd`（底边框）或 `ul`（下划线）
 * 标「挂了 row/col_test_expr，整行可能消失」—— 实测**都画不出来**，
 * 原因见下面《Univer 实际能画什么》。底色 + 字色已经用满，
 * 罕见属性不值得再挤一个维度，交给属性面板承载（那里现在有输入框了）。
 */

/**
 * Univer 0.25（core preset）**实际能画出来**的样式通道 —— 实测结论，别再试：
 *
 * - ✅ `bg` 底色、`cl` 字色、`bl` 加粗、`it` 斜体：都正常。
 * - ❌ `bd` 单元格边框：**完全不渲染**。THIN / MEDIUM 都试过，
 *   网格区域 0 个橙色像素（底色、字色同样的位置都有几百像素）。
 * - ⚠️ `ul` 下划线：会画，但**永远用字色**。`ITextDecoration.c` 的语义是
 *   "color is follow the font color"，缺省 TRUE，显式写 `c: 0` 也无效，
 *   `cl` 被无视 —— 蓝色字段格上的"橙色"下划线实测画成了蓝色。
 *
 * 结论：**配色能表达的语义上限就是底色 + 字色两个维度**。
 * 别再设计依赖边框 / 下划线的第三个维度。
 *
 * 更要紧的一条教训：单元测试只能证明我们**输出了**某个样式，证明不了
 * Univer **画得出**它。第一版就带着一个永远画不出来的橙色边框过了 11 条
 * 单测并提交 —— 要验渲染，只能截图数像素（`scripts/verify-semantic-colors.py`）。
 */
const SEM_BG = {
  r: { bl: 1, bg: { rgb: '#FFF1B8' } },
  c: { bl: 1, bg: { rgb: '#D7F0E3' } },
} as const
const SEM_FG = {
  field: { cl: { rgb: '#1668DC' } },
  expr: { cl: { rgb: '#6B4FBB' }, it: 1 },
} as const

/**
 * 供 UI 画图例：语义 → 颜色。改样式时这里要跟着改（有测试盯着，见 spec）。
 *
 * `swatch` / `italic` 是**显式**的呈现方式，别让 UI 去反查 `fg === '#D85A30'`
 * 或 `key === 'expr'` —— 那种拿颜色 / 字符串当枚举用的写法，改一次配色
 * 图例就静默变丑，而且没有任何检查会红。
 */
export const SEMANTIC_LEGEND = [
  { key: 'expand-r', label: '纵向扩展（往下长行）', bg: '#FFF1B8', fg: null, swatch: 'bg', italic: false },
  { key: 'expand-c', label: '横向扩展（往右长列）', bg: '#D7F0E3', fg: null, swatch: 'bg', italic: false },
  { key: 'field', label: '字段绑定', bg: null, fg: '#1668DC', swatch: 'fg', italic: false },
  { key: 'expr', label: '表达式 / 层次坐标', bg: null, fg: '#6B4FBB', swatch: 'fg', italic: true },
] as const

/** 一格的设计态语义样式；无语义（纯静态文本）返回 null。 */
function semanticStyleOf(cell: CellTpl): { id: string; style: Record<string, unknown> } | null {
  const m = cell.model
  const bgKey = m?.expand_type === 'r' ? 'r' : m?.expand_type === 'c' ? 'c' : ''
  const fgKey = m?.value_expr ? 'expr' : m?.field ? 'field' : ''
  if (!bgKey && !fgKey) return null
  const id = `tpl-${bgKey || 'n'}-${fgKey || 'n'}`
  const style: Record<string, unknown> = {
    ...(bgKey ? SEM_BG[bgKey] : {}),
    ...(fgKey ? SEM_FG[fgKey] : {}),
  }
  return { id, style }
}

/**
 * 一格的设计态底色；无语义底色返回 null。
 *
 * 主格高亮是**临时**的（选中时点亮、移开要还原），还原时需要知道它原本该是什么色。
 */
export function semanticBgOf(cell: CellTpl | undefined): string | null {
  const m = cell?.model
  if (m?.expand_type === 'r') return SEM_BG.r.bg.rgb
  if (m?.expand_type === 'c') return SEM_BG.c.bg.rgb
  return null
}

/** 一格的 row/col_parent 位置（已去重、去空）。供 UI 点亮主格。 */
export function parentPosOf(cell: CellTpl | undefined): string[] {
  const out: string[] = []
  const rp = cell?.model?.row_parent
  const cp = cell?.model?.col_parent
  if (rp) out.push(rp)
  if (cp && cp !== rp) out.push(cp)
  return out
}

/**
 * 按 A1 这样的位置取格；越界 / 位置非法返回 null。
 *
 * 直接反算下标（`parsePos` 是 `cellPos` 的逆），不做全网格线性扫 ——
 * 主格链要顺着 parent 一级级往上取，一次 O(R×C) 的扫描会被放大成 O(链长×R×C)。
 */
function findCellAtPos(grid: TemplateGrid, pos: string): CellTpl | null {
  const rc = parsePos(pos)
  if (!rc) return null
  return grid[rc.r]?.[rc.c] ?? null
}

/**
 * 一格的主格链：**由近及远**（`[直接主格, 祖父格, …]`）。
 *
 * 只跟 `row_parent` —— 行方向是非线性报表的主层次，混进 `col_parent`
 * 会让"链"变成一张图，既画不出来也说不清。成环时截断（`validateTemplate`
 * 已另行报警，这里只保证不死循环）。
 */
export function parentChainOf(grid: TemplateGrid, cell: CellTpl | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let cur = cell
  // 上界给足：链最长也就是格子总数，超过说明有环
  let guard = grid.length * (grid[0]?.length ?? 0) + 1
  while (cur && guard-- > 0) {
    const p = cur.model?.row_parent
    if (!p || seen.has(p)) break
    seen.add(p)
    out.push(p)
    cur = findCellAtPos(grid, p) ?? undefined
  }
  return out
}

/**
 * 选中格的**主格**位置集合。
 *
 * 主格是「关系」不是「属性」——平时画不出来，但选中一个格时把它的主格点亮，
 * 就是最省事的关系可视化：用户一眼看到「我挂在谁下面」。
 */
function parentPositionsOf(grid: TemplateGrid, selected: string): Set<string> {
  const out = new Set<string>()
  const cell = findCellAtPos(grid, selected)
  if (cell?.model?.row_parent) out.add(cell.model.row_parent)
  if (cell?.model?.col_parent) out.add(cell.model.col_parent)
  return out
}

/**
 * 模板前部的表头行数（标题行 + 各级列头 + 指标子表头），到第一个行展开格为止。
 * 只用于给 Univer 表头加粗/加底色，不影响展开结果。
 */
export function headerRowCount(tpl: ReportTemplate): number {
  const rows = tpl.sheets[0]?.rows ?? []
  let n = 0
  for (const r of rows) {
    const isHeader = r.cells.every((c) => c.model?.expand_type !== 'r' && !c.model?.row_parent)
    if (!isHeader) break
    n++
  }
  return n
}

/**
 * 预览要渲染哪一张表：分页结果非空时取**当前页**，否则取完整表（`sheets[0]`）。
 *
 * 抽成纯函数，是因为这里出过一个「预览永远只有完整表」的 bug：
 * 服务端 `RenderResponse.pages` 一直是有值的，但预览只读 `sheets[0]`，
 * 于是「每页 N 行」这类分页设置只能导出 xlsx 才看得见。
 * 判据（取哪一页、越界怎么办）放进纯函数才钉得住 —— 不必为了测它
 * 拉起整个 Univer + fetch。
 *
 * 越界一律夹到最后一页：重新渲染后页数可能变少，而 `pageIndex` 还停在旧值上。
 */
export function pickPreviewSheet(
  data: Pick<RenderResponse, 'sheets' | 'pages'>,
  pageIndex: number,
): RenderedSheet | undefined {
  const pages = data.pages ?? []
  if (!pages.length) return data.sheets[0]
  const i = Math.min(Math.max(0, Math.floor(pageIndex)), pages.length - 1)
  return pages[i]
}

/**
 * 展开结果 → Univer 工作簿数据（rowspan/colspan 转 mergeData）。
 *
 * `opts.headerRows` 指定的行会套上表头样式（加粗/居中/底色），用于「多级表头美化」。
 */
export function toWorkbookData(sheet: RenderedSheet, opts: { headerRows?: number } = {}) {
  const cellData: Record<number, Record<number, { v: string; s?: string }>> = {}
  const mergeData: Array<{
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
  }> = []

  const headerRows = Math.max(0, opts.headerRows ?? 0)

  sheet.rows.forEach((row, r) => {
    row.forEach((c, cIdx) => {
      if (!c || !c.text) return
      cellData[r] = cellData[r] || {}
      cellData[r][cIdx] = r < headerRows ? { v: c.text, s: HEADER_STYLE_ID } : { v: c.text }
      const rs = Math.max(1, c.rowspan || 1)
      const cs = Math.max(1, c.colspan || 1)
      if (rs > 1 || cs > 1) {
        mergeData.push({
          startRow: r,
          endRow: r + rs - 1,
          startColumn: cIdx,
          endColumn: cIdx + cs - 1,
        })
      }
    })
  })

  const columnCount = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)

  return {
    id: 'grid-report',
    name: sheet.name,
    sheetOrder: ['sheet1'],
    styles: {
      [HEADER_STYLE_ID]: { bl: 1, ht: 2, vt: 2, bg: { rgb: '#D9E1F2' } },
    },
    sheets: {
      sheet1: {
        id: 'sheet1',
        name: sheet.name || '报表',
        rowCount: Math.max(sheet.rows.length, 50),
        columnCount: Math.max(columnCount, 10),
        cellData,
        mergeData,
      },
    },
  }
}

/* ------------------------------------------------------------------ *
 * 报表定义文件（*.json）
 *
 * 「做个报表」和「跑个报表」原本是两件事：每次都要重选库、表、字段、选项。
 * 这里把它们合成一个文件：模板 + 数据源声明 + 渲染选项 + 元信息。
 * 存进 reports/ 后，**打开报表就能跑出数据**。
 *
 * 刻意只存「声明」不存数据快照：存快照会让报表过期，且几万行塞进文件没法看。
 * 选项也存开关而非算好的模板——存开关才能在打开时改。
 * ------------------------------------------------------------------ */

export const REPORT_FORMAT = 'openprint.report'
export const REPORT_VERSION = 1

/** 渲染选项。对应设计器里那排开关；执行时由服务端套到模板上。 */
export interface ReportOptions {
  /** 每页数据行数；>0 才分页 */
  rowsPerPage?: number | null
  repeatHeaderRows?: number | null
  repeatFooterRows?: number | null
  /** 小计/合计落成 Excel 公式而非写死的值 */
  exportFormula?: boolean | null
  /** 展开条数下限（作用于最内层明细） */
  expandMinCount?: number | null
  /** 展开条数上限（作用于最外层分组） */
  expandMaxCount?: number | null
  keepExpandEmpty?: boolean | null
  dump?: boolean | null
}

/** 一个报表定义文件的完整内容 */
/**
 * 报表参数声明 —— 决定「执行前弹什么查询条件」。
 *
 * 之前只有 `RunRequest.params`（数据集名 → 位置参数数组）那条底层通道，
 * 调用方得自己知道 SQL 里第几个 `?` 是什么，前端没法据此画表单。
 * 这一层把参数**命名**并描述清楚，UI 才能自动生成查询表单。
 *
 * 绑定方式：数据源的 `params` 里写字符串 `"$地区"`（`$` + 参数名），
 * 执行时换成这里解析出来的值。用显式 `$` 前缀而不是「看着像占位符就换」，
 * 是为了让「作者忘了写 $」变成一个能查出来的错误，而不是把字面量静默塞进 SQL。
 */
export interface ReportParam {
  name: string
  /** 表单上的显示名；缺省用 name */
  label?: string
  /** `text` | `number` | `date` | `enum`；缺省 text */
  kind?: string
  /** 没传值时用它 */
  default?: unknown
  /** 必填：既没传值也没默认值就报错（不能静默按空过） */
  required?: boolean
  /** `kind=enum` 时的候选项 */
  options?: string[]
}

export interface ReportDef {
  format: string
  version: number
  /** 文件 id，同时是文件名。只允许 [A-Za-z0-9_-] */
  id: string
  name: string
  description?: string
  updatedAt?: string | null
  template: ReportTemplate
  /** 数据从哪来；执行时现查 */
  sources?: ReportSource[]
  /** 执行前要填的参数（UI 据此画查询表单）；缺省空 */
  params?: ReportParam[]
  options?: ReportOptions
}

/** 列表项：只回元信息（模板可能有几千行） */
export interface ReportSummary {
  id: string
  name: string
  description: string
  updatedAt?: string | null
  sheets: string[]
  sourceCount: number
  bytes: number
}

/** 执行时可覆盖的东西：按数据集名覆盖查询参数 */
export interface RunRequest {
  params?: Record<string, unknown[]> | null
  dump?: boolean | null
}

/**
 * id 白名单（与服务端 store::is_valid_id 同一套规则）。
 * id 会直接参与拼文件名，必须在前端也挡一次——既是安全边界，
 * 也能让用户在按保存前就看到「这个名字不能用」。
 */
export function isValidReportId(id: string): boolean {
  return (
    id.length > 0 && id.length <= 80 && /^[A-Za-z0-9_-]+$/.test(id)
  )
}

/** 显示名 → 建议 id；非 ASCII / 空格等会退化，必要时再手工改 */
export function suggestReportId(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return s || 'report'
}

/* ------------------------------------------------------------------ *
 * 自由模板（类 Excel 逐格设计）
 *
 * 上面的三个构造器是「向导」：选字段 → 机器拼模板。它们盖不住
 * 「手写模板」场景——比如验证缺省父格跟随规则的那个三层模板，
 * 只能手写 JSON。这一层给 UI 提供逐格编辑需要的纯函数，
 * 全部可单测，Univer 只当画布。
 * ------------------------------------------------------------------ */

/**
 * 模板格里「绑定」的写法，两种都收：
 *
 * - `=ds1.city` / `=ds1.amount.sum()` / `=D3[B3:+0].sum()` —— **NopReport /
 *   润乾的惯例，也是现在写出去的规范形式**（`formatCellText` 只产这一种）。
 * - `{{ds1.city}}` —— 历史写法，仍然认，但不再产出。
 *
 * 早年只敢用 `{{}}`，因为 Univer 的 core preset 自带公式引擎，任何 `=` 开头
 * 的输入都会被当 Excel 公式解析，而我们这套 `D3[B3:+0].sum()` 层次坐标 DSL
 * 在 Excel 里没有对应物，会显示 `#NAME?`。
 *
 * 现在公式引擎已经剥掉了（`designer-react/src/report/univerFormulaFree.ts`），
 * 于是切回 `=`。**注意「剥引擎」本身不足以让 `=` 进单元格**：`sheets-ui` 的
 * `getCellDataByInput` 仍然把 `isFormulaString(text)` 硬编码成 `{f, v: null}`，
 * 那一段在 sheets-ui 里、跟引擎无关。所以还需要两处配合：
 *   1. 画布回写时带 `t: 4`（`CellValueType.FORCE_STRING`），见本文件
 *      `gridToWorkbookData`；
 *   2. 键入路径靠 mutation 拦截器把 `{f, v:null}` 掰回 `{v, f:null, t:4}`。
 */
/** 捕获组 1 = `{{...}}` 的内容，捕获组 2 = `=...` 的内容，两者同时只有一个有值 */
const BIND_RE = /^(?:\{\{([\s\S]+)\}\}|=([\s\S]+))$/
/** `ds1.city` */
const FIELD_RE = /^([A-Za-z_]\w*)\.([A-Za-z_][\w.]*)$/
/** `ds1.amount.sum()` */
const AGG_RE = /^([A-Za-z_]\w*)\.([A-Za-z_][\w.]*)\.(sum|count|avg|min|max)\(\)$/

/**
 * 模板格文本解析结果。
 *
 * `expand` 只在文本里**带方向标记**时出现：`=^ds1.city` 纵向、`=>ds1.city` 横向，
 * 沿用 NopReport 的 `*=^` / `*=>`（Rust 侧同一套记号见
 * `print-server/src/report/import.rs`）。
 *
 * 它纯是**输入兼容**——给「从 Excel 模板里粘进来」的格子用的。我们自己存的
 * ReportDef 里方向在 `model.expand_type` 上，所以 `formatCellText` **不往外写**
 * 这个记号（跟「只写 `=`、不写 `{{}}`」同一个道理：记号只留一种）。
 */
export type CellText =
  | { kind: 'literal'; text: string }
  | { kind: 'field'; ds: string; field: string; agg?: AggType; expand?: ExpandDir }
  | { kind: 'expr'; expr: string; expand?: ExpandDir }

/** 模板格文本 → 语义。`=...` / `{{...}}` 之外一律当字面量。 */
export function parseCellText(raw: string): CellText {
  const t = (raw ?? '').trim()
  const m = BIND_RE.exec(t)
  // `=` 或 `{{}}` 后面必须有内容，空的不算绑定（`=` 单独一个字符是字面量，
  // 跟 Univer `isFormulaString` 的 length > 1 判定保持一致）
  const inner = (m?.[1] ?? m?.[2] ?? '').trim()
  if (!m || !inner) return { kind: 'literal', text: raw ?? '' }

  // 方向标记只在最前面认一个；剥掉后剩下的按正常字段 / 表达式判定
  let expand: ExpandDir | undefined
  let body = inner
  if (body.startsWith('^') || body.startsWith('>')) {
    expand = body[0] === '^' ? 'r' : 'c'
    body = body.slice(1).trim()
    // `=^` 这种只有标记没有内容的，当字面量（跟 `=` 单独一个字符一致）
    if (!body) return { kind: 'literal', text: raw ?? '' }
  }

  const agg = AGG_RE.exec(body)
  if (agg) {
    return { kind: 'field', ds: agg[1], field: agg[2], agg: agg[3] as AggType, expand }
  }
  const fld = FIELD_RE.exec(body)
  if (fld) return { kind: 'field', ds: fld[1], field: fld[2], expand }
  // 既不是 ds.field 也不是 ds.field.agg()：当表达式（层次坐标 / 条件表达式等）
  return { kind: 'expr', expr: body, expand }
}

/**
 * 单元格 → 模板格文本（parseCellText 的逆）。空串表示这一格没内容。
 *
 * 产出 NopReport 的 `=` 方言。`{{}}` 只在**输入**时兼容，不再写出——
 * 两种写法只留一种，省得同一份模板里混着两套记号。
 */
export function formatCellText(cell: CellTpl): string {
  const m = cell.model
  if (m?.value_expr) return `=${m.value_expr}`
  if (m?.field) {
    const ds = m.ds || 'ds1'
    const agg = m.agg ? `.${m.agg}()` : ''
    return `=${ds}.${m.field}${agg}`
  }
  if (cell.value === undefined || cell.value === null) return ''
  return String(cell.value)
}

/**
 * 把一段格文本落到格子上：`parseCellText` 的结果 → 新的 CellTpl。
 *
 * 这段逻辑原先在 `GridReportModal` 里**抄了两份**（右栏 `free-cell-text` 输入
 * 与画布 `SheetValueChanged` 回写）。两处都得对同一条规则保持一致 ——
 * 「方向标记是**显式覆盖**：写了 `^` / `>` 才改，没写就保留 model 上原有的
 * expand_type」—— 抄两份迟早走偏，所以收成纯函数，好单测。
 *
 * - 字面量 → 写 value，model 原样保留
 * - 字段   → 写 ds/field/agg、清 value_expr
 * - 其它   → 当表达式：清 field，写 value_expr（ds 兜底 ds1）
 */
export function applyCellText(cell: CellTpl, raw: string): CellTpl {
  const parsed = parseCellText(raw)
  if (parsed.kind === 'literal') {
    return { ...cell, value: raw || null }
  }
  if (parsed.kind === 'field') {
    return {
      ...cell,
      value: null,
      model: {
        ...(cell.model ?? {}),
        ds: parsed.ds,
        field: parsed.field,
        agg: parsed.agg,
        ...(parsed.expand ? { expand_type: parsed.expand } : {}),
        value_expr: undefined,
      },
    }
  }
  return {
    ...cell,
    value: null,
    model: {
      ...(cell.model ?? {}),
      ds: cell.model?.ds ?? 'ds1',
      field: undefined,
      value_expr: parsed.expr,
    },
  }
}

/** 模板设计网格：矩形的 CellTpl 二维数组（比 SheetTpl 多一层「固定尺寸」约束） */
export type TemplateGrid = CellTpl[][]

export function emptyGrid(rows: number, cols: number): TemplateGrid {
  const g: TemplateGrid = []
  for (let r = 0; r < rows; r++) {
    const row: CellTpl[] = []
    for (let c = 0; c < cols; c++) row.push({ value: null, model: undefined })
    g.push(row)
  }
  return g
}

/** SheetTpl → 矩形网格（不足的行列补空格，方便 UI 直接按下标渲染） */
export function templateToGrid(sheet: SheetTpl, minRows = 20, minCols = 10): TemplateGrid {
  const src = sheet.rows ?? []
  const rows = Math.max(src.length, minRows)
  const cols = Math.max(src.reduce((m, r) => Math.max(m, r.cells?.length ?? 0), 0), minCols)
  const g = emptyGrid(rows, cols)
  src.forEach((row, r) => {
    ;(row.cells ?? []).forEach((cell, c) => {
      if (c < cols) g[r][c] = cell
    })
  })
  return g
}

/**
 * 网格 → SheetTpl。尾部全空的行会被裁掉（否则服务端会展开出一堆空行）；
 * **中间的空格必须保留**——它参与「向左/向上扫找主格」的判定。
 */
export function gridToSheet(grid: TemplateGrid, name: string): SheetTpl {
  const lastContentRow = grid.reduce(
    (acc, row, r) => (row.some((c) => formatCellText(c) !== '' || c.model) ? r : acc),
    -1,
  )
  const rows = grid.slice(0, lastContentRow + 1).map((row) => ({ cells: row }))
  return { name, rows, page: null }
}

/** 不可变地改一格。越界返回原网格（UI 不应让它发生，但不让它炸）。 */
export function setGridCell(grid: TemplateGrid, r: number, c: number, cell: CellTpl): TemplateGrid {
  if (!grid[r] || c < 0 || c >= grid[r].length) return grid
  return grid.map((row, ri) => (ri === r ? row.map((x, ci) => (ci === c ? cell : x)) : row))
}

/* ------------------------------------------------------------------ *
 * 合并单元格
 *
 * 服务端早就支持三种合并原语（`merge_across` / `merge_down` / `merge_to_end`），
 * 六个内置模板都在用（多级表头的表头格、铺满行尾的标题）。
 * 但自由模板这一层此前**完全没法表达合并**，两个后果：
 * - 「类 Excel 逐格设计」做不出多级表头，而那是报表模板最常见的版式需求；
 * - 缺省父格规则 3 永远触发不了 —— 它只在**子格跨行合并**把展开范围撑开时才有意义。
 *
 * 这里把合并补齐，并把「插删行列要跟着改跨度」一并处理掉。
 * ------------------------------------------------------------------ */

const BLANK_CELL: CellTpl = { value: null, model: undefined }

/** 一个格的合并跨度。`rows`/`cols` 为 1 表示该方向没合并。 */
export interface MergeSpan {
  rows: number
  cols: number
  /** 横向铺到行尾（列数随数据变化，模板期算不出确切列数） */
  toEnd: boolean
}

export function mergeSpanOf(cell: CellTpl | undefined): MergeSpan {
  return {
    rows: Math.max(1, (cell?.merge_down ?? 0) + 1),
    cols: Math.max(1, (cell?.merge_across ?? 0) + 1),
    toEnd: !!cell?.merge_to_end,
  }
}

/** 这一格是不是合并块的锚点（左上角那格） */
export function isMergeAnchor(cell: CellTpl | undefined): boolean {
  const s = mergeSpanOf(cell)
  return s.rows > 1 || s.cols > 1 || s.toEnd
}

/** 合并块：锚点位置 + 实际跨度（`toEnd` 已按网格宽度摊成具体列数） */
export interface MergeRect {
  r: number
  c: number
  rows: number
  cols: number
  toEnd: boolean
}

/**
 * 覆盖 (r,c) 的合并块（锚点格自己也算「被覆盖」）。没有则 null。
 *
 * 锚点必然落在 (r,c) 的左上方向，所以从 (r,c) 往回扫就够，不必全网格扫。
 */
export function mergeAt(grid: TemplateGrid, r: number, c: number): MergeRect | null {
  for (let rr = r; rr >= 0; rr--) {
    const row = grid[rr]
    if (!row) continue
    for (let cc = Math.min(c, row.length - 1); cc >= 0; cc--) {
      const s = mergeSpanOf(row[cc])
      if (s.rows === 1 && s.cols === 1 && !s.toEnd) continue
      const cols = s.toEnd ? row.length - cc : s.cols
      if (r <= rr + s.rows - 1 && c <= cc + cols - 1) {
        return { r: rr, c: cc, rows: s.rows, cols, toEnd: s.toEnd }
      }
    }
  }
  return null
}

export type MergeResult = { ok: true; grid: TemplateGrid } | { ok: false; message: string }

/**
 * 把 (r,c) 起、跨 `rows × cols` 的区域合并成一格（锚点在左上）。
 *
 * 三种情况**拒绝**而不是硬做：
 * - 越界；
 * - 区域里已经压着别的合并块（交叠 / 嵌套的合并在 Excel 里同样不允许）；
 * - 被覆盖的格里**已经有内容**。Excel 会直接丢掉，但模板里那往往是作者写好的
 *   表头或绑定 —— 丢掉之后只剩下「数据怎么没了」这个谜。宁可报错让人先清空。
 */
export function setGridMerge(
  grid: TemplateGrid,
  r: number,
  c: number,
  rows: number,
  cols: number,
): MergeResult {
  const height = Math.max(1, Math.floor(rows))
  const width = Math.max(1, Math.floor(cols))
  const rowCount = grid.length
  const colCount = grid[r]?.length ?? 0
  if (r < 0 || c < 0 || r + height > rowCount || c + width > colCount) {
    return { ok: false, message: `合并区域超出网格（当前 ${rowCount} 行 × ${colCount} 列）` }
  }

  for (let i = r; i < r + height; i++) {
    for (let j = c; j < c + width; j++) {
      const hit = mergeAt(grid, i, j)
      if (hit && !(hit.r === r && hit.c === c)) {
        return { ok: false, message: `${cellPos(hit.r, hit.c)} 那里已经有一个合并块，先取消它` }
      }
      if (i === r && j === c) continue
      if (formatCellText(grid[i][j]) !== '') {
        return { ok: false, message: `${cellPos(i, j)} 有内容，先清空再合并（合并会把它丢掉）` }
      }
    }
  }

  return {
    ok: true,
    grid: grid.map((row, ri) =>
      row.map((cell, ci) => {
        if (ri === r && ci === c) {
          return { ...cell, merge_down: height - 1, merge_across: width - 1, merge_to_end: false }
        }
        if (ri >= r && ri < r + height && ci >= c && ci < c + width) return { ...BLANK_CELL }
        return cell
      }),
    ),
  }
}

/** 取消覆盖 (r,c) 的合并块（锚点回到单格）。本来就没有合并块时原样返回。 */
export function clearGridMerge(grid: TemplateGrid, r: number, c: number): TemplateGrid {
  const hit = mergeAt(grid, r, c)
  if (!hit) return grid
  return grid.map((row, ri) =>
    row.map((cell, ci) =>
      ri === hit.r && ci === hit.c
        ? { ...cell, merge_down: 0, merge_across: 0, merge_to_end: false }
        : cell,
    ),
  )
}

/* ------------------------------------------------------------------ *
 * 位置引用的整体平移
 *
 * 插/删行列时，`row_parent:"A3"`、`value_expr:"D3[B3:+0].sum()"` 这些**文本引用**
 * 会整片失效。不做重映射的话，插一行表头就能让整个模板静默错位——
 * 这是类 Excel 设计器最容易漏、也最难查的一类 bug。
 * ------------------------------------------------------------------ */

/**
 * 单元格引用：`A3` / `D12`。
 *
 * 前后加断言是为了避开三类误伤（每一条都有对应用例，别随手放宽）：
 * - `ds1.city` —— 数据集名带数字，但它是小写，且 `1` 后面跟 `.`；
 * - `items[0].amount` / `qty1` —— 下标和字段名里的数字不是行号；
 * - **断言里不能加 `[`**：`D3[B3:+0].sum()` 的 `B3` 前面就是 `[`，
 *   加了就漏掉层次坐标里的括号引用（这个 bug 是被用例抓出来的）。
 * 反过来，`B3:+0` 的 `B3` 本身**是**引用要平移，`:+0` 是相对偏移不动。
 */
const CELL_REF_RE = /(?<![A-Za-z0-9_.])([A-Z]{1,3})([1-9]\d{0,6})(?![A-Za-z0-9_.])/g

/** 列名 → 列下标：A → 0，AA → 26 */
export function colIndex(name: string): number {
  let n = 0
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 位置名 → 行列下标；非法输入返回 null */
export function parsePos(pos: string): { r: number; c: number } | null {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(pos)
  if (!m) return null
  return { r: Number(m[2]) - 1, c: colIndex(m[1]) }
}

/**
 * 平移一段文本里的所有单元格引用。
 *
 * - 插入（delta > 0）：下标 ≥ at 的整体 +1
 * - 删除（delta < 0）：下标 > at 的整体 -1；**正好指向 at 的返回空串**——
 *   它引用的那一行/列没了，留着悬空引用会静默指向别处，比没有引用更危险。
 */
function shiftText(text: string, axis: 'row' | 'col', at: number, delta: number): string {
  return text.replace(CELL_REF_RE, (full, col: string, rowStr: string) => {
    const r0 = Number(rowStr) - 1
    const c0 = colIndex(col)
    const cur = axis === 'row' ? r0 : c0
    if (cur < at) return full
    if (delta < 0 && cur === at) return ''
    const next = cur + delta
    if (next < 0) return ''
    return axis === 'row' ? cellPos(next, c0) : cellPos(r0, next)
  })
}

/** 需要参与平移的字段：凡是可能写位置名的，一个都不能漏 */
const REF_FIELDS = [
  'row_parent',
  'col_parent',
  'col_after',
  'value_expr',
  'expand_expr',
  'row_test_expr',
  'col_test_expr',
] as const

function shiftModel(
  m: CellModel | undefined,
  axis: 'row' | 'col',
  at: number,
  delta: number,
): CellModel | undefined {
  if (!m) return m
  const next: CellModel = { ...m }
  for (const k of REF_FIELDS) {
    const v = m[k]
    if (typeof v !== 'string' || !v) continue
    const shifted = shiftText(v, axis, at, delta)
    // 主格被删掉 → 清空（留着悬空引用比没有主格更危险：会静默挂到别处）
    ;(next as Record<string, unknown>)[k] = shifted === '' || shifted === null ? undefined : shifted
  }
  return next
}

/** 插入行（at 之前）。所有 ≥at 的行引用整体 +1。 */
export function insertGridRow(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'row', at, 1, true)
}
/** 删除行。所有 >at 的行引用 -1；正好指向 at 的引用被清空。 */
export function deleteGridRow(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'row', at, -1, false)
}
export function insertGridCol(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'col', at, 1, true)
}
export function deleteGridCol(grid: TemplateGrid, at: number): TemplateGrid {
  return shiftGrid(grid, 'col', at, -1, false)
}

function shiftGrid(
  grid: TemplateGrid,
  axis: 'row' | 'col',
  at: number,
  delta: number,
  insert: boolean,
): TemplateGrid {
  const blank: CellTpl = { value: null, model: undefined }
  // 0) 先按插/删点调整合并**跨度**。
  //
  // 锚点位置由下面的结构平移（splice）自动带走，但跨度不会自己变：
  // 在一个 2 行高的合并表头**内部**插一行，跨度不跟着 +1，合并块就少盖一行，
  // 表头最后一行变成没合并的散格 —— 表照常出，只是版式悄悄错了。
  const spanned = grid.map((row, ri) =>
    row.map((cell, ci) => adjustSpanOnShift(cell, axis === 'row' ? ri : ci, at, delta, axis)),
  )
  // 1) 再按轴平移结构
  let out: TemplateGrid
  if (axis === 'row') {
    if (at < 0 || at > spanned.length) return grid
    const copy = spanned.map((row) => row.slice())
    if (insert) {
      copy.splice(at, 0, (spanned[0] ?? []).map(() => ({ ...blank })))
    } else {
      copy.splice(at, 1)
    }
    out = copy
  } else {
    const copy = spanned.map((row) => row.slice())
    for (const row of copy) {
      if (insert) row.splice(at, 0, { ...blank })
      else row.splice(at, 1)
    }
    out = copy
  }
  // 2) 最后平移文本引用（这一句才是重点：结构挪了，引用必须跟着挪）
  return out.map((row) =>
    row.map((cell) => {
      if (!cell.model) return cell
      return { ...cell, model: shiftModel(cell.model, axis, at, delta) }
    }),
  )
}

/**
 * 插/删行列时调整合并跨度（只动跨度，锚点位置交给结构平移）。
 *
 * 只有「插/删点落在锚点**之后**、跨度**之内**」才需要动：
 * - 落在锚点之前或等于锚点：锚点自己平移，跨度不变；
 * - 落在跨度之外：与这个合并块无关。
 *
 * 删除把跨度缩到 1 时自动解除合并（`merge_down` 归 0），不会留下一个 0 行高的块。
 * 删除锚点所在行列时这里不动手 —— 锚点格随结构一起被删掉，合并自然消失；
 * 用户删的就是这个表头，符合预期。
 */
function adjustSpanOnShift(
  cell: CellTpl,
  index: number,
  at: number,
  delta: number,
  axis: 'row' | 'col',
): CellTpl {
  const s = mergeSpanOf(cell)
  const span = axis === 'row' ? s.rows : s.cols
  if (span <= 1) return cell
  if (index >= at || at > index + span - 1) return cell
  const next = Math.max(1, span + delta)
  if (next === span) return cell
  return axis === 'row'
    ? { ...cell, merge_down: next - 1 }
    : { ...cell, merge_across: next - 1 }
}

/**
 * 模板体检：把「表照常出但数据不是你想要的」那类问题提前报出来。
 *
 * 只报**能确定是错的**，不报「可能你想这么写」——告警一多就没人看了。
 */
export function validateTemplate(tpl: ReportTemplate): string[] {
  const out: string[] = []
  const sheet = tpl.sheets?.[0]
  if (!sheet) return ['模板至少一个 sheet']

  // 位置 → 模型，用于检查主格指向的格子是否真的存在 / 是否也是展开格
  const at = (r: number, c: number): CellTpl | undefined => sheet.rows?.[r]?.cells?.[c]

  sheet.rows?.forEach((row, r) => {
    row.cells?.forEach((cell, c) => {
      const m = cell.model
      if (!m) return
      const pos = cellPos(r, c)

      if (m.expand_type && !m.ds && !m.expand_expr) {
        out.push(`${pos}：设了扩展方向却没有数据集（也没写 expand_expr），展开不出东西`)
      }
      if (m.expand_type && !m.field && !m.expand_expr && !m.value_expr) {
        out.push(`${pos}：扩展格没有字段也没有表达式`)
      }

      for (const [key, ref] of [
        ['左主格 row_parent', m.row_parent],
        ['上主格 col_parent', m.col_parent],
      ] as const) {
        if (!ref) continue
        const p = parsePos(ref)
        if (!p) {
          out.push(`${pos}：${key} "${ref}" 不是合法位置名`)
          continue
        }
        if (p.r === r && p.c === c) {
          out.push(`${pos}：${key} 指向自己`)
          continue
        }
        const target = at(p.r, p.c)
        if (!target?.model) {
          out.push(`${pos}：${key} 指向 ${ref}，但那一格没有数据模型`)
        }
      }

      // 主格成环：A3←B3←A3 会让展开停不下来
      const seen = new Set<string>([pos])
      let cur = m.row_parent
      let hops = 0
      while (cur && hops++ < 64) {
        if (seen.has(cur)) {
          out.push(`${pos}：左主格链成环（${[...seen, cur].join(' → ')}）`)
          break
        }
        seen.add(cur)
        const p = parsePos(cur)
        cur = p ? at(p.r, p.c)?.model?.row_parent : undefined
      }
    })
  })

  // 合并块检查：越界 / 交叠。手写 JSON 绕过了 setGridMerge 的守卫，这里兜一遍。
  const seenMerges: Array<{ r: number; c: number; rows: number; cols: number }> = []
  sheet.rows?.forEach((row, r) => {
    row.cells?.forEach((cell, c) => {
      const s = mergeSpanOf(cell)
      if (s.rows === 1 && s.cols === 1 && !s.toEnd) return
      const cols = s.toEnd ? Math.max(1, (row.cells?.length ?? 0) - c) : s.cols
      const endR = r + s.rows - 1
      const endC = c + cols - 1
      const pos = cellPos(r, c)
      if (endR > (sheet.rows?.length ?? 0) - 1) {
        out.push(`${pos}：合并跨到第 ${endR + 1} 行，但模板只有 ${sheet.rows?.length ?? 0} 行`)
      }
      if (!s.toEnd && endC > (row.cells?.length ?? 0) - 1) {
        out.push(`${pos}：合并跨到第 ${endC + 1} 列，但这一行只有 ${row.cells?.length ?? 0} 列`)
      }
      for (const m of seenMerges) {
        if (r <= m.r + m.rows - 1 && m.r <= endR && c <= m.c + m.cols - 1 && m.c <= endC) {
          out.push(`${pos} 与 ${cellPos(m.r, m.c)} 的合并区域交叠`)
          break
        }
      }
      seenMerges.push({ r, c, rows: s.rows, cols })
    })
  })

  return [...new Set(out)]
}

/**
 * 模板网格 → Univer 工作簿数据（**设计态**，与展开结果的 toWorkbookData 区分开）。
 *
 * 这里只是「把每格的模板文本摆进格子」，不做任何展开。扩展格用底色标出来，
 * 因为 `=ds1.city` 和字面量「城市」在格子里长得几乎一样，不标根本分不清。
 */
/** 主格树的一个节点。 */
export interface TplNode {
  pos: string
  /** 格子里显示的文本（`formatCellText` 的结果，可能是 `=ds1.city`） */
  text: string
  expand: 'r' | 'c' | ''
  /** 主格指向的格没有 model —— 关系悬空（模板体检会另行报警） */
  orphan?: boolean
  /** 主格链成环，只能当根挂出来 */
  cycle?: boolean
  children: TplNode[]
}

/**
 * 把网格按 `row_parent` 组织成**主格树**（森林）。
 *
 * 为什么需要它：主格是「关系」不是「属性」，而 Univer 只画底色 + 字色两个通道
 * （`bd` / `ul` 实测画不出来，见上文），两个通道已经给了扩展方向和内容来源 ——
 * **格子里根本没有第三个通道能静态表达关系**，之前只能做成「选中时点亮」。
 * 关系本质是树，树不必画在格子里：常显一棵树，一眼看到整张模板的层次。
 *
 * 只收**带 model 的格**：字面量标题（"2026 年销售汇总"）不属于任何主格链，
 * 混进来只是噪音。
 *
 * 两种异常情况都不会让节点凭空消失：
 * - 主格成环 → 谁都不是根、也从任何根走不到，拎出来当根并标 `cycle`；
 * - 主格指向没有 model 的格 → 当根并标 `orphan`（`validateTemplate` 会报警）。
 */
export function parentTreeOf(grid: TemplateGrid): TplNode[] {
  const nodes: Array<{ pos: string; cell: CellTpl }> = []
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.model) nodes.push({ pos: cellPos(r, c), cell })
    }),
  )
  const byPos = new Map(nodes.map((n) => [n.pos, n]))
  const parentOf = (n: { pos: string; cell: CellTpl }): string | null => {
    const p = n.cell.model?.row_parent
    if (!p || p === n.pos) return null
    return byPos.has(p) ? p : null
  }

  const kids = new Map<string, string[]>()
  const roots: string[] = []
  for (const n of nodes) {
    const p = parentOf(n)
    if (p) {
      const arr = kids.get(p)
      if (arr) arr.push(n.pos)
      else kids.set(p, [n.pos])
    } else {
      roots.push(n.pos)
    }
  }

  // 成环的节点不在 roots 里，也从任何根都走不到 —— 不拎出来就整棵消失
  const reached = new Set<string>()
  const stack = [...roots]
  while (stack.length) {
    const p = stack.pop() as string
    if (reached.has(p)) continue
    reached.add(p)
    for (const k of kids.get(p) ?? []) stack.push(k)
  }
  const cycleRoots = nodes.filter((n) => !reached.has(n.pos)).map((n) => n.pos)

  const build = (pos: string, path: Set<string>): TplNode => {
    const n = byPos.get(pos) as { pos: string; cell: CellTpl }
    const nextPath = new Set(path).add(pos)
    const m = n.cell.model
    const declared = n.cell.model?.row_parent
    return {
      pos,
      text: formatCellText(n.cell),
      expand: m?.expand_type === 'r' ? 'r' : m?.expand_type === 'c' ? 'c' : '',
      ...(declared && declared !== pos && !byPos.has(declared) ? { orphan: true } : {}),
      children: (kids.get(pos) ?? [])
        // 环：路径里出现过的不再展开，否则无限递归
        .filter((k) => !nextPath.has(k))
        .map((k) => build(k, nextPath)),
    }
  }

  return [
    ...roots.map((p) => build(p, new Set())),
    ...cycleRoots.map((p) => ({ ...build(p, new Set()), cycle: true })),
  ]
}

/** Univer 单元格数据。`t` 是 `CellValueType`，模板里只会用到 4（FORCE_STRING）。 */
type UniverCell = { v: string; s?: string; t?: number }

export function gridToWorkbookData(grid: TemplateGrid, opts: { selected?: string }= {}) {
  const cellData: Record<number, Record<number, UniverCell>> = {}
  const mergeData: Array<{
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
  }> = []
  // 语义样式按需注册：只把**实际用到**的组合放进 styles，避免堆一堆用不上的
  const semStyles: Record<string, Record<string, unknown>> = {}
  const parentPos = opts.selected ? parentPositionsOf(grid, opts.selected) : new Set<string>()
  grid.forEach((row, r) => {
    row.forEach((cell, c) => {
      const text = formatCellText(cell)
      const pos = cellPos(r, c)
      const anchor = isMergeAnchor(cell)
      // 图片格在 Univer 网格里画不出图（它的样式通道只有底色 + 字色），
      // 而 `from: value` 的图片格 text 是空的 —— 不补个占位文字的话，
      // 这格在模板网格里完全看不见，作者会以为「设了没反应」。
      // 真图在右侧属性面板的缩略图、以及服务端出的 HTML 预览（`<img>`）里。
      //
      // **两处都要看**：`CellTpl.image`（手写模板 / 导入）与 `CellModel.image`
      //（设计器面板写的就是这个，服务端也是 `cell.image.or(model.image)`）。
      // 只看 `cell.image` 的话，面板里设的图在网格里仍然看不见 —— 实测踩过。
      const hasImage = !!(cell.image || cell.model?.image)
      const shown = hasImage && !text ? IMAGE_CELL_TEXT : text
      // 合并锚点即使没文字也要占一格：否则 Univer 可能把它当成未合并区域。
      // 扩展格同理 ——「这一格会长」正是最该被看见的语义，若因为没文字就整格不输出，
      // 底色标记根本画不出来，等于没标。
      if (!shown && !anchor && !cell.model?.expand_type) return
      cellData[r] = cellData[r] || {}
      let s: string | undefined
      if (pos === opts.selected) s = SELECTED_STYLE_ID
      else if (parentPos.has(pos)) s = PARENT_STYLE_ID
      else {
        const sem = semanticStyleOf(cell)
        if (sem) {
          s = sem.id
          semStyles[sem.id] = sem.style
        }
      }
      cellData[r][c] = { v: shown, t: shown ? 4 : undefined, ...(s ? { s } : {}) }
      // `t: 4` 是 Univer `CellValueType.FORCE_STRING`：强制把单元格当字符串，
      // 阻止 Univer 看到 `v` 以 `=` 开头就把它挪到 `f` 字段当公式处理。
      // 我们用 `=ds1.city` / `=D3[B3:+0].sum()` 当 NopReport DSL 模板语法，
      // 公式引擎没装，被当公式后会变成 `{f:'=...', v:null}` → 单元格静默空白。

      const span = mergeSpanOf(cell)
      const cols = span.toEnd ? Math.max(1, row.length - c) : span.cols
      if (span.rows > 1 || cols > 1) {
        mergeData.push({
          startRow: r,
          endRow: r + span.rows - 1,
          startColumn: c,
          endColumn: c + cols - 1,
        })
      }
    })
  })

  const columnCount = grid.reduce((m, r) => Math.max(m, r.length), 0)
  return {
    id: 'grid-template',
    name: '模板',
    sheetOrder: ['sheet1'],
    styles: {
      // 注意：这里**不要**加 `bd` 边框 —— Univer 画不出来，加了只是自欺
      // （实测见上面《Univer 实际能画什么》）。选中态靠 Univer 自己的选区光框，
      // 主格靠底色，两条路都实测有效。
      [SELECTED_STYLE_ID]: { bl: 1, bg: { rgb: '#D6E4FF' } },
      [PARENT_STYLE_ID]: { bl: 1, bg: { rgb: PARENT_HIGHLIGHT } },
      ...semStyles,
    },
    sheets: {
      sheet1: {
        id: 'sheet1',
        name: '模板',
        rowCount: Math.max(grid.length, 50),
        columnCount: Math.max(columnCount, 12),
        cellData,
        mergeData,
      },
    },
  }
}

/**
 * 打开「导出公式」：给所有带 `value_expr` 的格打上 `export_formula`。
 *
 * 做成后处理而不是改三个构造器：构造器里小计 / 合计 / 总计的格散落多处，
 * 逐个加参数会污染签名；而「要不要公式」本身是个整体开关，统一套一层更清楚。
 */
export function withExportFormula(tpl: ReportTemplate, on = true): ReportTemplate {
  if (!on) return tpl
  return {
    ...tpl,
    sheets: tpl.sheets.map((s) => ({
      ...s,
      rows: s.rows.map((r) => ({
        cells: r.cells.map((c) => {
          const m = c.model
          if (!m?.value_expr) return c
          return { ...c, model: { ...m, export_formula: true } }
        }),
      })),
    })),
  }
}

/**
 * 分页配置：写进**每张** sheet 的 `page`。
 *
 * 与服务端 `store::apply_options` 里那段逐字对应（「分页：写进每个 sheet 的 page」）——
 * 打开已保存报表时服务端按 `options.rowsPerPage` 套一次，实时渲染这条路
 * 必须在这里套一次，否则同一个开关「存下来执行」生效、「直接渲染」不生效。
 *
 * 做成后处理而不是改三个构造器：`GroupTemplateOptions.page` /
 * `CrossTemplateOptions.page` 都声明了却没人用，交叉表那条路还把 `page`
 * 传进来又被构造器丢掉。收敛到一个函数里语义只有一处，Rust 侧改了这边不会漂。
 * 另外构造器在后处理**之前**跑，`page` 也就不会混进 `rawTemplate` 存盘 ——
 * 存盘只存开关（`options.rowsPerPage`），由服务端再套，与
 * `withExportFormula` / `withExpandControl` 同一套约定。
 *
 * `rows_per_page` 兜底为 1：服务端的 `is_paginated` 要求它 > 0，
 * 给 0 会静默退化成「不分页」，开关看着像没生效。
 */
export function withPage(tpl: ReportTemplate, page?: PageConfig | null): ReportTemplate {
  if (!page) return tpl
  const cfg: PageConfig = {
    rows_per_page: Math.max(1, Math.floor(page.rows_per_page ?? 1)),
    repeat_header_rows: Math.max(0, Math.floor(page.repeat_header_rows ?? 0)),
    repeat_footer_rows: Math.max(0, Math.floor(page.repeat_footer_rows ?? 0)),
  }
  return { ...tpl, sheets: tpl.sheets.map((s) => ({ ...s, page: cfg })) }
}

/**
 * 循环变量：按该字段的**不同取值**把 sheet 复制成 N 张（一个客户一张表）。
 *
 * 空值 / 空串 / 全空白表示不开循环 —— **原样返回，不写字段**，
 * 这样存盘文件里不会留一个空字符串的 `loop_field`。
 *
 * 打在**每张** sheet 上：本设计器一次只出一张表，多 sheet 的情况
 * （导入 xlsx 得来的模板另说）交到这里时，语义就是「这些表都按这个字段循环」。
 */
export function withLoopField(tpl: ReportTemplate, loopField?: string | null): ReportTemplate {
  const f = (loopField ?? '').trim()
  if (!f) return tpl
  return {
    ...tpl,
    sheets: tpl.sheets.map((s) => ({ ...s, loop_field: f })),
  }
}

/**
 * 展开控制：最少条数 / 最多条数 / 空数据集时是否保留。
 *
 * 三个属性**打在不同层级上**，这是本函数存在的唯一理由：
 *
 * - `minCount`（补空行）→ **最内层**行展开格。
 *   「每组至少留 5 行」说的是明细级，打在外层会变成「至少 5 个分组」。
 * - `maxCount`（只显示前 N 条）→ **最外层**行展开格。
 *   「TOP 10」说的是分组数；打在明细级会变成「每个分组只显示前 10 行」。
 * - `keepEmpty` → **所有**行展开格。逐级保留是想要的：空报表也要有一行空行撑着表头。
 *
 * 为什么不能一律打在所有行展开格上：分组模板里每个分组格都带 `expand_type:'r'` 且用
 * `row_parent` 链式嵌套，逐级生效会让条数相乘——2 级分组 + 最少 5 行 = 至少 25 行。
 *
 * 层级的判定靠位置名：`cell()` 不写 `pos`（由服务端按行列下标推断），但构造器写
 * `row_parent` 时用的就是 `cellPos()`，所以这里用同一个函数把位置补算回来再比对。
 */
export interface ExpandControl {
  /** 展开条数下限：不足时补空行。0 / undefined = 不限制 */
  minCount?: number
  /** 展开条数上限：只显示前 N 条。0 / undefined = 不限制 */
  maxCount?: number
  /** 展开集为空时保留该格（缺省会连同子格一起删除） */
  keepEmpty?: boolean
}

export function withExpandControl(tpl: ReportTemplate, ctl: ExpandControl): ReportTemplate {
  const min = ctl.minCount && ctl.minCount > 0 ? ctl.minCount : undefined
  const max = ctl.maxCount && ctl.maxCount > 0 ? ctl.maxCount : undefined
  const keep = ctl.keepEmpty ? true : undefined
  if (min === undefined && max === undefined && keep === undefined) return tpl

  return {
    ...tpl,
    sheets: tpl.sheets.map((sheet) => {
      // 先扫一遍：收集行展开格的位置，以及「谁被别的行展开格认作父格」
      const expandPos = new Set<string>()
      const childOf = new Set<string>()
      sheet.rows.forEach((row, ri) => {
        row.cells.forEach((c, ci) => {
          if (c.model?.expand_type !== 'r') return
          expandPos.add(cellPos(ri, ci))
          if (c.model.row_parent) childOf.add(c.model.row_parent)
        })
      })

      return {
        ...sheet,
        rows: sheet.rows.map((row, ri) => ({
          cells: row.cells.map((c, ci) => {
            const m = c.model
            if (m?.expand_type !== 'r') return c
            const pos = cellPos(ri, ci)
            const isOutermost = !m.row_parent || !expandPos.has(m.row_parent)
            const isInnermost = !childOf.has(pos)
            const next: CellModel = {
              ...m,
              expand_min_count: isInnermost ? min : undefined,
              expand_max_count: isOutermost ? max : undefined,
              keep_expand_empty: keep,
            }
            return { ...c, model: next }
          }),
        })),
      }
    }),
  }
}
