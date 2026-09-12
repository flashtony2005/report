/**
 * CSS 生成器 —— 《OpenPrint-设计方案.md》§5.11（打印样式）/ §7.3（渲染产物）
 *
 * ## 为什么 CSS 要按模板动态生成
 *
 * `@page { size: … }` 的纸张尺寸不能用 CSS 变量（浏览器在解析 `@page` 时不做变量替换），
 * 必须把 mm 字面量写死进去。所以每个模板都要生成一份专属样式表。
 *
 * ## 与测量器的强耦合约定（改这里必须同步改 measure.ts）
 *
 * 分页高度是 DomMeasurer 用 `font-size / font-family / line-height / white-space` 量出来的。
 * 渲染时若用另一套字体或行高，实际高度就会和分页假设对不上，表现为**末行被裁**或**页尾空一大块**。
 * 因此表格单元格的字体三件套在这里直接复用 measure.ts / table-engine.ts 的导出常量，
 * 而不是重新写一遍字面量。
 */
import { DEFAULT_FONT_FAMILY, DEFAULT_LINE_HEIGHT } from '@/core/layout-engine/measure'
import {
  CELL_PADDING_Y,
  DEFAULT_CELL_PADDING,
  TABLE_FONT_SIZE,
} from '@/core/layout-engine/table-engine'
import type { PageMetrics } from '@/core/layout-engine/types'
import type { PageDecoration } from '@/types/template'
import { KATEX_STYLE_CSS, KATEX_FONT_CSS } from '@/core/mathkit/katex-css'

/** 设计画布文本控件的默认值（PrintText.styleToFabric），渲染端必须一致才能所见即所得 */
export const TEXT_DEFAULT_FONT_SIZE = 12
export const TEXT_DEFAULT_FONT_FAMILY = '"Source Han Sans CN", "PingFang SC", sans-serif'
export const TEXT_DEFAULT_LINE_HEIGHT = 1.16
export const TEXT_DEFAULT_COLOR = '#000000'

/** 表格视觉（与设计画布 PrintTable 一致） */
export const TABLE_BORDER_COLOR = '#333333'
export const TABLE_TEXT_COLOR = '#1f2329'
export const TABLE_HEADER_BG = '#F5F7FA'
/** 通用斑马纹底（原 #FAFAFA 太浅，调深为浅蓝，对比更明显） */
export const TABLE_STRIPE_BG = '#DCE6F4'
/** 斑马纹·蓝（交替行更深蓝） */
export const TS_ZEBRA_BLUE_BG = '#C2D4EE'
/** 斑马纹·灰（中性灰交替） */
export const TS_ZEBRA_GRAY_BG = '#E4E7EB'
/** 隔列着色底 */
export const TS_BANDED_BG = '#EEF2F8'
/** 绿色表头底 */
export const TABLE_HEADER_GREEN = '#1F9D57'
/** 单元格斜线颜色（与表格边框同色） */
export const TABLE_DIAGONAL_COLOR = '#333333'

/**
 * 单元格斜线背景（课表角标等）。
 * 返回可直接拼进 inline style 的「完整声明片段」：
 * `background-image:url(...); background-repeat:no-repeat; background-size:100% 100%`。
 * 无斜线返回空串。
 *
 * 同时被设计画布（table-design-render）与运行期（html-renderer）复用，保证两端一致。
 *
 * 用 SVG <line> data URI 而非 linear-gradient 模拟：SVG 有原生抗锯齿，
 * 在非整数像素边界不会产生渐变法常见的锯齿毛刺，清晰度大幅提升。
 *
 * ⚠️ 关键：background-image 默认 `background-repeat:repeat`，
 * 会把 100×100 的 SVG 平铺满整个单元格 —— 这正是「显示成好几根线」的根因。
 * 必须显式 `no-repeat` + `background-size:100% 100%`，让它只画一条、
 * 且 viewBox 经 preserveAspectRatio=none 精确填满任意宽高比的单元格。
 *
 * SVG 内部用双引号；整体经 base64 编码后用单引号包裹 url('...')。
 * base64 不会产生引号，彻底避免与 HTML attribute 的引号冲突。
 */
export function diagonalBackground(
  dir: 'none' | 'down' | 'up' | undefined | null,
): string {
  if (!dir || dir === 'none') return ''
  const c = TABLE_DIAGONAL_COLOR
  // down: 左上角(0,0)→右下角(100,100)；up: 左下角(0,100)→右上角(100,0)
  const y1 = dir === 'up' ? '100' : '0'
  const y2 = dir === 'up' ? '0' : '100'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" y1="${y1}" x2="100" y2="${y2}" stroke="${c}" stroke-width="1.5"/></svg>`
  const b64 = typeof btoa === 'function' ? btoa(svg) : Buffer.from(svg, 'utf-8').toString('base64')
  const url = `url('data:image/svg+xml;base64,${b64}')`
  // no-repeat + 100% 100%：只画一条、且精确铺满单元格（见函数注释 ⚠️）
  return `background-image:${url};background-repeat:no-repeat;background-size:100% 100%`
}

export interface CssOptions {
  /**
   * 屏幕预览模式：给页面加投影、页间距、灰底。
   * 导出 HTML / 无头打印时置 false，避免把预览装饰烤进产物。
   */
  screen?: boolean
  /** 预览缩放比（仅 screen 生效，打印时强制 1） */
  scale?: number
  /** 追加的用户自定义 CSS */
  extraCss?: string
  /** 页面装饰（背景色 + 水印），来自模板 pageSetup */
  pageDecoration?: PageDecoration
  /**
   * 模板是否含公式控件 —— 决定要不要注入 KaTeX 样式（约 24 kB）。
   *
   * 默认 `true` 是为了兼容直接调用 `generateCss` 的老用法；
   * 正常走 `renderHtml` / 导出链路时会自动探测，无需手动传。
   */
  hasMath?: boolean
}

/** mm 数值格式化：保留 3 位小数并去掉尾随 0，避免 "12.340000000000001mm" 这种噪声 */
export function mmv(n: number): string {
  const v = Math.round((Number.isFinite(n) ? n : 0) * 1000) / 1000
  return `${v}mm`
}

/**
 * 表格样式块（运行期打印 与 设计期 HTML overlay 共用的唯一真理源）。
 *
 * 方案 A 的关键：设计画布上的表格 overlay 与最终打印产物必须由**同一份 CSS** 驱动，
 * 否则"所见"与"所印"会随时间漂移。设计期通过 `scope` 前缀把这份规则限制在 overlay 容器内。
 *
 * @param scope 作用域选择器前缀（如 `.op-table-overlay `）；留空 = 全局（打印产物）
 */
export function tableCss(scope = ''): string {
  const s = scope ? `${scope} ` : ''
  return `
${s}.op-table {
  /* 用 separate + border-spacing:0 + box-sizing:border-box，让外框落在表格盒"内"侧：
     collapse 模式下外框横跨边缘，被 overlay 的 overflow:hidden 切掉右/下边，
     表现为"需拖一下才看得到边框"；separate 方案使四边始终完整可见（设计/打印一致）。 */
  border-collapse: separate;
  border-spacing: 0;
  box-sizing: border-box;
  table-layout: fixed;
  /* 字体三件套必须与 DomMeasurer 完全一致，否则分页高度会失真 */
  font-family: ${DEFAULT_FONT_FAMILY};
  font-size: ${TABLE_FONT_SIZE}pt;
  line-height: ${DEFAULT_LINE_HEIGHT};
  color: ${TABLE_TEXT_COLOR};
}

${s}.op-table td,
${s}.op-table th {
  padding: ${mmv(CELL_PADDING_Y)} ${mmv(DEFAULT_CELL_PADDING)};
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  font-weight: normal;
  text-align: left;
  vertical-align: middle;
}

/* 垂直对齐：vertical-align 不可继承，只能按表加类下发到每个 td */
${s}.op-table.va-top td { vertical-align: top; }
${s}.op-table.va-middle td { vertical-align: middle; }
${s}.op-table.va-bottom td { vertical-align: bottom; }

${s}.op-table tr.is-header td { font-weight: bold; }
${s}.op-table tr.is-group td { background: ${TABLE_HEADER_BG}; font-weight: bold; }
${s}.op-table tr.is-subtotal td,
${s}.op-table tr.is-summary td { font-weight: bold; }
${s}.op-table tr.is-striped td { background: ${TABLE_STRIPE_BG}; }
/* 静态行（布局网格正文 / 数据表备注尾行）：默认无强调样式，
   单元格视觉以内联样式为准（与设计期 overlay 同一套 resolveCellStyleFor 取值） */
${s}.op-table tr.is-static td { /* 占位：保持类名与设计期对齐，避免样式遗漏 */ }

/* ---------- 表格样式预设（Excel 式快速切换；class 由渲染端挂在 table 元素上） ---------- */
/* 默认（none）：仅表头加粗，无任何背景色（含标题行）。无需规则，class 仅作占位。 */

/* 表头高亮：表头浅灰底 */
${s}.op-table.ts-header tr.is-header td { background: ${TABLE_HEADER_BG}; }

/* 斑马纹（单双变色条纹，浅蓝交替，对比更明显） */
${s}.op-table.ts-zebra tr.is-header td { background: ${TABLE_HEADER_BG}; }
${s}.op-table.ts-zebra tbody tr:not(.is-header):nth-child(even) td { background: ${TABLE_STRIPE_BG}; }

/* 斑马纹·蓝（交替行更深蓝） */
${s}.op-table.ts-zebra-blue tr.is-header td { background: ${TABLE_HEADER_BG}; }
${s}.op-table.ts-zebra-blue tbody tr:not(.is-header):nth-child(even) td { background: ${TS_ZEBRA_BLUE_BG}; }

/* 斑马纹·灰（中性灰交替） */
${s}.op-table.ts-zebra-gray tr.is-header td { background: ${TABLE_HEADER_BG}; }
${s}.op-table.ts-zebra-gray tbody tr:not(.is-header):nth-child(even) td { background: ${TS_ZEBRA_GRAY_BG}; }

/* 绿色表头（绿底白字） */
${s}.op-table.ts-header-green tr.is-header td { background: ${TABLE_HEADER_GREEN}; color: #ffffff; }

/* 隔列着色（奇偶列交替底） */
${s}.op-table.ts-banded-cols tr > *:nth-child(even) { background: ${TS_BANDED_BG}; }

/* 三段式：表头高亮 + 合计 / 总计行强调底（设计期聚合尾行已对齐 is-subtotal/is-summary 类） */
${s}.op-table.ts-three-segment tr.is-header td { background: ${TABLE_HEADER_BG}; }
${s}.op-table.ts-three-segment tr.is-subtotal td,
${s}.op-table.ts-three-segment tr.is-summary td { background: #EBF2FF; }

/* 深底表头：深蓝底白字 */
${s}.op-table.ts-header-dark tr.is-header td { background: #2F54EB; color: #ffffff; }

/* 课表：全网格 + 表头淡底高亮（角标斜线由单元格 diagonal 控制） */
${s}.op-table.ts-timetable tr.is-header td { background: ${TABLE_HEADER_BG}; }

/* 边框模式：每格画上/左边框，末行补下、末列补右 → 外框落在盒内、不被裁切 */
${s}.op-table.b-all td { border-top: 0.2mm solid var(--op-table-border); border-left: 0.2mm solid var(--op-table-border); }
${s}.op-table.b-all tr:last-child td { border-bottom: 0.2mm solid var(--op-table-border); }
${s}.op-table.b-all td:last-child { border-right: 0.2mm solid var(--op-table-border); }
${s}.op-table.b-horizontal td { border-top: 0.2mm solid var(--op-table-border); }
${s}.op-table.b-horizontal tr:last-child td { border-bottom: 0.2mm solid var(--op-table-border); }
${s}.op-table.b-outline { border: 0.2mm solid var(--op-table-border); }
${s}.op-table.b-none td { border: 0; }
/* 三线表：顶线 + 表头底线 + 底线，无内部横线、无竖线（建模报告 / 财务报表常用） */
${s}.op-table.b-three-line { border-top: 0.2mm solid var(--op-table-border); border-bottom: 0.2mm solid var(--op-table-border); }
${s}.op-table.b-three-line tr.is-header:last-child td { border-bottom: 0.2mm solid var(--op-table-border); }
`
}

export function generateCss(metrics: PageMetrics, options: CssOptions = {}): string {
  const screen = options.screen ?? true
  const scale = options.scale ?? 1
  // 未显式指定时按「有公式」处理，保持与改动前一致的行为（直接调用者不受影响）
  const hasMath = options.hasMath ?? true
  const pageBg = options.pageDecoration?.backgroundColor ?? '#ffffff'
  const { pageWidth, pageHeight } = metrics

  return `
/* ============ OpenPrint 渲染样式（自动生成，勿手改） ============ */
:root {
  --op-page-w: ${mmv(pageWidth)};
  --op-page-h: ${mmv(pageHeight)};
  --op-scale: ${screen ? scale : 1};
  --op-table-border: ${TABLE_BORDER_COLOR};
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: ${screen ? '#f0f2f5' : '#ffffff'};
  /* 让底色/斑马纹在打印时不被浏览器"省墨"策略抹掉 */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.op-doc {
  display: flex;
  flex-direction: column;
  align-items: center;
  ${screen ? 'gap: 10mm; padding: 10mm 0;' : ''}
}

/* 缩放外壳：transform 不占布局空间，靠外壳撑出滚动区域 */
.op-page-wrap {
  width: calc(var(--op-page-w) * var(--op-scale));
  height: calc(var(--op-page-h) * var(--op-scale));
  flex: none;
}

.op-page {
  position: relative;
  width: var(--op-page-w);
  height: var(--op-page-h);
  overflow: hidden;
  background: ${pageBg};
  transform: scale(var(--op-scale));
  transform-origin: top left;
  ${screen ? 'box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12);' : ''}
}

/* 水印装饰层：绝对铺满页面、不拦截事件、置于内容之下 */
.op-watermark {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}
.op-watermark.op-wm-single {
  display: flex;
  align-items: center;
  justify-content: center;
}
.op-wm-single > span {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  white-space: nowrap;
}

/* 整页相对坐标：正文控件直接相对物理页 0,0 定位；边距仅作可视化参考线，不参与渲染偏移 */
.op-content {
  position: absolute;
  left: ${mmv(0)};
  top: ${mmv(0)};
  width: ${mmv(pageWidth)};
  /* 正文区 = 整页：控件可落在任意位置（含原边距带），所见即所得 */
  height: ${mmv(pageHeight)};
}

.op-section {
  position: absolute;
  width: ${mmv(pageWidth)};
  /* 不裁剪：边距只作设计辅助参考线，渲染时边距内/外内容均可见（所见即所得） */
  overflow: visible;
}
/* 页眉/页脚：直接挂在 .op-page 上，整页相对（左右贴物理页边） */
.op-header { top: ${mmv(0)}; left: ${mmv(0)}; height: ${mmv(metrics.headerHeight)}; }
.op-footer { bottom: ${mmv(0)}; left: ${mmv(0)}; height: ${mmv(metrics.footerHeight)}; }
/* 正文：填满 .op-content（整页），不再叠加边距偏移 */
.op-body { top: ${mmv(0)}; left: ${mmv(0)}; width: 100%; height: 100%; }

/* -------------------------------- 控件 -------------------------------- */

.op-node {
  position: absolute;
  transform-origin: left top;
}

/* 标签网格参考线：与 .op-node 同一坐标原点（.op-content 左上角），
   若无 position:absolute 会按文档流竖排成一列，造成「网格线挤成一列」的视觉 bug */
.op-gridlines {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.op-gridline {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
}

.op-text {
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  font-family: ${TEXT_DEFAULT_FONT_FAMILY};
  font-size: ${TEXT_DEFAULT_FONT_SIZE}pt;
  line-height: ${TEXT_DEFAULT_LINE_HEIGHT};
  color: ${TEXT_DEFAULT_COLOR};
}

.op-richtext {
  overflow: hidden;
  font-family: ${TEXT_DEFAULT_FONT_FAMILY};
  font-size: ${TEXT_DEFAULT_FONT_SIZE}pt;
  line-height: 1.5;
  color: ${TEXT_DEFAULT_COLOR};
}
.op-richtext > *:first-child { margin-top: 0; }
.op-richtext > *:last-child { margin-bottom: 0; }
.op-richtext img { max-width: 100%; }

.op-image { display: block; }
.op-image > img { display: block; width: 100%; height: 100%; }

/* 条码 / 二维码：SVG 矢量填满控件框（宽高独立，所见即所得）。
   条码的 preserveAspectRatio="none" 由 data-binder 注入 SVG 自身（自然尺寸≈控件尺寸，拉伸量≈1）；
   二维码保留默认 contain（100%×100% meet）居中。 */
.op-code > svg { display: block; width: 100%; height: 100%; }

.op-line > span {
  position: absolute;
  display: block;
}

/* 解析失败占位：必须看得见，避免用户拿到"少了一块"的单据而不自知 */
.op-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #c0c4cc;
  color: #a8abb2;
  font-family: ${TEXT_DEFAULT_FONT_FAMILY};
  font-size: 8pt;
  overflow: hidden;
}

/* -------------------------------- 表格 -------------------------------- */
${tableCss()}

/* ------------------------------ 数学公式（KaTeX） ------------------------------ */
/* 样式规则（不含 @font-face）：预览 + 导出栅格化共用，使公式布局正确。
   字体由预览（KATEX_FONT_CSS 同源加载）/ 导出（embedFontsInSvg 转 data-URI）分别注入。
   按需注入：模板里没有公式控件时整段省略（约 24 kB），避免为用不到的功能付固定成本。 */
${hasMath ? KATEX_STYLE_CSS : ''}
${hasMath && screen ? `\n/* KaTeX 字体（同源 /fonts/katex/，仅预览 iframe 可用） */\n${KATEX_FONT_CSS}\n` : ''}
/* ------------------------------ 打印覆盖 ------------------------------ */

@page {
  size: ${mmv(pageWidth)} ${mmv(pageHeight)};
  margin: 0;
}

@media print {
  html, body { background: #ffffff; }
  .op-doc { gap: 0; padding: 0; }
  .op-page-wrap { width: auto; height: auto; }
  .op-page {
    transform: none;
    box-shadow: none;
    break-after: page;
    page-break-after: always;
  }
  /* 末页不再换页，否则会多打一张空白纸 */
  .op-page-wrap:last-child .op-page {
    break-after: auto;
    page-break-after: auto;
  }
}
${options.extraCss ? `\n/* ---- 自定义样式 ---- */\n${options.extraCss}\n` : ''}`.trim()
}
