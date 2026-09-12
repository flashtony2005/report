/**
 * 控件协议类型 —— 《OpenPrint-设计方案.md》§5.2 ~ §5.8 / §5.14
 *
 * 所有几何字段（left/top/width/height）单位与 page.unit 一致（默认 mm），
 * 坐标原点为所属 Section 左上角；设计器画布层负责 mm ⇄ px 换算（core/units.ts）。
 */

import type { ChartKind, ChartSeries, ChartOptions } from '../core/chartkit/types'

export type ControlType =
  | 'text'
  | 'image'
  | 'table'
  | 'barcode'
  | 'qrcode'
  | 'richtext'
  | 'rect'
  | 'line'
  | 'chart'
  | 'math'
  | 'signature'
  | 'zone'
  | 'labelgrid'

/** 全部控件的公共基座（§5.4a：printable 为通用属性） */
export interface ControlBase {
  /** 控件唯一 ID（utils/id.ts 生成） */
  id: string
  type: ControlType
  /** 相对所属 Section 左上角 */
  left: number
  top: number
  width: number
  height: number
  /** 旋转角度（度） */
  angle?: number
  /** 不打印开关：false 时渲染期跳过，设计画布仍显示（默认 true） */
  printable?: boolean
  /** 条件渲染表达式，如 "data.vip === true"（§5.6） */
  visibleIf?: string
  /** 锁定：设计期禁止移动/缩放 */
  locked?: boolean
  /** 图层名（图层面板显示用，默认取类型+序号） */
  name?: string
  /** 常驻辅助线：开启后该元素 4 条边界辅助线始终显示（不限于拖拽时） */
  showGuides?: boolean
  /**
   * 所属标签网格（labelgrid）controlId：作为其「首卡子组件」存在。
   * 仅设计期内部标记（画布序列化回环用），协议渲染时被 expandLabelGrids 摊平，不参与输出。
   */
  childOf?: string
}

/* ---------------------------------- 文本 ---------------------------------- */

export interface TextStyle {
  /** 字号（pt） */
  fontSize?: number
  /** 字体颜色 hex / rgba */
  fill?: string
  fontFamily?: string
  fontWeight?: 'normal' | 'bold'
  /** 斜体：'italic' 开启，'normal' 或不写为常规 */
  fontStyle?: 'normal' | 'italic'
  /** 下划线：'underline' 开启，'none' 或不写为无 */
  textDecoration?: 'none' | 'underline'
  /** 控件内文字水平对齐（协议不放 verticalAlign，见 §5.2 警告） */
  textAlign?: 'left' | 'center' | 'right'
  /** 行高倍率 */
  lineHeight?: number
  /** 字间距（pt） */
  letterSpacing?: number
}

export interface TextControl extends ControlBase {
  type: 'text'
  /**
   * 内容类型判别（显式三态）：
   * - 'fixed'      固定值（value 文本，可含手敲 {{}}）
   * - 'variable'   字段绑定（binding 路径）
   * - 'expression' 表达式（expression 字段，支持 {{...}} / 内置函数）
   * 老模板无此字段时，渲染端按 expression > binding > value 启发式回退（见 data-binder.resolveTextValue）。
   */
  contentType?: 'fixed' | 'variable' | 'expression'
  /** 静态文本（与 binding/expression 三选一） */
  value?: string
  /** 字段绑定路径，如 "customer.name" */
  binding?: string
  /** mustache 表达式，如 "{{order.total | currency:'CNY'}}" */
  expression?: string
  /** 绑定字段的取值格式（仅 binding 模式生效；expression 模式请用 {{field | date:'...'}} 过滤器） */
  format?: CellFormat
  style?: TextStyle
}

/* ---------------------------------- 图片 ---------------------------------- */

export type ImageValueMode = 'inline' | 'url' | 'asset' | 'binding'

export interface ImageControl extends ControlBase {
  type: 'image'
  value?: {
    /** inline=Base64 内联 / url=外部 URL / asset=本地托管资源 / binding=绑定字段 */
    mode: ImageValueMode
    /** mode=binding 时为字段路径；否则为内容本体 */
    content: string
  }
  /** 填充方式 */
  fit?: 'contain' | 'cover' | 'fill' | 'none'
  /** 圆角（px，Fabric rx/ry） */
  cornerRadius?: number
}

/* ---------------------------------- 表格 ---------------------------------- */

export type HAlign = 'left' | 'center' | 'right'

/**
 * 单元格样式 —— 表头 / 数据 / 静态单元格通用。
 * 优先级：单元格样式 > 列样式(TableColumn.style) > 表格默认样式(options.defaultCellStyle)。
 */
export interface TableCellStyle {
  /** 字号（pt） */
  fontSize?: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** 文字颜色 hex / rgba */
  color?: string
  /** 水平对齐 */
  align?: HAlign
  /** 垂直对齐 */
  valign?: 'top' | 'middle' | 'bottom'
  /** 单元格填充色 */
  backgroundColor?: string
  /** 单元格斜线（课表角标等场景）：none=无 / down=左上→右下 / up=左下→右上 */
  diagonal?: 'none' | 'down' | 'up'
}

/**
 * 单元格数据格式 —— 绑定字段/表达式的显示格式（非技术用户无需手写 `{{field | date:'...'}}`）。
 * 复用引擎内置格式化器（date/number/currency/percent），UI 在属性面板与单元格工具栏提供可视化选择。
 * 优先级：单元格 format > 列 format > 无（默认 stringify）。
 */
export type CellFormatKind =
  | 'none' // 不格式化（默认）
  | 'text' // 纯文本（等同 none，语义化占位）
  | 'date' // 日期，按 pattern 模板（YYYY-MM-DD / YYYY年MM月DD日 / MM/DD/YYYY ...）
  | 'int' // 整数（默认带千分位）
  | 'decimal' // 定点小数，digits 位（默认 2，带千分位）
  | 'currency' // 货币，code 币种 + digits 位（默认 CNY / 2 位 / 千分位）
  | 'percent' // 百分比，digits 位（默认 2）

export interface CellFormat {
  kind: CellFormatKind
  /** date：日期模板，如 'YYYY-MM-DD' / 'YYYY年MM月DD日' / 'MM/DD/YYYY' */
  pattern?: string
  /** int/decimal/currency/percent：小数位数（0~6） */
  digits?: number
  /** currency：币种代码（CNY/USD/EUR/GBP/HKD/JPY...） */
  code?: string
  /** int/decimal/currency：是否加千分位（默认 true）；false 走不分组定点 */
  thousands?: boolean
}

export interface TableColumn {
  title: string
  /** 数据字段名（与 expression 二选一） */
  field?: string
  /** 行表达式，如 "{{rowIndex + 1}}" / "{{row.price * row.qty}}" */
  expression?: string
  /** 列宽（page.unit） */
  width: number
  /** 单元格内容水平对齐 */
  align?: HAlign
  /** 表头文字对齐（默认跟随 align） */
  headerAlign?: HAlign
  cellBackgroundColor?: string
  headerBackgroundColor?: string
  /** 单元格内边距（mm，默认 4） */
  cellPadding?: number
  /** 该列数据单元格的默认样式（被单元格样式覆盖） */
  style?: TableCellStyle
  /** 该列数据单元格的默认显示格式（被单元格 format 覆盖） */
  format?: CellFormat
  /**
   * 是否参与尾行合计（本页合计 / 总计）。
   * - 未设置：由字段类型 / 数据采样推断（数值列参与）。
   * - true / 'sum' / 'avg' / 'count'：强制参与。
   * - false：强制不参与（如名称、备注等字符串列）。
   */
  aggregate?: boolean | 'sum' | 'avg' | 'count'
}

/**
 * 单元格模型 —— 设计期可双击编辑的最小单元。
 * 数据表：前 headerRows 行为表头（静态），第 headerRows 行为数据样例行（模板，应用到整列），
 * 其后 staticRows 行为静态尾行（合计 / 备注等）。
 * 布局网格（无 dataSource）：全部 designRows 行均为静态内容。
 */
export interface TableCell {
  /**
   * 内容类型判别（显式三态，与文本控件一致）：
   * - 'fixed'      固定文字（text）
   * - 'variable'   字段绑定（field 路径）
   * - 'expression' 表达式（expression，支持 {{...}} / 内置函数）
   * 老模板无此字段时，渲染端按 expression > field > text 启发式回退（见 table-engine.cellTextMode）。
   */
  contentType?: 'fixed' | 'variable' | 'expression'
  /** 静态文字（无数据时显示 / 设计期占位） */
  text?: string
  /** 字段绑定路径（数据源数组元素的字段），优先级高于 text */
  field?: string
  /** 行表达式，如 "{{row.price * row.qty}}" */
  expression?: string
  /** 单元格样式（覆盖列 / 表格默认样式） */
  style?: TableCellStyle
  /** 单元格显示格式（覆盖列 format） */
  format?: CellFormat
  /** 跨列数（含本列，≥2 时合并右侧单元格） */
  colSpan?: number
  /**
   * 跨行数（含本行，≥2 时合并下方单元格）。
   * 仅表头 / 静态 / 布局网格行生效；数据行的"数据样例行（模板）"不跨行——数据行由运行期逐条
   * 生成，跨行会跨越不同数据记录，语义不成立，故引擎对该行强制 rowSpan=1。
   */
  rowSpan?: number
}

/** 表格样式预设（Excel 式快速切换；渲染端把同名 class 挂在 <table> 上，CSS 见 css-generator.ts） */
export type TableStylePreset =
  | 'none'
  | 'header'
  | 'header-dark'
  | 'header-green'
  | 'zebra'
  | 'zebra-blue'
  | 'zebra-gray'
  | 'three-segment'
  | 'banded-cols'
  | 'grid'
  | 'minimal'
  | 'report'
  | 'timetable'

export interface TableOptions {
  /** 每页打印标题行（默认 true） */
  repeatHeader?: boolean
  /** 每页打印合计行/表尾（默认 true；false 则只在最后一页） */
  repeatFooter?: boolean
  /** 每页行数：数字强制固定 / "auto" 由引擎按可用高度计算（默认 auto） */
  pageRows?: number | 'auto'
  rowHeightMode?: 'auto' | 'fixed'
  /** 固定行高（mm），仅 rowHeightMode=fixed 生效 */
  rowHeight?: number
  /** 整行跨页时换至下一页（默认 false） */
  keepTogether?: boolean
  /** 数据行全空时跳过不打印（默认 false） */
  skipEmptyRows?: boolean
  /** 多单合并打印（默认 false，§9.2.1a） */
  mergeSheets?: boolean
  /** 斑马纹（默认 false） */
  striped?: boolean
  /** 单元格内容垂直对齐（渲染引擎实现，默认 middle） */
  verticalAlign?: 'top' | 'middle' | 'bottom'
  /** 边框：all / none / horizontal / outline / three-line（三线表：顶线 + 表头底线 + 底线，无内部/竖线） */
  borders?: 'all' | 'none' | 'horizontal' | 'outline' | 'three-line'
  /** 表格样式预设（默认 none = 仅边框 + 表头加粗，无任何背景色，含标题行） */
  tableStyle?: TableStylePreset
  /** 整表默认单元格样式（被列 / 单元格样式覆盖） */
  defaultCellStyle?: TableCellStyle
  summaryRow?: {
    type: 'sum' | 'count' | 'custom'
    /** 聚合列（列 field 清单） */
    fields?: string[]
    /** 合计行标签（默认「合计」）；type=custom 且无 fields 时此标签前的单元格放置计算结果 */
    label?: string
    /**
     * 自定义合计（type=custom）单表达式兜底：求值作用域含预计算的
     * `sum`/`avg`（按列 field 聚合后的数值）、`rows`（当前分组行）、`allRows`（整表行）。
     * 例如 `"sum.amount - sum.discount"`。
     */
    expression?: string
    /** 自定义合计：字段 → 专属表达式，优先级高于 `expression` */
    expressions?: Record<string, string>
    /** 分组小计标签模板，用 `${key}` 占位分组值（默认 "${key} 小计"） */
    subtotalLabel?: string
    /** 分组小计行样式（覆盖默认加粗 + 浅灰底；被单元格样式再覆盖） */
    subtotalStyle?: TableCellStyle
  }
}

export interface TableControl extends ControlBase {
  type: 'table'
  /** 数据源数组路径；为空则为布局网格（空白表格） */
  dataSource?: string
  /**
   * 表格自带内嵌数据行（导入数据场景）。当 dataSource 为空但有 data 时，
   * 引擎直接以 data 作为数据行并自动分页，从而与「数据源字段绑定」彻底解耦。
   */
  data?: Array<Record<string, unknown>>
  columns: TableColumn[]
  options?: TableOptions
  /** 分组字段（§5.5） */
  groupBy?: string
  summary?: Array<{ type: 'sum' | 'count'; field: string; label?: string }>
  /**
   * 设计期单元格网格（行优先 [row][col]）。**运行期打印同样以它为内容与样式真理源**。
   * - 数据表：长度 = headerRows + 1(数据样例行) + staticRows，行与可视行 1:1 对应。
   * - 布局网格（无 dataSource）：长度 = headerRows + designRows。
   * 未设置时由列配置瞬时推导（buildDesignGrid），因此老模板行为完全不变。
   */
  cells?: TableCell[][]
  /** 表头行数（默认：有列标题 → 1，否则 0） */
  headerRows?: number
  /** 静态尾行数（合计 / 备注，置于数据行之后；默认 0） */
  staticRows?: number
  /** 布局网格正文行数（**不含表头**；默认由控件高度推算） */
  designRows?: number
}

/* ------------------------------- 条码 / 二维码 ------------------------------ */

export interface BarcodeControl extends ControlBase {
  type: 'barcode'
  /**
   * 内容类型判别（显式三态，与文本一致）：fixed=value / variable=binding / expression=expression。
   * 老模板无此字段时按 binding > value 启发式回退（见 data-binder.resolveCodeText）。
   */
  contentType?: 'fixed' | 'variable' | 'expression'
  /** 字段绑定路径（variable 模式） */
  binding?: string
  /** 静态编码内容（fixed 模式，可含 {{}} 插值） */
  value?: string
  /** 表达式（expression 模式），如 "{{order.orderNo}}" / "{{now() | date:'YYYYMMDD'}}" */
  expression?: string
  /** bwip-js bcid，如 CODE128 / EAN13 */
  format?: string
  /** 是否显示文字 */
  showText?: boolean
}

export interface QrcodeControl extends ControlBase {
  type: 'qrcode'
  /**
   * 内容类型判别（显式三态，与文本一致）：fixed=value / variable=binding / expression=expression。
   * 老模板无此字段时按 binding > value 启发式回退（见 data-binder.resolveCodeText）。
   */
  contentType?: 'fixed' | 'variable' | 'expression'
  /** 字段绑定路径（variable 模式） */
  binding?: string
  /** 静态编码内容（fixed 模式，可含 {{}} 插值） */
  value?: string
  /** 表达式（expression 模式） */
  expression?: string
  /** 纠错级别 L/M/Q/H */
  errorLevel?: 'L' | 'M' | 'Q' | 'H'
}

/* --------------------------------- 形状 ---------------------------------- */

export interface RectControl extends ControlBase {
  type: 'rect'
  fill?: string
  stroke?: string
  strokeWidth?: number
  /** 统一圆角（px）；若四角独立值中有任意一项被显式设置，则统一值让位于该独立值 */
  cornerRadius?: number
  /** 四角独立圆角（px），分别覆盖 cornerRadius 的对应角；未设置时回落到 cornerRadius */
  cornerRadiusTL?: number
  cornerRadiusTR?: number
  cornerRadiusBR?: number
  cornerRadiusBL?: number
  /** 形状：矩形 / 圆形（圆形由画布 Ellipse + 渲染 border-radius:50% 实现） */
  shape?: 'rect' | 'circle'
  /** 虚线模式（如 [6,4] 表示 6px 实线 4px 间隔） */
  strokeDashArray?: number[]
}

export interface LineControl extends ControlBase {
  type: 'line'
  stroke?: string
  strokeWidth?: number
  /** 虚线模式 */
  strokeDashArray?: number[]
}

/* -------------------------------- 富文本 --------------------------------- */

export interface RichTextControl extends ControlBase {
  type: 'richtext'
  /** HTML 内容（注入前必须 DOMPurify 消毒） */
  value?: string
}

/* --------------------------------- 图表 ---------------------------------- */

/**
 * ChartControl（原生 SVG 图表控件）：零依赖手写 SVG（src/core/chartkit）。
 * 整张图是矢量，导出 PDF/SVG 与表格/文本同走"设计即打印"链路。
 * 数据全部可序列化进设计文件（kind / categories / series / options）。
 */
export interface ChartControl extends ControlBase {
  type: 'chart'
  /** 图表类型：条形 bar / 折线 line / 饼图 pie */
  kind: ChartKind
  /** 类目轴标签（条形/折线为 x 轴；饼图为扇区名） */
  categories: string[]
  /** 数据序列；饼图通常只取 series[0] 的每个数据点作为一个扇区 */
  series: ChartSeries[]
  /** 外观选项（标题、图例、坐标轴、配色、平滑/面积/环形等） */
  options?: ChartOptions
}

/* --------------------------------- 公式 ---------------------------------- */

/**
 * MathControl（LaTeX 数学公式控件）：基于 KaTeX 渲染。
 *
 * KaTeX 渲染产物为 HTML + Web Fonts（非 SVG）。设计期由 MathViewLayer.vue overlay
 * 直接渲染 KaTeX HTML（屏幕矢量清晰）；导出 PDF 走和图表同一套栅格化路径（3× 高清
 * 位图，与正文字体同链路），公式与其他控件同页位图化——简单可靠不糊。
 *
 * 序列化只存 latex 源码 + displayMode + 字号/颜色，恢复后由 KaTeX 重渲染。
 */
export interface MathControl extends ControlBase {
  type: 'math'
  /** LaTeX 源码，如 `c = \\pm\\sqrt{a^2 + b^2}` */
  latex: string
  /** 显示模式：true=块级独立行公式（$$...$$），false=行内公式（$...$） */
  displayMode?: boolean
  /** 字号（pt），默认 16 */
  fontSize?: number
  /** 字体颜色 hex / rgba，默认 #000000 */
  color?: string
}

/* --------------------------------- 签名 ---------------------------------- */

/**
 * SignatureControl（手写签名控件）：基于弹出式手写画板（WPS 式）。
 *
 * 签名是**位图**（用户笔迹无法矢量还原），序列化为 PNG data-URI（内联自包含），
 * 复用图片的渲染/导出链路（栅格化，与正文同质量保证清晰）。只存笔迹 src +
 * 画笔粗细 penWidth + 笔色 color（元数据，方便属性面板回显与「重新签名」）。
 * 控件宽高 = 笔迹实际包围盒（mm），保证插入后不变形。
 */
export interface SignatureControl extends ControlBase {
  type: 'signature'
  /** 手写笔迹 PNG（data:image/png;base64,…），内联自包含离线可用 */
  src: string
  /** 画笔粗细（px，仅作回显 / 重新签名默认值） */
  penWidth?: number
  /** 笔色 hex，默认 #000000 */
  color?: string
}

/* ------------------------------ 页眉页脚区域 ------------------------------- */

/**
 * ZoneControl（§5.14）：画布上的"可编辑色带"，序列化目标是
 * document.page.sections 里的 header/footer 区块，**不得**混入 body.components。
 * 单例：每页最多一个 header + 一个 footer。
 */
export interface ZoneControl extends ControlBase {
  type: 'zone'
  zone: 'header' | 'footer'
  /** 高度（page.unit），回写 section.height */
  zoneHeight: number
  /** 每页重复（默认 true） */
  repeat?: boolean
  /** 子组件（坐标相对色带左上角） */
  children: AnyControl[]
}

/* ------------------------------ 标签网格（多列重复） ------------------------------ */

/**
 * LabelGridControl（标签网格 / 多列重复控件）——《OpenPrint-设计方案》新增。
 *
 * **纯布局组件**：一张纸上平铺很多张相同的「标签卡」（地址标签、资产贴纸、价签等）。
 * 它只负责把「一张卡片模板」（children）按 列数 × 行数 重复平铺、跨页自洽；
 * **本身不带数据源**——每张卡要印什么数据，由放进卡片里的「其他数据组件」负责
 * （数据源是其他组件的事）。
 *
 * 设计：用户在画布上正常设计「一张卡片」（含图片/文本/条码/二维码等），框选这组控件
 * →「转为标签网格」，坐标被归一到卡片左上角，生成本控件。也可从控件库拖入空网格后
 * 再把组件放进去。行数由容器高度推导（属性面板「行数」即总重复行数）。
 */
export interface LabelGridControl extends ControlBase {
  type: 'labelgrid'
  /** 每行列数（>=1），默认 3 */
  columns?: number
  /** 卡片水平间距（mm），默认 2 */
  gapX?: number
  /** 卡片垂直间距（mm），默认 2 */
  gapY?: number
  /** 卡片宽（mm）；缺省由 width 与列数/间距推算 */
  cardWidth?: number
  /** 卡片高（mm）；缺省由 children 包围盒推算 */
  cardHeight?: number
  /** 是否显示网格参考线（容器 + 卡片边框）。关闭后只留卡片底色，得到干净的无框标签纸。默认 true */
  showLines?: boolean
  /** 网格线线型：'solid' 实线（默认）| 'dashed' 虚线。仅在 showLines 为真时生效 */
  lineStyle?: 'solid' | 'dashed'
  /** 卡片模板：相对卡片左上角定位的子控件（绝对 mm，坐标已归一化） */
  children: AnyControl[]
  /**
   * 可选逐卡数据源：数据根对象上的**数组路径**（如 `items`）。
   * 配置后：卡片总数跟随数据条数（每数据一条卡，跨页自洽），每张卡注入行上下文
   * `{ row, rowIndex }`，卡内控件可绑定 `{{row.字段}}` / `{{rowIndex + 1}}`
   * → 每卡流水号/条码/二维码各不相同。缺省 = 纯布局平铺（每卡相同）。
   */
  dataSource?: string
}

/* --------------------------------- 联合 ---------------------------------- */

export type AnyControl =
  | TextControl
  | ImageControl
  | TableControl
  | BarcodeControl
  | QrcodeControl
  | RectControl
  | LineControl
  | RichTextControl
  | ChartControl
  | MathControl
  | SignatureControl
  | ZoneControl
  | LabelGridControl

