/**
 * Layout Engine 内部页面模型 —— 《OpenPrint-设计方案.md》§7.3 的类型化扩展
 *
 * 设计要点：
 * 1. 引擎内部一律用 **mm** 参与排版（协议层 in/pt 在入口换算，见 core/units.ts）。
 * 2. 输出是「已定位、已绑定、已测量」的纯数据，不含任何 DOM / Fabric 依赖，
 *    因此 renderer-html 可被替换为 renderer-svg / renderer-pdf 而无需改引擎。
 * 3. 坐标系：PlacedNode.left/top 相对**所属 section 左上角**（与协议一致）。
 */
import type { AnyControl, HAlign, TableColumn, TableControl } from '@/types/control'
import type { PageSetup } from '@/types/template'

/* -------------------------------- 几何 -------------------------------- */

/** 矩形盒（mm） */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/* ------------------------------ 渲染就绪内容 ------------------------------ */

/**
 * 控件绑定数据后的「渲染就绪内容」。
 * 到这一步所有异步资源（二维码/条码 SVG）已解析完成，渲染器只做字符串拼装。
 */
export type ResolvedContent =
  | { kind: 'text'; text: string }
  /** 富文本：已经过 DOMPurify 消毒的 HTML */
  | { kind: 'html'; html: string }
  | { kind: 'image'; src: string }
  /** 条码 / 二维码矢量输出（打印必须矢量，位图会糊） */
  | { kind: 'svg'; svg: string }
  /** 纯形状（矩形 / 线条），样式由 control 决定 */
  | { kind: 'shape' }
  /** 解析失败的占位（渲染为虚线框 + 提示文字，不静默吞掉） */
  | { kind: 'placeholder'; label: string }

/* ------------------------------- 已定位节点 ------------------------------- */

export interface PlacedControl extends Box {
  kind: 'control'
  id: string
  angle?: number
  content: ResolvedContent
  /** 原始控件，渲染器据此取样式（fill/stroke/fontSize…） */
  control: AnyControl
}

/**
 * 表格行类型：决定样式（加粗/底色）与分页时能否被切开。
 * `static` = 设计期填写的静态行（布局网格正文行、数据表静态尾行如备注/签字栏）。
 */
export type RenderRowKind = 'header' | 'data' | 'group' | 'subtotal' | 'summary' | 'static'

export interface RenderCell {
  text: string
  align: HAlign
  /** 跨列（组头行 / 合计行用） */
  colSpan?: number
  /** 跨行（表头 / 静态 / 布局网格单元格合并用） */
  rowSpan?: number
  background?: string
  bold?: boolean
  /** 字号（pt） */
  fontSize?: number
  fontFamily?: string
  italic?: boolean
  underline?: boolean
  color?: string
  valign?: 'top' | 'middle' | 'bottom'
  /** 单元格斜线（课表角标等）：none / down(左上→右下) / up(左下→右上) */
  diagonal?: 'none' | 'down' | 'up'
  /** 尾行聚合：该单元格是否为聚合 token（{{#totalSum}} 等） */
  isAgg?: boolean
  /** 聚合 token 类型（isAgg 为真时有效） */
  tokenKind?: import('./aggregate').AggKind
  /** 聚合对应的数据字段键（已去 items[]. 前缀）；isAgg 为真时有效 */
  aggField?: string
}

export interface RenderRow {
  kind: RenderRowKind
  /** 行高（mm），已由 TableEngine 测量 */
  height: number
  cells: RenderCell[]
  /** 数据行在原数组中的下标（供 striped 斑马纹判定） */
  dataIndex?: number
  /** 表尾块内语义：本页合计 / 总计 / 大写金额 / 静态尾行（仅 footerRows 有意义） */
  footerKind?: 'pageSubtotal' | 'grandTotal' | 'capital' | 'static'
}

/** 表格在某一页上的切片 */
export interface PlacedTable extends Box {
  kind: 'table'
  id: string
  control: TableControl
  columns: TableColumn[]
  /** 归一化后的各列实际宽度（mm，合计 === 表格宽度），渲染器直接用，不再二次推算 */
  columnWidths: number[]
  /** 本页表头（可多行；repeatHeader=false 时仅首片有值） */
  headerRows: RenderRow[]
  /** 本页数据行切片 */
  rows: RenderRow[]
  /** 本页表尾块：合计行 + 静态尾行（repeatFooter=false 时仅末片有值） */
  footerRows: RenderRow[]
  /** 是否为该表格的最后一片（渲染器可据此决定收口边框） */
  isLastSlice: boolean
}

export type PlacedNode = PlacedControl | PlacedTable

/* --------------------------------- 页 --------------------------------- */

/**
 * 标签网格参考线（渲染期装饰层，非真实控件）。
 * 坐标 mm，相对该页「内容区左上角」（与 PlacedNode 同一坐标系），
 * 由分页引擎在展开标签网格时按页算出，保证设计画布与预览/导出像素级一致（所见即所得）。
 */
export interface GridLine {
  /** 左（mm，内容区绝对 X，无页偏移） */
  left: number
  /** 上（mm，相对所在页内容区顶，非跨页绝对坐标） */
  top: number
  width: number
  height: number
  /** true=实线 false=虚线 */
  solid: boolean
}

export interface LayoutPage {
  /** 0-based 索引 */
  index: number
  /** 1-based 页码（页码变量 {{page}} 的值） */
  pageNo: number
  header: PlacedControl[]
  body: PlacedNode[]
  footer: PlacedControl[]
  /** 标签网格参考线（容器 + 卡片边框），按页切分，设计即打印 */
  gridLines?: GridLine[]
}

/* -------------------------------- 页面度量 ------------------------------- */

/**
 * 一页的实际可用区域（全部 mm，width/height 为物理尺寸，横向时宽>高）。
 * 这是分页算法的唯一尺寸真理源。
 */
export interface PageMetrics {
  /** 纸张实际宽高（物理尺寸，不随 orientation 再交换） */
  pageWidth: number
  pageHeight: number
  margin: { top: number; right: number; bottom: number; left: number }
  /** 页边距内的内容区宽度 */
  contentWidth: number
  /** 页边距内的内容区高度（含页眉页脚） */
  contentHeight: number
  headerHeight: number
  footerHeight: number
  /**
   * 流式表格切页预算基准 = contentHeight（页高 - 上下边距）。
   * 页眉/页脚色带占位（headerHeight/footerHeight）由分页引擎在切片时按页裁剪
   * （非首页从页眉下方起、每页可用高 = 页高 - 页眉 - 页脚），见 paginateFlowTable。
   */
  bodyHeight: number
}

/* -------------------------------- 警告 -------------------------------- */

export type WarningCode =
  | 'BINDING_MISSING' // 绑定路径在数据中不存在
  | 'EXPRESSION_ERROR' // 表达式求值失败
  | 'DATASOURCE_NOT_ARRAY' // 表格 dataSource 不是数组
  | 'DATASOURCE_EMPTY' // 表格数据为空
  | 'CONTENT_OVERFLOW' // 内容超出可用高度被截断
  | 'IMAGE_UNRESOLVED' // 图片无法解析
  | 'BARCODE_FAILED' // 条码/二维码生成失败
  | 'CHART_FAILED' // 图表 SVG 生成失败
  | 'MATH_FAILED' // 公式渲染失败
  | 'SIGNATURE_EMPTY' // 签名为空（未手写）
  | 'PAGE_LIMIT_REACHED' // 触发最大页数保护
  | 'ROW_TOO_TALL' // 单行高于整页可用高度
  | 'LABEL_GRID_DATA_MISSING' // 标签网格 dataSource 不存在或不是数组（回退纯布局平铺）
  | 'LABEL_GRID_DATA_EMPTY' // 标签网格 dataSource 为空数组（回退纯布局平铺）

export interface RenderWarning {
  code: WarningCode
  message: string
  controlId?: string
}

/* ------------------------------- 引擎产物 ------------------------------- */

export interface LayoutResult {
  pages: LayoutPage[]
  metrics: PageMetrics
  page: PageSetup
  warnings: RenderWarning[]
}

/** 求值上下文：数据根 + 行上下文 + 页码变量 */
export interface EvalContext {
  /** 业务数据根对象 */
  data: Record<string, unknown>
  /** 当前行（表格单元格求值时注入） */
  row?: Record<string, unknown>
  /** 当前行下标（0-based） */
  rowIndex?: number
  /** 当前页码（1-based） */
  page?: number
  /** 总页数 */
  pages?: number
}

/** 分页保护上限：防止死循环 / 恶意数据把浏览器打爆 */
export const MAX_PAGES = 500
