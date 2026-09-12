/**
 * chartkit —— OpenPrint 原生 SVG 图表组件（零依赖）
 *
 * 设计目标（见《OpenPrint-设计方案》图表控件提案）：
 * - 打印设计器要的是**矢量**，不是 Canvas 位图。图表用纯 SVG 路径绘制，
 *   导出 PDF/SVG 时整条链路都是矢量，任意缩放都清晰，且零运行时依赖。
 * - 本模块是**纯函数 + 零依赖**的：输入 ChartModel，输出一段可缩放的 `<svg>` 字符串。
 *   设计期 overlay 与运行期导出共用同一份产物，保证"设计即打印"。
 *
 * 支持的图表类型（v1）：条形图 bar / 折线图 line / 饼图 pie。
 * 数据模型与渲染解耦，后续扩展（横向条形、面积、环形、堆叠等）只需加一个生成器。
 */

export type ChartKind = 'bar' | 'line' | 'pie'

/** 一条数据序列（折线/条形的一组柱；饼图通常只用 series[0]） */
export interface ChartSeries {
  name: string
  /** 与 ChartModel.categories 一一对应 */
  data: number[]
  /** 可选覆盖色；缺省走调色板 */
  color?: string
}

/** 图表下方标签（x 轴类目 / 图例）的水平对齐方式 */
export type ChartLabelAlign = 'left' | 'center' | 'right'

export interface ChartOptions {
  /** SVG 逻辑尺寸（px，仅决定 viewBox 比例；实际渲染按容器缩放）。默认 480×320 */
  width?: number
  height?: number
  /** 图表主标题（绘制在顶部居中） */
  title?: string
  /** 显示图例（多序列时建议开） */
  showLegend?: boolean
  /** 显示坐标轴（条形/折线生效；饼图忽略） */
  showAxis?: boolean
  /** 显示网格线（条形/折线生效） */
  showGrid?: boolean
  /** 调色板（序列缺色时按顺序取） */
  palette?: string[]
  /** 折线是否平滑曲线 */
  smooth?: boolean
  /** 折线下方填充面积 */
  area?: boolean
  /** 饼图环形（中心镂空） */
  donut?: boolean
  /** 数据标签（柱顶数值 / 饼图百分比） */
  valueLabel?: boolean
  /** 下方标签（x 轴类目 / 图例）水平对齐，默认 left */
  labelAlign?: ChartLabelAlign
}

export interface ChartModel {
  kind: ChartKind
  /** 类目轴标签（条形/折线为 x 轴；饼图为扇区名） */
  categories: string[]
  series: ChartSeries[]
  options?: ChartOptions
}

/** 默认调色板（参考 AntV / ECharts 经典商务色，打印对比度足够） */
export const DEFAULT_PALETTE = [
  '#5B8FF9',
  '#5AD8A6',
  '#5D7092',
  '#F6BD16',
  '#E8684A',
  '#6DC8EC',
  '#9270CA',
  '#FF9D4D',
]
