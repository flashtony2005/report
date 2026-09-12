/**
 * 模板市场预设数据 —— 常用 A4 单据 / 小票 / 热敏面单 / 标签（含二维码）
 *
 * 设计约定：
 * - 内容以**静态文本**为主（不绑定数据源），保证用户点击即可用、所见即所得；
 *   需要真实数据时再自行替换为绑定/表达式。
 * - 二维码控件为静态 value（qrcode 库直接编码，画布/渲染开箱即用）。
 * - 坐标全部 mm，正文按**内容区相对**书写（相对页边距内容区左上角），由 `build()`
 *   统一迁移为**整页相对**（+边距偏移）——渲染以物理页 0,0 为准，边距仅作可视化参考线。
 */
import type {
  AnyControl,
  BarcodeControl,
  ChartControl,
  QrcodeControl,
  RectControl,
  TableColumn,
  TableControl,
  TableOptions,
  TextControl,
} from '@/types/control'
import type { PageMargin, PageSetup, Section, TemplateData } from '@/types/template'
import { createDemoTemplate } from './demo-template'

/* ------------------------------- 类型 ------------------------------- */

export type MarketCategory = 'invoice' | 'report' | 'receipt' | 'thermal' | 'label' | 'resume' | 'contract' | 'doc'

export interface MarketTemplate {
  id: string
  name: string
  category: MarketCategory
  desc: string
  /** 纸张尺寸标签（市场卡片展示） */
  sizeLabel: string
  /** 纸张宽高（mm，卡片缩略图用，避免渲染时反复 build） */
  pageW: number
  pageH: number
  build: () => TemplateData<AnyControl>
}

export const MARKET_CATEGORY_LABEL: Record<MarketCategory, string> = {
  invoice: '单据',
  report: '报表',
  receipt: '小票',
  thermal: '热敏',
  label: '标签',
  resume: '简历',
  contract: '合同',
  doc: '文档',
}

/* ------------------------------- helpers ------------------------------- */

function paper(
  width: number,
  height: number,
  margin: Partial<PageMargin> = {},
  orientation: 'portrait' | 'landscape' = 'portrait',
): PageSetup {
  return {
    width,
    height,
    unit: 'mm',
    orientation,
    margin: { top: 10, right: 10, bottom: 10, left: 10, ...margin },
  }
}

/**
 * 整页相对坐标迁移（2026-08-21 坐标模型变更后必需）：
 * 把「内容区相对」坐标平移回物理页，避免内容整体向左上偏移出边距参考线。
 * - body 控件：left += margin.left，top += margin.top
 * - header/footer 子控件：left += margin.left，top 不变（色带仍贴页顶/页底，由 CSS 定位）
 * - labelgrid：本体平移，children 相对卡片左上角不平移（市场模板暂无，防御性处理）
 */
function shiftToPageRelative(sections: Section<AnyControl>[], margin: PageMargin): void {
  const ml = margin.left ?? 0
  const mt = margin.top ?? 0
  for (const sec of sections) {
    const isBand = sec.type === 'header' || sec.type === 'footer'
    for (const c of sec.components ?? []) {
      if (c.type === 'zone') continue
      if (c.type === 'labelgrid') {
        c.left = (c.left ?? 0) + ml
        c.top = (c.top ?? 0) + (isBand ? 0 : mt)
        continue
      }
      c.left = (c.left ?? 0) + ml
      c.top = (c.top ?? 0) + (isBand ? 0 : mt)
    }
  }
}

function build(page: PageSetup, sections: Section<AnyControl>[]): TemplateData<AnyControl> {
  shiftToPageRelative(sections, page.margin)
  return { version: '1.0', document: { type: 'report', page, sections } }
}

/** 只有正文区（小票/标签类） */
function bodyOnly(page: PageSetup, components: AnyControl[]): TemplateData<AnyControl> {
  return build(page, [{ type: 'body', components }])
}

/** 页眉 + 正文 + 页脚（单据类） */
function fullPage(
  page: PageSetup,
  header: AnyControl[],
  body: AnyControl[],
  footer: AnyControl[] = [],
): TemplateData<AnyControl> {
  const sections: Section<AnyControl>[] = [
    { type: 'header', height: 24, repeat: true, components: header },
    { type: 'body', components: body },
  ]
  if (footer.length) sections.push({ type: 'footer', height: 12, repeat: true, components: footer })
  return build(page, sections)
}

/* --------------------- 文档类（简历 / 合同 / 公函）专用助手 --------------------- */

/** A4 文档模板统一纸张（左右各留 16mm，上下 14mm，呼吸感更好） */
const A4DOC = paper(210, 297, { left: 16, right: 16, top: 14, bottom: 14 })
/** 文档正文可用宽度（= 210 - 16 - 16） */
const DOCW = 178

/**
 * 文档流式排版游标：从给定 top 起逐段堆叠，自动推进 y，避免手算重叠。
 * section = 色条 + 白字标题；para = 段落（支持 \n 多行）；heading = 加粗小标题。
 * 用于简历 / 合同 / 文档类长文模板。
 */
function docFlow(
  prefix: string,
  left: number,
  width: number,
  startTop = 0,
  gap = 3.2,
): {
  para: (height: number, value: string, style?: NonNullable<TextControl['style']>) => AnyControl
  heading: (text: string, fontSize?: number, beforeGap?: number) => AnyControl
  section: (title: string, barColor?: string) => AnyControl
  part: (title: string, accent?: string) => AnyControl
  rule: (color?: string) => AnyControl
  advance: (d: number) => void
  get top(): number
  items: AnyControl[]
} {
  let y = startTop
  let n = 0
  const items: AnyControl[] = []
  const id = () => `${prefix}-ln${n++}`
  return {
    para(height, value, style = {}) {
      const c = txt(id(), left, y, width, height, value, style)
      items.push(c)
      y += height + gap
      return c
    },
    heading(text, fontSize = 13, beforeGap = 3) {
      y += beforeGap
      const h = fontSize + 5
      const c = txt(id(), left, y, width, h, text, { fontSize, fontWeight: 'bold' })
      items.push(c)
      y += h + gap
      return c
    },
    section(title, barColor = '#1677ff') {
      y += 2
      const h = 7
      items.push(box(id(), left, y, width, h, barColor, undefined, 0))
      const c = txt(id(), left + 3, y, width - 6, h, title, {
        fontSize: 11,
        fontWeight: 'bold',
        fill: '#ffffff',
      })
      items.push(c)
      y += h + gap
      return c
    },
    /** 简历小节（精致版）：左侧短色条 + 字距标题 + 底部发丝线，替代整条粗色块 */
    part(title, accent = '#1677ff') {
      y += 3
      const h = 6.5
      items.push(box(id(), left, y, 1.8, h, accent, undefined, 0))
      const t = txt(id(), left + 4.5, y - 0.5, width - 4.5, h + 1, title, {
        fontSize: 12,
        fontWeight: 'bold',
        fill: '#1f2329',
        letterSpacing: 1,
      })
      items.push(t)
      const lineY = y + h + 1.4
      items.push(rule(id(), left, lineY, width, '#e3e6ea', 0.5))
      y = lineY + 3
      return t
    },
    rule(color = '#cccccc') {
      const c = rule(id(), left, y, width, color, 0.6)
      items.push(c)
      y += gap + 1
      return c
    },
    advance(d) {
      y += d
    },
    get top() {
      return y
    },
    items,
  }
}

/* ================= 简历姓名横幅（正文首元素，不再占用页眉节） ================= */

/**
 * 色带式横幅：整条品牌色块 + 左侧强调条 + 白字（适合 IT / 设计 / 医学等活力风格）。
 * 返回控件数组，置于正文 top:0（= 页面上边距之下，不贴物理边缘）。
 */
function bannerBand(
  prefix: string,
  name: string,
  role: string,
  contact: string,
  bg: string,
  accent: string,
  nameSize = 18,
  bandH = 36,
): AnyControl[] {
  return [
    box(`${prefix}-band`, 0, 0, DOCW, bandH, bg, undefined, 0),
    box(`${prefix}-band-accent`, 0, 0, 3, bandH, accent, undefined, 0),
    txt(`${prefix}-name`, 9, 4, DOCW - 18, nameSize + 2, name, {
      fontSize: nameSize,
      fontWeight: 'bold',
      fill: '#ffffff',
      letterSpacing: 1,
    }),
    txt(`${prefix}-role`, 9, 4 + nameSize + 2.5, DOCW - 18, 4.5, role, {
      fontSize: 11,
      fill: 'rgba(255,255,255,0.88)',
    }),
    txt(`${prefix}-contact`, 9, 4 + nameSize + 8.5, DOCW - 18, 4.5, contact, {
      fontSize: 8.5,
      fill: 'rgba(255,255,255,0.72)',
    }),
  ]
}

/** 左右分栏式横幅：左侧大字号姓名 + 右侧联系方式竖排 + 底部强调色细线（适合金融 / 通用）。 */
function bannerSplit(
  prefix: string,
  name: string,
  role: string,
  contact: string,
  accent: string,
  nameColor = '#1f2329',
  nameFont = '思源黑体',
  nameSize = 20,
  bandH = 26,
): AnyControl[] {
  return [
    txt(`${prefix}-name`, 0, 0, DOCW - 62, nameSize + 2, name, {
      fontSize: nameSize,
      fontWeight: 'bold',
      fill: nameColor,
      fontFamily: nameFont,
      letterSpacing: 1,
    }),
    txt(`${prefix}-role`, 0, nameSize + 4, DOCW - 62, 5, role, { fontSize: 11, fill: '#666666' }),
    txt(`${prefix}-contact`, DOCW - 64, 1, 64, bandH - 6, contact, {
      fontSize: 8.5,
      fill: '#888888',
      textAlign: 'right',
      lineHeight: 1.7,
    }),
    rule(`${prefix}-rule`, 0, bandH - 1.5, DOCW, accent, 1.1),
  ]
}

/** 居中经典式横幅：居中大字姓名 + 居中联系 + 短下划线（适合教师等稳重风格）。 */
function bannerClassic(
  prefix: string,
  name: string,
  role: string,
  contact: string,
  accent: string,
  nameSize = 21,
  bandH = 28,
): AnyControl[] {
  return [
    txt(`${prefix}-name`, 0, 0, DOCW, nameSize + 2, name, {
      fontSize: nameSize,
      fontWeight: 'bold',
      textAlign: 'center',
      fill: '#1f2329',
      letterSpacing: 5,
    }),
    txt(`${prefix}-role`, 0, nameSize + 4, DOCW, 5, role, { fontSize: 11, textAlign: 'center', fill: '#666666' }),
    txt(`${prefix}-contact`, 0, nameSize + 10, DOCW, 4.5, contact, {
      fontSize: 8.5,
      textAlign: 'center',
      fill: '#999999',
    }),
    rule(`${prefix}-rule`, DOCW / 2 - 26, bandH - 1.5, 52, accent, 1.1),
  ]
}

/** 技能胶囊：浅底圆角块 + 居中文字（一行一行排布，调用方循环放置） */
function chip(prefix: string, x: number, y: number, w: number, h: number, text: string, bg: string, fg = '#1f2329'): AnyControl[] {
  return [
    box(`${prefix}-bg`, x, y, w, h, bg, undefined, 3),
    txt(`${prefix}-tx`, x, y, w, h, text, { fontSize: 8.5, textAlign: 'center', fill: fg }),
  ]
}

function txt(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  value: string,
  style: NonNullable<TextControl['style']> = {},
): AnyControl {
  return {
    id,
    type: 'text',
    left,
    top,
    width,
    height,
    value,
    printable: true,
    // 市场模板默认思源黑体（正式单据感），调用方可覆盖
    style: { fontSize: 10, fontFamily: '思源黑体', ...style },
  }
}

function rule(id: string, left: number, top: number, width: number, stroke = '#333333', strokeWidth = 1): AnyControl {
  return { id, type: 'line', left, top, width, height: 0, stroke, strokeWidth, printable: true }
}

function barcode(id: string, left: number, top: number, width: number, height: number, value: string): BarcodeControl {
  return { id, type: 'barcode', left, top, width, height, value, format: 'CODE128', showText: true, printable: true }
}

function qrcode(id: string, left: number, top: number, width: number, height: number, value: string): QrcodeControl {
  return { id, type: 'qrcode', left, top, width, height, value, errorLevel: 'M', printable: true }
}

/** 圆角色块（KPI 卡片底 / 色条 / 分区标题条） */
function box(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fill: string,
  stroke?: string,
  cornerRadius = 4,
): AnyControl {
  const rect: RectControl = {
    id,
    type: 'rect',
    left,
    top,
    width,
    height,
    fill,
    cornerRadius,
    shape: 'rect',
    printable: true,
  }
  if (stroke) {
    rect.stroke = stroke
    rect.strokeWidth = 0.6
  }
  return rect
}

/** 图表控件（chartkit 原生 SVG，导出 PDF 走矢量） */
function chart(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  kind: ChartControl['kind'],
  categories: string[],
  series: ChartControl['series'],
  options: ChartControl['options'] = {},
): AnyControl {
  return {
    id,
    type: 'chart',
    left,
    top,
    width,
    height,
    kind,
    categories,
    series,
    printable: true,
    options: {
      showLegend: true,
      showAxis: true,
      showGrid: true,
      labelAlign: 'center',
      ...options,
    },
  }
}

function table(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  columns: TableColumn[],
  options: TableOptions & { data?: Array<Record<string, unknown>> } = {},
): AnyControl {
  const { data, ...tableOptions } = options
  return {
    id,
    type: 'table',
    left,
    top,
    width,
    height,
    columns,
    printable: true,
    ...(data ? { data } : {}),
    options: {
      repeatHeader: true,
      pageRows: 'auto',
      rowHeightMode: 'auto',
      borders: 'all',
      verticalAlign: 'middle',
      ...tableOptions,
    },
  }
}

/**
 * 精美财务分析报表（A4）。
 * 结构：页眉（公司 + 大标题 + 报告期）→ 4 张 KPI 指标卡 → 三张矢量图表
 * （月度营收柱状 / 营收构成环形 / 月度净利润折线）→ 分部经营明细表（内嵌数据自带合计）
 * → 页脚。所有数据均为静态示例，开箱即用无需绑定数据源。
 */
function buildFinancialReport(): TemplateData<AnyControl> {
  const w = 186

  /* —— 页眉 —— */
  const header: AnyControl[] = [
    txt('fr-co', 0, 0, 130, 6, '深圳某某集团股份有限公司', { fontSize: 10, fontWeight: 'bold', fill: '#1677ff' }),
    txt('fr-title', 0, 7, w, 11, '2026 年上半年财务分析报表', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
    txt('fr-period', 0, 19, w, 5, '报告期：2026-01-01 ~ 2026-06-30　　币种：人民币 / 万元', {
      fontSize: 9,
      textAlign: 'center',
      fill: '#555555',
    }),
    rule('fr-rule', 0, 22, w, '#1677ff', 1),
  ]

  /* —— 4 张 KPI 指标卡 —— */
  const cardW = 43
  const cardGap = 4
  const cardTop = 0
  const cardH = 26
  const cardX = [1, 1 + (cardW + cardGap), 1 + 2 * (cardW + cardGap), 1 + 3 * (cardW + cardGap)]
  const cardAccent = ['#1677ff', '#52c41a', '#13c2c2', '#fa8c16']
  const cardLabel = ['营业收入', '营业利润', '经营现金流', '营收同比增长']
  const cardValue = ['12,860', '4,300', '3,420', '+18.6%']
  const cardUnit = ['万元', '万元', '万元', '同比']
  const cards: AnyControl[] = []
  for (let i = 0; i < 4; i++) {
    const x = cardX[i]!
    const accent = cardAccent[i]!
    const label = cardLabel[i]!
    const value = cardValue[i]!
    const unit = cardUnit[i]!
    cards.push(box(`fr-kpi-${i}-bg`, x, cardTop, cardW, cardH, '#ffffff', '#e8e8e8', 4))
    cards.push(box(`fr-kpi-${i}-bar`, x, cardTop, cardW, 5, accent, undefined, 4))
    cards.push(txt(`fr-kpi-${i}-lbl`, x + 3, cardTop + 8, cardW - 6, 5, label, {
      fontSize: 8,
      fill: '#666666',
    }))
    cards.push(txt(`fr-kpi-${i}-val`, x + 3, cardTop + 12, cardW - 6, 9, value, {
      fontSize: 16,
      fontWeight: 'bold',
      fill: accent,
    }))
    cards.push(txt(`fr-kpi-${i}-unit`, x + 3, cardTop + 21, cardW - 6, 4, unit, {
      fontSize: 8,
      fill: '#999999',
    }))
  }

  /* —— 图表标题 —— */
  const chartTop = 32
  cards.push(txt('fr-chart-title', 0, chartTop - 2, w, 5, '二、经营分析', { fontSize: 11, fontWeight: 'bold', fill: '#333333' }))

  /* —— 三张矢量图表 —— */
  const chartH = 70
  const barW = 88
  const sideW = 47
  const donutX = barW + 4
  const lineX = barW + 4 + sideW + 4
  const charts: AnyControl[] = [
    chart('fr-bar', 0, chartTop, barW, chartH, 'bar', ['1月', '2月', '3月', '4月', '5月', '6月'], [
      { name: '营收', data: [1980, 2100, 2240, 2050, 2180, 2310], color: '#1677ff' },
    ], { title: '月度营收（万元）', showLegend: false, showAxis: true, showGrid: true, valueLabel: true, palette: ['#1677ff'] }),
    chart('fr-donut', donutX, chartTop, sideW, chartH, 'pie', ['华东', '华南', '华北', '西南', '海外'], [
      { name: '营收构成', data: [4860, 3260, 2510, 1430, 800] },
    ], {
      title: '营收构成',
      donut: true,
      showLegend: true,
      showAxis: false,
      showGrid: false,
      valueLabel: false,
      palette: ['#1677ff', '#52c41a', '#13c2c2', '#fa8c16', '#9254de'],
    }),
    chart('fr-line', lineX, chartTop, sideW, chartH, 'line', ['1月', '2月', '3月', '4月', '5月', '6月'], [
      { name: '净利润', data: [300, 330, 360, 340, 360, 490], color: '#fa8c16' },
    ], {
      title: '月度净利润',
      showLegend: false,
      smooth: true,
      area: true,
      showAxis: true,
      showGrid: true,
      valueLabel: true,
      palette: ['#fa8c16'],
    }),
  ]

  /* —— 分部经营明细表（内嵌数据 + 合计） —— */
  const tableTop = chartTop + chartH + 8
  const detailRows: Array<Record<string, unknown>> = [
    { name: '华东大区', revenue: 4860, cost: 3120, profit: 1740, margin: 0.358 },
    { name: '华南大区', revenue: 3260, cost: 2180, profit: 1080, margin: 0.331 },
    { name: '华北大区', revenue: 2510, cost: 1760, profit: 750, margin: 0.299 },
    { name: '西南大区', revenue: 1430, cost: 980, profit: 450, margin: 0.315 },
    { name: '海外事业部', revenue: 800, cost: 520, profit: 280, margin: 0.35 },
  ]
  const detailTable: TableControl = {
    id: 'fr-detail',
    type: 'table',
    left: 0,
    top: tableTop,
    width: w,
    height: 56,
    printable: true,
    data: detailRows,
    columns: [
      { title: '分部', field: 'name', width: 40, align: 'left', headerAlign: 'center' },
      { title: '营收（万元）', field: 'revenue', width: 36, align: 'right', headerAlign: 'center', format: { kind: 'int' } },
      { title: '成本（万元）', field: 'cost', width: 36, align: 'right', headerAlign: 'center', format: { kind: 'int' } },
      { title: '利润（万元）', field: 'profit', width: 34, align: 'right', headerAlign: 'center', format: { kind: 'int' } },
      { title: '利润率', field: 'margin', width: 40, align: 'right', headerAlign: 'center', format: { kind: 'percent', digits: 1 } },
    ],
    options: {
      repeatHeader: true,
      pageRows: 'auto',
      rowHeightMode: 'auto',
      borders: 'three-line',
      tableStyle: 'report',
      verticalAlign: 'middle',
      summaryRow: {
        type: 'custom',
        fields: ['revenue', 'cost', 'profit', 'margin'],
        label: '合计',
        expressions: {
          revenue: 'sum.revenue',
          cost: 'sum.cost',
          profit: 'sum.profit',
          margin: 'sum.profit / sum.revenue',
        },
      },
    },
  }

  /* —— 说明 —— */
  const noteTop = tableTop + 56 + 6
  const notes: AnyControl[] = [
    box('fr-note-bg', 0, noteTop, w, 22, '#fafafa', '#e8e8e8', 4),
    txt('fr-note-title', 4, noteTop + 3, w - 8, 5, '指标说明', { fontSize: 9, fontWeight: 'bold', fill: '#333333' }),
    txt(
      'fr-note-1',
      4,
      noteTop + 9,
      w - 8,
      4,
      '1）金额单位均为万元；2）营业利润 = 营收 − 成本（分部合计 4,300 万元）；',
      { fontSize: 8, fill: '#555555' },
    ),
    txt(
      'fr-note-2',
      4,
      noteTop + 14,
      w - 8,
      4,
      '3）净利润 2,180 万元（归母净利润，已扣所得税及少数股东损益）；4）增长率对比 2025 年同期。',
      { fontSize: 8, fill: '#555555' },
    ),
  ]

  const body: AnyControl[] = [...cards, ...charts, detailTable, ...notes]

  /* —— 页脚 —— */
  const footer: AnyControl[] = [
    txt('fr-brand', 0, 3, 90, 6, '本报表由 OpenPrint 生成', { fontSize: 8, fill: '#888888' }),
    txt('fr-page', 96, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
  ]

  return fullPage(paper(210, 297, { left: 12, right: 12 }), header, body, footer)
}

/* ------------------------------ 模板定义 ------------------------------ */

export const MARKET_TEMPLATES: MarketTemplate[] = [
  /* ============ 单据（A4 / A5） ============ */
  {
    id: 'market-sale-order',
    name: '销售出库单',
    category: 'invoice',
    desc: 'A4 标准销售出库单：单据头 + 商品明细表 + 合计 + 签收栏，表头每页重复',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: createDemoTemplate,
  },
  {
    id: 'market-purchase-order',
    name: '采购入库单',
    category: 'invoice',
    desc: 'A4 采购入库单：供应商信息 + 到货明细表 + 验收签收栏',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = 186
      const header: AnyControl[] = [
        txt('pch-co', 0, 0, 120, 6, '深圳市某某制造有限公司', { fontSize: 10, fontWeight: 'bold', fill: '#333333' }),
        txt('pch-title', 0, 7, w, 11, '采 购 入 库 单', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('pch-rule', 0, 21, w),
      ]
      const body: AnyControl[] = [
        txt('pch-no', 0, 0, 62, 6, '单据号：CG-2026-0001'),
        txt('pch-date', 62, 0, 62, 6, '入库日期：2026-08-08'),
        txt('pch-wh', 124, 0, 62, 6, '仓库：一号仓'),
        txt('pch-supplier', 0, 7, 92, 6, '供应商：深圳市某某电子有限公司'),
        txt('pch-contact', 92, 7, 94, 6, '联系人：张先生　电话：0755-8888 6666'),
        txt('pch-addr', 0, 14, w, 6, '送货地址：宝安区某某工业园 A 栋'),
        table('pch-tbl', 0, 23, w, 60, [
          { title: '序号', expression: '{{rowIndex + 1}}', width: 14, align: 'center', headerAlign: 'center' },
          { title: '物料编码', field: 'productCode', width: 26, align: 'left', headerAlign: 'center' },
          { title: '物料名称', field: 'productName', width: 58, align: 'left', headerAlign: 'center' },
          { title: '规格型号', field: 'spec', width: 34, align: 'left', headerAlign: 'center' },
          { title: '单位', field: 'unit', width: 12, align: 'center', headerAlign: 'center' },
          { title: '数量', field: 'qty', width: 14, align: 'right', headerAlign: 'center' },
          { title: '单价', field: 'price', width: 14, align: 'right', headerAlign: 'center' },
          { title: '金额', field: 'amount', width: 14, align: 'right', headerAlign: 'center' },
        ], {
          data: [
            { productCode: 'WL-0001', productName: '304 不锈钢板', spec: '1.0×1220×2440', unit: '张', qty: 8, price: 1850.0, amount: 14800.0 },
            { productCode: 'WL-0002', productName: '热镀锌角钢', spec: '50×50×5', unit: '支', qty: 120, price: 95.0, amount: 11400.0 },
            { productCode: 'WL-0003', productName: '镀锌焊接钢管', spec: 'DN25', unit: '米', qty: 80, price: 68.5, amount: 5480.0 },
            { productCode: 'WL-0004', productName: '不锈钢膨胀螺栓', spec: 'M10×80', unit: '套', qty: 600, price: 6.8, amount: 4080.0 },
            { productCode: 'WL-0005', productName: '硅酮结构胶', spec: '590ml', unit: '支', qty: 150, price: 22.0, amount: 3300.0 },
          ],
        }),
        txt('pch-total', 0, 85, w, 7, '合计金额（大写）：叁万捌仟陆佰元整', { fontSize: 11, fontWeight: 'bold' }),
        txt('pch-memo', 0, 93, w, 6, '备注：本单须经仓库验收确认后方可入库', { fontSize: 9, fill: '#555555' }),
        txt('pch-sign', 0, 103, w, 6, '验收：＿＿＿＿　　仓管：＿＿＿＿　　采购：＿＿＿＿　　制单：＿＿＿＿', { fontSize: 9 }),
      ]
      const footer: AnyControl[] = [
        txt('pch-brand', 0, 3, 90, 6, '本单据由 OpenPrint 生成', { fontSize: 8, fill: '#888888' }),
        txt('pch-page', 96, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(paper(210, 297, { left: 12, right: 12 }), header, body, footer)
    },
  },
  {
    id: 'market-quotation',
    name: '报价单',
    category: 'invoice',
    desc: 'A4 报价单：客户抬头 + 报价明细 + 有效期与条款说明',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = 186
      const header: AnyControl[] = [
        txt('qt-co', 0, 0, 100, 6, '深圳市某某科技有限公司', { fontSize: 11, fontWeight: 'bold', fill: '#1677ff' }),
        barcode('qt-bc', 140, 0, 46, 12, 'QUO-2026-0801'),
        txt('qt-title', 0, 14, w, 10, '报 价 单', { fontSize: 16, fontWeight: 'bold', textAlign: 'center' }),
        rule('qt-rule', 0, 22, w, '#1677ff', 1),
      ]
      const body: AnyControl[] = [
        txt('qt-cust', 0, 0, w, 6, '致：某某采购中心　　联系人：李经理　　电话：0755-1234 5678'),
        txt('qt-no', 0, 7, w, 6, '报价单号：QUO-2026-0801　　报价日期：2026-08-08　　有效期：30 天'),
        table('qt-tbl', 0, 16, w, 70, [
          { title: '序号', expression: '{{rowIndex + 1}}', width: 12, align: 'center', headerAlign: 'center' },
          { title: '产品名称', field: 'productName', width: 56, align: 'left', headerAlign: 'center' },
          { title: '规格型号', field: 'spec', width: 30, align: 'left', headerAlign: 'center' },
          { title: '单位', field: 'unit', width: 12, align: 'center', headerAlign: 'center' },
          { title: '数量', field: 'qty', width: 14, align: 'right', headerAlign: 'center' },
          { title: '单价（元）', field: 'price', width: 22, align: 'right', headerAlign: 'center' },
          { title: '小计（元）', field: 'amount', width: 24, align: 'right', headerAlign: 'center' },
          { title: '备注', field: 'memo', width: 16, align: 'left', headerAlign: 'center' },
        ], {
          data: [
            { productName: '工业平板电脑', spec: 'IPC-1501', unit: '台', qty: 10, price: 1280.0, amount: 12800.0, memo: '含支架' },
            { productName: '串口服务器', spec: '4 口', unit: '台', qty: 20, price: 360.0, amount: 7200.0, memo: '' },
            { productName: '交换机', spec: '24GE', unit: '台', qty: 5, price: 980.0, amount: 4900.0, memo: '含光模块' },
            { productName: '超五类网线', spec: '305m/箱', unit: '箱', qty: 12, price: 420.0, amount: 5040.0, memo: '' },
            { productName: '电源适配器', spec: '12V/5A', unit: '个', qty: 60, price: 65.0, amount: 3900.0, memo: '可定制' },
          ],
        }),
        txt('qt-total', 0, 88, w, 7, '合计金额（不含税）：￥38,600.00', { fontSize: 11, fontWeight: 'bold', textAlign: 'right' }),
        txt('qt-terms', 0, 97, w, 6, '付款方式：月结 30 天；交货周期：收到订单后 7 个工作日内', { fontSize: 9, fill: '#555555' }),
        txt('qt-note', 0, 104, w, 6, '以上报价含税 13%，如需开票请在下单时说明开票信息。', { fontSize: 9, fill: '#555555' }),
      ]
      const footer: AnyControl[] = [
        txt('qt-page', 96, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(paper(210, 297, { left: 12, right: 12 }), header, body, footer)
    },
  },
  {
    id: 'market-delivery-order',
    name: '送货单',
    category: 'invoice',
    desc: 'A5 送货单：随货联，收货方签收后留档',
    sizeLabel: 'A5 · 148×210',
    pageW: 148,
    pageH: 210,
    build: () => {
      const w = 128
      const header: AnyControl[] = [
        txt('dl-title', 0, 0, w, 10, '送 货 单', { fontSize: 15, fontWeight: 'bold', textAlign: 'center' }),
        txt('dl-no', 0, 11, w, 5, '送货单号：SH-2026-0801', { fontSize: 9 }),
        rule('dl-rule', 0, 18, w),
      ]
      const body: AnyControl[] = [
        txt('dl-to', 0, 0, w, 5, '收货单位：某某商贸有限公司', { fontSize: 9 }),
        txt('dl-from', 0, 6, w, 5, '发货单位：某某科技有限公司', { fontSize: 9 }),
        txt('dl-date', 0, 12, w, 5, '送货日期：2026-08-08　　车牌：粤B·88888', { fontSize: 9 }),
        table('dl-tbl', 0, 20, w, 60, [
          { title: '序号', expression: '{{rowIndex + 1}}', width: 12, align: 'center', headerAlign: 'center' },
          { title: '商品名称', field: 'productName', width: 46, align: 'left', headerAlign: 'center' },
          { title: '单位', field: 'unit', width: 12, align: 'center', headerAlign: 'center' },
          { title: '数量', field: 'qty', width: 16, align: 'right', headerAlign: 'center' },
          { title: '备注', field: 'memo', width: 42, align: 'left', headerAlign: 'center' },
        ], {
          data: [
            { productName: '瓶装饮用水 550ml', unit: '箱', qty: 20, memo: '整箱 24 瓶' },
            { productName: '方便面', unit: '箱', qty: 10, memo: '整箱 30 袋' },
            { productName: '抽纸', unit: '提', qty: 15, memo: '' },
            { productName: '洗洁精', unit: '瓶', qty: 12, memo: '2L 装' },
            { productName: '垃圾袋', unit: '卷', qty: 30, memo: '加厚' },
          ],
        }),
        txt('dl-sign', 0, 84, w, 6, '收货人签收：＿＿＿＿＿＿　　日期：＿＿＿＿＿＿', { fontSize: 9 }),
      ]
      return fullPage(paper(148, 210, { top: 8, bottom: 8 }), header, body)
    },
  },

  /* ============ 报表（A4 · 图表 + 内嵌数据） ============ */
  {
    id: 'market-financial-report',
    name: '精美财务分析报表',
    category: 'report',
    desc: 'A4 财务分析报表：4 张 KPI 指标卡 + 柱状/环形/折线三张矢量图表 + 分部经营明细表（内嵌数据，自带合计），开箱即用无需绑定数据源',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: buildFinancialReport,
  },

  /* ============ 小票（58 / 80 热敏） ============ */
  {
    id: 'market-pos-58',
    name: '收银小票（58mm）',
    category: 'receipt',
    desc: '58mm 热敏收银小票：店名 + 商品行 + 合计，下方留白可自行扩展内容',
    sizeLabel: '58×120',
    pageW: 58,
    pageH: 120,
    build: () => {
      const w = 50
      const items: Array<[string, string, string]> = [
        ['可口可乐 330ml', '2', '6.00'],
        ['农夫山泉 550ml', '3', '4.50'],
        ['乐事薯片 原味', '1', '7.50'],
        ['康师傅方便面', '2', '9.00'],
        ['蒙牛纯牛奶 250ml', '2', '7.60'],
      ]
      const lines: AnyControl[] = [
        txt('pos-name', 0, 0, w, 6, '某某便利超市', { fontSize: 12, fontWeight: 'bold', textAlign: 'center' }),
        txt('pos-addr', 0, 6.5, w, 4, '地址：宝安区某某路 88 号', { fontSize: 8, textAlign: 'center', fill: '#555555' }),
        txt('pos-tel', 0, 11, w, 4, '电话：0755-6666 8888', { fontSize: 8, textAlign: 'center', fill: '#555555' }),
        rule('pos-rule1', 0, 16, w, '#999999', 0.5),
        txt('pos-no', 0, 17.5, w, 4, '单号：20260808-0012', { fontSize: 8 }),
        txt('pos-time', 0, 22, w, 4, '时间：2026-08-08 18:30:00', { fontSize: 8 }),
        rule('pos-rule2', 0, 27, w, '#999999', 0.5),
      ]
      let top = 28.5
      items.forEach(([name, qty, price], i) => {
        lines.push(txt(`pos-item${i}`, 0, top, w, 4.5, `${name}`, { fontSize: 9 }))
        lines.push(txt(`pos-item${i}-q`, 26, top, 12, 4.5, `x${qty}`, { fontSize: 9, textAlign: 'right' }))
        lines.push(txt(`pos-item${i}-p`, 38, top, 12, 4.5, price, { fontSize: 9, textAlign: 'right' }))
        top += 5
      })
      top += 1
      lines.push(rule('pos-rule3', 0, top, w, '#999999', 0.5))
      lines.push(txt('pos-total', 0, top + 2, w, 6, '合计：￥34.60', { fontSize: 12, fontWeight: 'bold', textAlign: 'right' }))
      lines.push(txt('pos-qr', 0, top + 9, w, 4, '扫码关注公众号', { fontSize: 7.5, textAlign: 'center', fill: '#555555' }))
      return bodyOnly(paper(58, 120, { top: 4, right: 4, bottom: 4, left: 4 }), lines)
    },
  },
  {
    id: 'market-waimai-80',
    name: '外卖小票（80mm）',
    category: 'receipt',
    desc: '80mm 外卖小票：店铺信息 + 订单明细 + 合计 + 备注',
    sizeLabel: '80×150',
    pageW: 80,
    pageH: 150,
    build: () => {
      const w = 72
      const header: AnyControl[] = [
        txt('wm-name', 0, 0, w, 6, '某某餐饮店', { fontSize: 13, fontWeight: 'bold', textAlign: 'center' }),
        txt('wm-slogan', 0, 6.5, w, 4, '好吃不贵，快速送达', { fontSize: 8, textAlign: 'center', fill: '#888888' }),
        rule('wm-rule1', 0, 12, w, '#999999', 0.5),
        txt('wm-no', 0, 13.5, w, 4, '订单号：WM2026080800123', { fontSize: 8.5 }),
        txt('wm-type', 50, 13.5, 22, 4, '堂食 / 外卖', { fontSize: 8.5, textAlign: 'right' }),
        txt('wm-time', 0, 18, w, 4, '下单时间：2026-08-08 12:05:30', { fontSize: 8.5 }),
        rule('wm-rule2', 0, 23, w, '#999999', 0.5),
      ]
      const body: AnyControl[] = [
        table('wm-tbl', 0, 0, w, 55, [
          { title: '商品', field: 'productName', width: 40, align: 'left', headerAlign: 'center' },
          { title: '数量', field: 'qty', width: 12, align: 'center', headerAlign: 'center' },
          { title: '小计', field: 'amount', width: 20, align: 'right', headerAlign: 'center' },
        ], {
          borders: 'none',
          repeatHeader: false,
          data: [
            { productName: '招牌牛肉面', qty: 2, amount: 36.0 },
            { productName: '卤蛋', qty: 2, amount: 4.0 },
            { productName: '冰红茶', qty: 2, amount: 6.0 },
            { productName: '酸辣土豆丝', qty: 1, amount: 12.0 },
          ],
        }),
        txt('wm-total', 0, 58, w, 6, '合计：￥58.00', { fontSize: 12, fontWeight: 'bold', textAlign: 'right' }),
        txt('wm-fee', 0, 65, w, 4, '配送费：￥3.00　　包装费：￥1.00', { fontSize: 8.5, fill: '#555555' }),
        rule('wm-rule3', 0, 71, w, '#999999', 0.5),
        txt('wm-addr', 0, 73, w, 6, '送达地址：南山区科技园某某大厦 3 楼', { fontSize: 8.5 }),
        txt('wm-memo', 0, 80, w, 6, '备注：不要辣，多加一双筷子', { fontSize: 8.5 }),
        txt('wm-thanks', 0, 92, w, 5, '感谢惠顾，欢迎再次光临！', { fontSize: 9, textAlign: 'center', fontWeight: 'bold' }),
      ]
      return fullPage(paper(80, 150, { top: 6, right: 4, bottom: 6, left: 4 }), header, body)
    },
  },

  /* ============ 热敏面单 ============ */
  {
    id: 'market-express',
    name: '快递面单（热敏）',
    category: 'thermal',
    desc: '100×180 热敏快递面单：收/寄件信息分区 + 订单条码 + 运单号',
    sizeLabel: '100×180',
    pageW: 100,
    pageH: 180,
    build: () => {
      const w = 92
      const lines: AnyControl[] = [
        txt('ex-title', 0, 0, w, 6, '快 递 面 单', { fontSize: 13, fontWeight: 'bold', textAlign: 'center' }),
        rule('ex-rule', 0, 8, w, '#999999', 0.5),
        txt('ex-send-t', 0, 10, w, 4, '【寄件人】', { fontSize: 9, fontWeight: 'bold' }),
        txt('ex-send-name', 0, 15, w, 4, '张三　13800138000', { fontSize: 9.5 }),
        txt('ex-send-addr', 0, 20, w, 6, '广东省深圳市南山区科技园南路 100 号', { fontSize: 9.5 }),
        rule('ex-rule2', 0, 28, w, '#999999', 0.5),
        txt('ex-recv-t', 0, 30, w, 4, '【收件人】', { fontSize: 9, fontWeight: 'bold' }),
        txt('ex-recv-name', 0, 35, w, 4, '李四　13900139000', { fontSize: 9.5 }),
        txt('ex-recv-addr', 0, 40, w, 6, '北京市朝阳区建国路 88 号院 2 号楼', { fontSize: 9.5 }),
        rule('ex-rule3', 0, 48, w, '#999999', 0.5),
        barcode('ex-bc', 20, 52, 52, 14, 'SF1234567890'),
        txt('ex-no', 0, 69, w, 4, '运单号：SF1234567890', { fontSize: 9, textAlign: 'center' }),
        txt('ex-remark', 0, 75, w, 5, '备注：易碎品，请轻拿轻放', { fontSize: 8.5, fill: '#555555' }),
      ]
      return bodyOnly(paper(100, 180, { top: 6, right: 4, bottom: 6, left: 4 }), lines)
    },
  },

  /* ============ 标签 ============ */
  {
    id: 'market-price-label',
    name: '价格标签',
    category: 'label',
    desc: '40×30 商品价格标签：大号价格 + 商品名 + 条码，可复制多个排布',
    sizeLabel: '40×30',
    pageW: 40,
    pageH: 30,
    build: () => {
      const w = 36
      const lines: AnyControl[] = [
        txt('lb-name', 0, 0, w, 5, '可乐 500ml', { fontSize: 8, textAlign: 'center' }),
        txt('lb-price', 0, 6, w, 10, '￥3.50', { fontSize: 20, fontWeight: 'bold', textAlign: 'center', fill: '#e60000' }),
        barcode('lb-bc', 6, 18, 24, 8, '6901234567890'),
      ]
      return bodyOnly(paper(40, 30, { top: 3, right: 2, bottom: 3, left: 2 }), lines)
    },
  },

  /* ============ 新增：退货 / 报销 / 领料 / 对账（A4） ============ */
  {
    id: 'market-return-order',
    name: '销售退货单',
    category: 'invoice',
    desc: 'A4 销售退货单：原单信息 + 退货明细（含原因）+ 退款结算栏',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = 186
      const header: AnyControl[] = [
        txt('rt-co', 0, 0, 100, 6, '深圳某某科技有限公司', { fontSize: 10, fontWeight: 'bold', fill: '#333333' }),
        txt('rt-title', 0, 7, w, 11, '销 售 退 货 单', { fontSize: 18, fontWeight: 'bold', textAlign: 'center', fill: '#c0392b' }),
        rule('rt-rule', 0, 21, w),
      ]
      const body: AnyControl[] = [
        txt('rt-no', 0, 0, 62, 6, '退货单号：TH-2026-0008'),
        txt('rt-date', 62, 0, 62, 6, '退货日期：2026-08-08'),
        txt('rt-origin', 124, 0, 62, 6, '原出库单：CK-2026-0156'),
        txt('rt-cust', 0, 7, 92, 6, '客户：某某商贸有限公司'),
        txt('rt-contact', 92, 7, 94, 6, '联系人：王先生　电话：0755-5555 1234'),
        txt('rt-addr', 0, 14, w, 6, '退货地址：宝安区某某工业园 B 栋 2 层'),
        table('rt-tbl', 0, 23, w, 60, [
          { title: '序号', expression: '{{rowIndex + 1}}', width: 14, align: 'center', headerAlign: 'center' },
          { title: '商品编码', field: 'productCode', width: 26, align: 'left', headerAlign: 'center' },
          { title: '商品名称', field: 'productName', width: 48, align: 'left', headerAlign: 'center' },
          { title: '规格', field: 'spec', width: 26, align: 'left', headerAlign: 'center' },
          { title: '数量', field: 'qty', width: 14, align: 'right', headerAlign: 'center' },
          { title: '退货原因', field: 'reason', width: 58, align: 'left', headerAlign: 'center' },
        ], {
          data: [
            { productCode: 'PD-1001', productName: '无线鼠标', spec: '2.4G', qty: 2, reason: '按键失灵' },
            { productCode: 'PD-1002', productName: '机械键盘', spec: '87 键', qty: 1, reason: '轴体异响' },
            { productCode: 'PD-1003', productName: 'USB 集线器', spec: '4 口', qty: 3, reason: '接口松动' },
            { productCode: 'PD-1004', productName: '六类网线', spec: '1.5m', qty: 5, reason: '水晶头损坏' },
            { productCode: 'PD-1005', productName: '高清摄像头', spec: '1080P', qty: 1, reason: '画面模糊' },
          ],
        }),
        txt('rt-total', 0, 85, w, 7, '退货合计（大写）：人民币陆佰元整', { fontSize: 11, fontWeight: 'bold' }),
        txt('rt-memo', 0, 93, w, 6, '备注：退货须附原出库单与验收记录', { fontSize: 9, fill: '#555555' }),
        txt('rt-sign', 0, 103, w, 6, '客户确认：＿＿＿＿　　仓库验收：＿＿＿＿　　财务退款：＿＿＿＿', { fontSize: 9 }),
      ]
      const footer: AnyControl[] = [
        txt('rt-brand', 0, 3, 90, 6, '本单据由 OpenPrint 生成', { fontSize: 8, fill: '#888888' }),
        txt('rt-page', 96, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(paper(210, 297, { left: 12, right: 12 }), header, body, footer)
    },
  },
  {
    id: 'market-expense-claim',
    name: '费用报销单',
    category: 'invoice',
    desc: 'A4 费用报销单：费用明细表 + 合计 + 多级审批签名栏',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = 186
      const header: AnyControl[] = [
        txt('exp-co', 0, 0, 100, 6, '某某科技有限公司', { fontSize: 10, fontWeight: 'bold', fill: '#333333' }),
        txt('exp-title', 0, 7, w, 11, '费 用 报 销 单', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('exp-rule', 0, 21, w),
      ]
      const body: AnyControl[] = [
        txt('exp-no', 0, 0, 62, 6, '报销单号：BX-2026-0234'),
        txt('exp-date', 62, 0, 62, 6, '报销日期：2026-08-08'),
        txt('exp-dept', 124, 0, 62, 6, '部门：市场部'),
        txt('exp-user', 0, 7, 62, 6, '报销人：陈小明'),
        txt('exp-purpose', 62, 7, 124, 6, '事由：客户拜访差旅费'),
        table('exp-tbl', 0, 16, w, 50, [
          { title: '序号', expression: '{{rowIndex + 1}}', width: 14, align: 'center', headerAlign: 'center' },
          { title: '费用类型', field: 'feeType', width: 42, align: 'left', headerAlign: 'center' },
          { title: '发生日期', field: 'feeDate', width: 30, align: 'center', headerAlign: 'center' },
          { title: '摘要', field: 'summary', width: 50, align: 'left', headerAlign: 'center' },
          { title: '票据张数', field: 'billCount', width: 18, align: 'right', headerAlign: 'center' },
          { title: '金额', field: 'amount', width: 32, align: 'right', headerAlign: 'center' },
        ], {
          data: [
            { feeType: '交通费', feeDate: '2026-07-12', summary: '深圳-广州 高铁', billCount: 2, amount: 180.0 },
            { feeType: '住宿费', feeDate: '2026-07-12', summary: '如家酒店 2 晚', billCount: 2, amount: 436.0 },
            { feeType: '业务招待费', feeDate: '2026-07-13', summary: '客户接待餐', billCount: 3, amount: 680.0 },
            { feeType: '市内交通费', feeDate: '2026-07-14', summary: '打车费', billCount: 4, amount: 264.0 },
            { feeType: '办公用品', feeDate: '2026-07-15', summary: '文具耗材', billCount: 1, amount: 300.0 },
          ],
        }),
        txt('exp-total', 0, 68, w, 7, '报销合计：￥1,860.00', { fontSize: 11, fontWeight: 'bold', textAlign: 'right' }),
        txt('exp-note', 0, 76, w, 6, '备注：附发票及行程单，发票张数 12 张', { fontSize: 9, fill: '#555555' }),
        txt('exp-sign', 0, 88, w, 6, '报销人：＿＿＿＿　　部门负责人：＿＿＿＿　　财务审核：＿＿＿＿', { fontSize: 9 }),
        txt('exp-sign2', 0, 95, w, 6, '财务总监：＿＿＿＿　　总经理审批：＿＿＿＿', { fontSize: 9 }),
      ]
      const footer: AnyControl[] = [
        txt('exp-page', 96, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(paper(210, 297, { left: 12, right: 12 }), header, body, footer)
    },
  },
  {
    id: 'market-material-request',
    name: '领料单',
    category: 'invoice',
    desc: 'A4 领料单：领用明细表（物料/数量/用途）+ 发料领料签收栏',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = 186
      const header: AnyControl[] = [
        txt('pl-co', 0, 0, 100, 6, '某某制造有限公司', { fontSize: 10, fontWeight: 'bold', fill: '#333333' }),
        txt('pl-title', 0, 7, w, 11, '领 料 单', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('pl-rule', 0, 21, w),
      ]
      const body: AnyControl[] = [
        txt('pl-no', 0, 0, 62, 6, '领料单号：LL-2026-0066'),
        txt('pl-date', 62, 0, 62, 6, '日期：2026-08-08'),
        txt('pl-dept', 124, 0, 62, 6, '领料部门：生产一部'),
        txt('pl-user', 0, 7, 62, 6, '领料人：刘师傅'),
        txt('pl-wh', 62, 7, 124, 6, '仓库：原材料仓　用途：A 线本月排产'),
        table('pl-tbl', 0, 16, w, 55, [
          { title: '序号', expression: '{{rowIndex + 1}}', width: 14, align: 'center', headerAlign: 'center' },
          { title: '物料编码', field: 'productCode', width: 26, align: 'left', headerAlign: 'center' },
          { title: '物料名称', field: 'productName', width: 48, align: 'left', headerAlign: 'center' },
          { title: '规格型号', field: 'spec', width: 30, align: 'left', headerAlign: 'center' },
          { title: '单位', field: 'unit', width: 14, align: 'center', headerAlign: 'center' },
          { title: '数量', field: 'qty', width: 18, align: 'right', headerAlign: 'center' },
          { title: '备注', field: 'memo', width: 36, align: 'left', headerAlign: 'center' },
        ], {
          data: [
            { productCode: 'LM-2001', productName: '冷轧钢板', spec: '1.5mm', unit: '张', qty: 80, memo: '需剪板' },
            { productCode: 'LM-2002', productName: '工业铝型材', spec: '4040', unit: '支', qty: 120, memo: '机架框架' },
            { productCode: 'LM-2003', productName: '深沟球轴承', spec: '6204', unit: '个', qty: 40, memo: '' },
            { productCode: 'LM-2004', productName: '同步带', spec: 'S5M', unit: '条', qty: 60, memo: '传动用' },
            { productCode: 'LM-2005', productName: '标准紧固件', spec: 'M8', unit: '套', qty: 60, memo: '螺栓螺母' },
          ],
        }),
        txt('pl-total', 0, 73, w, 6, '合计领用：5 项 / 共 360 件', { fontSize: 10, fontWeight: 'bold' }),
        txt('pl-sign', 0, 84, w, 6, '领料人：＿＿＿＿　　发料人：＿＿＿＿　　车间主管：＿＿＿＿', { fontSize: 9 }),
      ]
      const footer: AnyControl[] = [
        txt('pl-page', 96, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(paper(210, 297, { left: 12, right: 12 }), header, body, footer)
    },
  },
  {
    id: 'market-statement',
    name: '对账单',
    category: 'invoice',
    desc: 'A4 客户对账单：账期往来明细（应收/已收/余额）+ 确认盖章栏',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = 186
      const header: AnyControl[] = [
        txt('st-co', 0, 0, 100, 6, '某某科技有限公司', { fontSize: 10, fontWeight: 'bold', fill: '#1677ff' }),
        txt('st-title', 0, 7, w, 11, '对 账 单', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('st-rule', 0, 21, w, '#1677ff', 1),
      ]
      const body: AnyControl[] = [
        txt('st-cust', 0, 0, w, 6, '致：某某商贸有限公司　　账期：2026-06-01 ~ 2026-07-31'),
        txt('st-no', 0, 7, w, 6, '对账编号：DZ-2026-0801　　打印日期：2026-08-08'),
        table('st-tbl', 0, 16, w, 60, [
          { title: '序号', expression: '{{rowIndex + 1}}', width: 14, align: 'center', headerAlign: 'center' },
          { title: '日期', field: 'billDate', width: 26, align: 'center', headerAlign: 'center' },
          { title: '单据号', field: 'billNo', width: 34, align: 'left', headerAlign: 'center' },
          { title: '摘要', field: 'summary', width: 44, align: 'left', headerAlign: 'center' },
          { title: '应收（元）', field: 'debit', width: 24, align: 'right', headerAlign: 'center' },
          { title: '已收（元）', field: 'credit', width: 22, align: 'right', headerAlign: 'center' },
          { title: '余额（元）', field: 'balance', width: 22, align: 'right', headerAlign: 'center' },
        ], {
          data: [
            { billDate: '2026-06-03', billNo: 'XS-2026-0123', summary: '6 月货款', debit: 12800.0, credit: 0.0, balance: 12800.0 },
            { billDate: '2026-06-18', billNo: 'XS-2026-0156', summary: '包装材料', debit: 9600.0, credit: 0.0, balance: 22400.0 },
            { billDate: '2026-07-05', billNo: 'XS-2026-0201', summary: '7 月货款', debit: 8200.0, credit: 0.0, balance: 30600.0 },
            { billDate: '2026-07-22', billNo: 'XS-2026-0245', summary: '配套配件', debit: 4800.0, credit: 0.0, balance: 35400.0 },
            { billDate: '2026-07-29', billNo: 'XS-2026-0261', summary: '补货', debit: 3200.0, credit: 0.0, balance: 38600.0 },
          ],
        }),
        txt('st-begin', 0, 78, w, 6, '期初余额：￥0.00', { fontSize: 10 }),
        txt('st-end', 0, 85, w, 7, '期末应收余额：￥38,600.00', { fontSize: 11, fontWeight: 'bold' }),
        txt('st-note', 0, 93, w, 6, '请核对以上往来明细，如无异议请签章确认后回传。', { fontSize: 9, fill: '#555555' }),
        txt('st-sign', 0, 104, w, 6, '客户确认（盖章）：＿＿＿＿＿＿　　日期：＿＿＿＿＿＿', { fontSize: 9 }),
      ]
      const footer: AnyControl[] = [
        txt('st-page', 96, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(paper(210, 297, { left: 12, right: 12 }), header, body, footer)
    },
  },

  /* ============ 新增：带二维码的模板 ============ */
  {
    id: 'market-qr-receipt',
    name: '收款码小票（带二维码）',
    category: 'receipt',
    desc: '58mm 收款小票：商品行 + 合计 + 收款二维码（静态示例链接，可改为收款码图片/绑定）',
    sizeLabel: '58×130',
    pageW: 58,
    pageH: 130,
    build: () => {
      const w = 50
      const lines: AnyControl[] = [
        txt('qr-name', 0, 0, w, 6, '某某小面馆', { fontSize: 12, fontWeight: 'bold', textAlign: 'center' }),
        txt('qr-addr', 0, 6.5, w, 4, '宝安区某某路 66 号', { fontSize: 8, textAlign: 'center', fill: '#555555' }),
        rule('qr-rule1', 0, 11.5, w, '#999999', 0.5),
        txt('qr-no', 0, 13, w, 4, '单号：20260808-0033', { fontSize: 8 }),
        txt('qr-time', 0, 17.5, w, 4, '时间：2026-08-08 19:00:00', { fontSize: 8 }),
        rule('qr-rule2', 0, 22.5, w, '#999999', 0.5),
        txt('qr-i1', 0, 24, w, 4.5, '招牌牛肉面　　18.00', { fontSize: 9 }),
        txt('qr-i2', 0, 29, w, 4.5, '卤蛋 x2　　　 4.00', { fontSize: 9 }),
        txt('qr-i3', 0, 34, w, 4.5, '冰红茶　　　　 3.00', { fontSize: 9 }),
        rule('qr-rule3', 0, 40, w, '#999999', 0.5),
        txt('qr-total', 0, 42, w, 6, '合计：￥25.00', { fontSize: 12, fontWeight: 'bold', textAlign: 'right' }),
        txt('qr-hint', 0, 51, w, 4, '扫一扫付款', { fontSize: 8, textAlign: 'center', fill: '#555555' }),
        qrcode('qr-code', 17, 56, 16, 16, 'https://pay.example.com/merchant/1001'),
      ]
      return bodyOnly(paper(58, 130, { top: 4, right: 4, bottom: 4, left: 4 }), lines)
    },
  },
  {
    id: 'market-asset-label',
    name: '资产二维码标签',
    category: 'label',
    desc: '50×30 固定资产标签：资产名称/编号 + 二维码（扫码查看资产档案）',
    sizeLabel: '50×30',
    pageW: 50,
    pageH: 30,
    build: () => {
      const w = 46
      const lines: AnyControl[] = [
        txt('as-name', 0, 0, 30, 5, '笔记本电脑', { fontSize: 9, fontWeight: 'bold' }),
        txt('as-no', 0, 6, 30, 4, '编号：ZC-2026-0158', { fontSize: 7.5, fill: '#555555' }),
        txt('as-user', 0, 11, 30, 4, '使用人：张三', { fontSize: 7.5, fill: '#555555' }),
        qrcode('as-qr', 32, 0, 14, 14, 'https://asset.example.com/zc-2026-0158'),
        txt('as-date', 0, 20, 46, 4, '购置日期：2026-05-20', { fontSize: 7.5, fill: '#888888' }),
      ]
      return bodyOnly(paper(50, 30, { top: 3, right: 2, bottom: 3, left: 2 }), lines)
    },
  },
  {
    id: 'market-trace-label',
    name: '商品溯源标签',
    category: 'label',
    desc: '60×40 溯源标签：商品信息 + 二维码（扫码查看溯源/质检信息）',
    sizeLabel: '60×40',
    pageW: 60,
    pageH: 40,
    build: () => {
      const w = 56
      const lines: AnyControl[] = [
        txt('tr-name', 0, 0, w, 5, '有机大米 5kg', { fontSize: 10, fontWeight: 'bold' }),
        txt('tr-spec', 0, 6, w, 4, '产地：黑龙江五常　　批次：2026-A07', { fontSize: 7.5, fill: '#555555' }),
        txt('tr-price', 0, 11, 36, 8, '￥89.00', { fontSize: 16, fontWeight: 'bold', fill: '#e60000' }),
        qrcode('tr-qr', 38, 11, 18, 18, 'https://trace.example.com/lot/2026-A07'),
        txt('tr-note', 0, 32, w, 4, '扫码溯源 · 品质可查', { fontSize: 7.5, textAlign: 'center', fill: '#888888' }),
      ]
      return bodyOnly(paper(60, 40, { top: 3, right: 2, bottom: 3, left: 2 }), lines)
    },
  },

  /* ============ 简历（各专业人才模板：每款独立配色/版式，姓名横幅放正文不占页眉） ============ */

  {
    id: 'market-resume-it',
    name: '简历 · 软件/互联网',
    category: 'resume',
    desc: '深蓝科技风：姓名色带 + 技能胶囊 + 项目经历，工程师感十足',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const banner = bannerBand('ri', '张伟', '高级前端工程师 / 5 年经验', '电话：138-0000-0000　邮箱：zhangwei@example.com　地点：深圳', '#1f3864', '#2f6fed')
      const f = docFlow('ri', 0, DOCW, 40)
      f.part('个人简介', '#2f6fed')
      f.para(13, '专注 Web 前端与跨端工程化，主导过多个百万级用户产品的前端架构设计与性能优化；\n擅长 Vue / React 技术栈与 TypeScript，注重工程规范、可维护性与交付质量。')
      f.part('教育背景', '#2f6fed')
      f.para(12, '2016.09 - 2020.06　某某大学　计算机科学与技术　本科\n主修：数据结构、操作系统、计算机网络、软件工程')
      f.part('工作经历', '#2f6fed')
      f.para(16, '2021.07 - 至今　某某科技有限公司　高级前端工程师\n· 负责核心 SaaS 平台前端架构，落地组件库与微前端方案，构建耗时下降 60%\n· 主导性能专项，首屏时间由 3.2s 优化至 1.1s')
      f.para(12, '2020.07 - 2021.06　某某网络科技　前端工程师\n· 参与电商中台建设，独立负责订单与营销模块前端开发')
      f.part('项目经验', '#2f6fed')
      f.para(12, 'OpenPrint 打印设计器（开源）\n基于 Fabric.js 的可视化打印模板设计器，支持公式 / 图表 / 签名等组件。')
      f.part('技能特长', '#2f6fed')
      const skillRows = [
        ['TypeScript', 'Vue3', 'React', 'Vite'],
        ['Node.js', 'Webpack', '微前端', '性能优化'],
        ['Canvas', '打印排版', 'CI/CD', 'Docker'],
      ]
      let cy = f.top
      for (const row of skillRows) {
        const n = row.length
        const cw = (DOCW - (n - 1) * 3) / n
        row.forEach((s, i) => {
          f.items.push(...chip(`ri-${i}-${Math.round(cy)}`, i * (cw + 3), cy, cw, 6.5, s, '#e8eefb', '#1f3864'))
        })
        cy += 8.5
      }
      return bodyOnly(A4DOC, [...banner, ...f.items])
    },
  },
  {
    id: 'market-resume-finance',
    name: '简历 · 金融/财务',
    category: 'resume',
    desc: '藏蓝+金线商务风：左右分栏姓名 + 宋体大字 + 细分小节',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const banner = bannerSplit('rf', '李娜', '财务分析师 / CPA', '电话：139-0000-0000\n邮箱：lina@example.com\n地点：上海', '#b8860b', '#1f3a5f', '思源宋体')
      const f = docFlow('rf', 0, DOCW, 29)
      f.part('个人简介', '#1f3a5f')
      f.para(13, '6 年财务分析与预算管理经验，熟悉上市公司财报编制与经营分析；\n熟练使用财务系统与数据建模，擅长从财务视角支持业务决策。')
      f.part('教育背景', '#1f3a5f')
      f.para(12, '2014.09 - 2018.06　某某财经大学　会计学　本科\n主修：财务会计、管理会计、审计、税法、金融学')
      f.part('工作经历', '#1f3a5f')
      f.para(16, '2019.07 - 至今　某某集团　财务分析师\n· 负责月度经营分析报告与滚动预算，搭建利润预测模型\n· 主导成本专项，识别并推动降本约 8%')
      f.para(12, '2018.07 - 2019.06　某某会计师事务所　审计专员\n· 参与 3 家上市公司年审，负责收入与往来科目审计')
      f.part('专业证书', '#1f3a5f')
      f.para(12, '注册会计师（CPA）｜税务师｜初级会计职称\n英语 CET-6｜计算机二级（Excel 高级应用）')
      f.part('技能特长', '#1f3a5f')
      f.para(16, '· 财务：报表合并、预算管理、经营分析、税务筹划\n· 工具：Excel / Power BI / SAP / 用友\n· 软技能：跨部门沟通、数据可视化表达')
      return bodyOnly(A4DOC, [...banner, ...f.items])
    },
  },
  {
    id: 'market-resume-teacher',
    name: '简历 · 教师/教育',
    category: 'resume',
    desc: '暖陶土色温雅风：居中姓名 + 短下划线 + 简约小节',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const banner = bannerClassic('rt', '王芳', '中学语文教师 / 班主任', '电话：137-0000-0000　邮箱：wangfang@example.com　地点：杭州', '#b75a3c')
      const f = docFlow('rt', 0, DOCW, 37)
      f.part('个人简介', '#b75a3c')
      f.para(13, '5 年中学语文教学经验，两届毕业班带班，所带班级语文成绩稳居年级前列；\n持有高级中学教师资格证，熟悉新课标与中考命题趋势。')
      f.part('教育背景', '#b75a3c')
      f.para(12, '2015.09 - 2019.06　某某师范大学　汉语言文学（师范）　本科\n主修：古代文学、现当代文学、语文课程与教学论')
      f.part('工作经历', '#b75a3c')
      f.para(16, '2020.09 - 至今　某某中学　语文教师 / 班主任\n· 承担两个班语文教学，兼任年级备课组长\n· 组织课本剧、阅读分享等学科活动，学生参与度高')
      f.para(12, '2019.09 - 2020.08　某某教育培训　语文教研员\n· 参与教材同步讲义编写与师资培训')
      f.part('教学成果', '#b75a3c')
      f.para(12, '· 2023 年获区级“优秀班主任”称号\n· 指导学生获市级作文竞赛一等奖 2 人次')
      f.part('技能特长', '#b75a3c')
      f.para(16, '· 教学：课堂设计、学情分析、培优补差\n· 工具：课件制作（PPT / 希沃）、班级管理系统\n· 其他：普通话一级乙等、书法特长')
      return bodyOnly(A4DOC, [...banner, ...f.items])
    },
  },
  {
    id: 'market-resume-design',
    name: '简历 · 设计/艺术',
    category: 'resume',
    desc: '紫金撞色风：姓名色带 + 装饰圆点 + 技能胶囊，作品集气质',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const banner = bannerBand('rd', '陈墨', 'UI / 视觉设计师', '电话：136-0000-0000　邮箱：chenmo@example.com　地点：广州', '#6d28d9', '#f59e0b')
      // 装饰：横幅右下角半透明圆点，增强设计感
      banner.push(box('rd-deco1', DOCW - 26, 3, 11, 11, 'rgba(255,255,255,0.14)', undefined, 5.5))
      banner.push(box('rd-deco2', DOCW - 13, 11, 6, 6, 'rgba(255,255,255,0.18)', undefined, 3))
      const f = docFlow('rd', 0, DOCW, 40)
      f.part('个人简介', '#7c3aed')
      f.para(13, '4 年互联网产品设计经验，主导过 C 端 App 与 B 端后台的视觉体系搭建；\n追求简洁克制的视觉语言，关注一致性与可用性。')
      f.part('教育背景', '#7c3aed')
      f.para(12, '2017.09 - 2021.06　某某美术学院　视觉传达设计　本科\n主修：平面构成、色彩、界面设计、字体设计')
      f.part('工作经历', '#7c3aed')
      f.para(16, '2021.07 - 至今　某某互联网公司　UI 设计师\n· 负责核心产品 redesign，建立组件库与设计规范\n· 输出运营活动视觉，平均点击率提升 25%')
      f.para(12, '2020.07 - 2021.06　某某设计工作室　实习设计师\n· 参与品牌 VI 与电商详情页设计')
      f.part('设计项目', '#7c3aed')
      f.para(12, '· 某某银行 App 改版（设计主导）\n· 开源图标库 OpenIcons（作者，2k+ 下载）')
      f.part('技能特长', '#7c3aed')
      const skillRows = [
        ['Figma', 'Sketch', 'Photoshop', 'Illustrator'],
        ['AE 动效', '设计系统', '插画', '品牌视觉'],
      ]
      let cy = f.top
      for (const row of skillRows) {
        const n = row.length
        const cw = (DOCW - (n - 1) * 3) / n
        row.forEach((s, i) => {
          f.items.push(...chip(`rd-${i}-${Math.round(cy)}`, i * (cw + 3), cy, cw, 6.5, s, '#f1e9ff', '#6d28d9'))
        })
        cy += 8.5
      }
      return bodyOnly(A4DOC, [...banner, ...f.items])
    },
  },
  {
    id: 'market-resume-medical',
    name: '简历 · 医学/护理',
    category: 'resume',
    desc: '青绿清新风：姓名色带 + 浅绿点缀，干净可信赖',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const banner = bannerBand('rm', '刘洋', '临床护士 / 护师', '电话：135-0000-0000　邮箱：liuyang@example.com　地点：成都', '#0e7c66', '#7fd8c4')
      const f = docFlow('rm', 0, DOCW, 40)
      f.part('个人简介', '#0e7c66')
      f.para(13, '6 年三甲医院临床护理经验，扎实的基础护理与急救能力；\n持有护士执业证书与护师职称，责任心强、沟通能力好。')
      f.part('教育背景', '#0e7c66')
      f.para(12, '2014.09 - 2018.06　某某医科大学　护理学　本科\n主修：基础护理学、内外科护理、急救护理、护理心理学')
      f.part('工作经历', '#0e7c66')
      f.para(16, '2018.07 - 至今　某某三甲医院　临床护士（内科）\n· 负责病房患者全程护理与健康教育\n· 参与科室质控与带教，带教实习护士 10+ 人')
      f.para(12, '2016.07 - 2018.06　某某医院　实习护士\n· 轮转急诊、手术室、病房等科室')
      f.part('专业技能', '#0e7c66')
      f.para(16, '· 操作：静脉输液、心肺复苏、心电监护、无菌操作\n· 能力：病情观察、护患沟通、应急预案执行\n· 其他：电子病历系统、院感防控')
      f.part('证书', '#0e7c66')
      f.para(12, '护士执业证书｜护师职称｜急救技能证（BLS）｜普通话二级甲')
      return bodyOnly(A4DOC, [...banner, ...f.items])
    },
  },
  {
    id: 'market-resume-general',
    name: '简历 · 通用应届',
    category: 'resume',
    desc: '极简现代风：左右分栏姓名 + 蓝色点缀，通用不出错',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const banner = bannerSplit('rg', '赵敏', '应届毕业生 / 市场营销', '电话：133-0000-0000\n邮箱：zhaomin@example.com\n地点：武汉', '#1677ff')
      const f = docFlow('rg', 0, DOCW, 29)
      f.part('个人简介', '#1677ff')
      f.para(13, '市场营销专业应届本科，具备扎实的市场调研与文案功底；\n乐观主动、学习力强，期望在品牌或运营方向深耕成长。')
      f.part('教育背景', '#1677ff')
      f.para(12, '2022.09 - 2026.06　某某大学　市场营销　本科（GPA 3.7/4.0）\n主修：市场营销、消费者行为、统计学、商务数据分析')
      f.part('校园经历', '#1677ff')
      f.para(12, '· 校学生会宣传部部长，统筹校级活动 5 场\n· 市场营销大赛校赛二等奖（团队负责人）')
      f.part('实习经历', '#1677ff')
      f.para(16, '2025.07 - 2025.12　某某品牌公司　市场部实习生\n· 协助社媒内容策划与投放，账号涨粉 1.2w\n· 整理周报与竞品分析，支持活动复盘')
      f.part('技能与自评', '#1677ff')
      f.para(16, '· 工具：Excel / PPT / 剪映 / 秀米\n· 能力：文案撰写、数据分析、活动执行\n· 自评：执行力强、协作性好、抗压能力佳')
      return bodyOnly(A4DOC, [...banner, ...f.items])
    },
  },

  /* ============ 合同（及通用公函） ============ */

  {
    id: 'market-contract-labor',
    name: '劳动合同',
    category: 'contract',
    desc: 'A4 标准劳动合同：双方信息 + 8 项核心条款 + 签章栏',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = DOCW
      const header: AnyControl[] = [
        txt('cl-title', 0, 0, w, 11, '劳 动 合 同 书', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('cl-rule', 0, 16, w, '#1677ff', 1),
      ]
      const f = docFlow('cl', 0, w)
      f.para(14, '甲方（用人单位）：某某科技有限公司　　法定代表人：＿＿＿＿\n乙方（劳动者）：＿＿＿＿　　身份证号：＿＿＿＿＿＿＿＿')
      f.section('第一条　合同期限')
      f.para(12, '本合同为固定期限劳动合同，期限 3 年，自 2026 年 9 月 1 日至 2029 年 8 月 31 日；其中试用期 6 个月。')
      f.section('第二条　工作内容与地点')
      f.para(8, '乙方担任研发类岗位，工作地点为深圳市；甲方可在经营需要范围内合理调整。')
      f.section('第三条　劳动报酬')
      f.para(8, '甲方每月 10 日前以货币形式支付乙方上月工资，试用期工资不低于转正工资的 80%。')
      f.section('第四条　社会保险与福利')
      f.para(8, '甲方依法为乙方缴纳养老、医疗、失业、工伤、生育等社会保险。')
      f.section('第五条　劳动保护')
      f.para(8, '甲方建立健全劳动安全卫生制度，对乙方进行劳动安全卫生教育。')
      f.section('第六条　合同解除')
      f.para(12, '双方协商一致可解除本合同；乙方提前 30 日书面通知甲方可解除本合同。')
      f.section('第七条　违约责任')
      f.para(8, '任何一方违反本合同约定，应承担相应法律责任并赔偿对方损失。')
      f.section('第八条　其他')
      f.para(8, '本合同一式两份，甲乙双方各执一份，自双方签字（盖章）之日起生效。')
      f.advance(3)
      f.para(8, '甲方（盖章）：＿＿＿＿＿＿　　乙方（签字）：＿＿＿＿＿＿')
      f.para(7, '签订日期：2026 年　　月　　日')
      const footer: AnyControl[] = [
        txt('cl-page', 88, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(A4DOC, header, f.items, footer)
    },
  },
  {
    id: 'market-contract-service',
    name: '服务合同',
    category: 'contract',
    desc: 'A4 技术服务合同：委托/服务方 + 服务内容/期限/费用 + 保密与违约',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = DOCW
      const header: AnyControl[] = [
        txt('cs-title', 0, 0, w, 11, '技 术 服 务 合 同', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('cs-rule', 0, 16, w, '#1677ff', 1),
      ]
      const f = docFlow('cs', 0, w)
      f.para(14, '委托方（甲方）：＿＿＿＿＿＿＿＿　　服务方（乙方）：某某技术有限公司')
      f.section('一、服务内容')
      f.para(12, '乙方为甲方提供系统设计与开发服务，具体范围、交付物以附件《需求说明书》为准。')
      f.section('二、服务期限')
      f.para(8, '本合同服务期自 2026 年 9 月 1 日起至 2027 年 2 月 28 日止，共 6 个月。')
      f.section('三、费用与支付')
      f.para(12, '合同总金额人民币 180,000 元（含税）；分三期支付：启动 30%、里程碑 40%、验收 30%。')
      f.section('四、双方权利与义务')
      f.para(12, '甲方应及时提供必要资料与确认；乙方应按约定质量与进度交付，并保障交付物可用。')
      f.section('五、保密条款')
      f.para(8, '双方对在履约中获知的对方商业秘密负有保密义务，保密期至合同终止后 3 年。')
      f.section('六、违约责任')
      f.para(8, '逾期交付或逾期付款的，违约方按日万分之五支付违约金。')
      f.section('七、争议解决')
      f.para(8, '因本合同发生争议，双方协商不成时，提交甲方所在地有管辖权的人民法院诉讼。')
      f.advance(3)
      f.para(8, '甲方（盖章）：＿＿＿＿＿＿　　乙方（盖章）：＿＿＿＿＿＿')
      f.para(7, '签订日期：2026 年　　月　　日')
      const footer: AnyControl[] = [
        txt('cs-page', 88, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(A4DOC, header, f.items, footer)
    },
  },
  {
    id: 'market-contract-lease',
    name: '房屋租赁合同',
    category: 'contract',
    desc: 'A4 房屋租赁合同：房屋情况 + 租期/租金 + 双方义务 + 解除与违约',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = DOCW
      const header: AnyControl[] = [
        txt('cr-title', 0, 0, w, 11, '房 屋 租 赁 合 同', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('cr-rule', 0, 16, w, '#1677ff', 1),
      ]
      const f = docFlow('cr', 0, w)
      f.para(14, '出租方（甲方）：＿＿＿＿　　承租方（乙方）：＿＿＿＿　　身份证号：＿＿＿＿＿＿＿＿')
      f.section('一、房屋基本情况')
      f.para(12, '甲方将位于＿＿＿＿＿＿＿＿＿＿＿＿的房屋出租给乙方，建筑面积约＿＿㎡，用途为居住。')
      f.section('二、租赁期限')
      f.para(8, '租期自 2026 年 9 月 1 日起至 2027 年 8 月 31 日止，共 12 个月。')
      f.section('三、租金及押金')
      f.para(12, '月租金人民币＿＿＿＿元，押一付三；乙方应于每期开始前 5 日内支付。')
      f.section('四、双方义务')
      f.para(12, '甲方保证房屋可正常使用；乙方合理使用、不得擅自转租或改变结构。')
      f.section('五、合同解除')
      f.para(8, '一方违约或不可抗力导致合同无法履行的，另一方可解除合同并追偿损失。')
      f.section('六、违约责任')
      f.para(8, '提前退租的，违约方应赔偿对方一个月租金作为违约金。')
      f.advance(3)
      f.para(8, '甲方（签字）：＿＿＿＿＿＿　　乙方（签字）：＿＿＿＿＿＿')
      f.para(7, '签订日期：2026 年　　月　　日')
      const footer: AnyControl[] = [
        txt('cr-page', 88, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(A4DOC, header, f.items, footer)
    },
  },
  {
    id: 'market-contract-nda',
    name: '保密协议（NDA）',
    category: 'contract',
    desc: 'A4 保密协议：保密信息定义 + 保密义务 + 期限与违约',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = DOCW
      const header: AnyControl[] = [
        txt('cn-title', 0, 0, w, 11, '保 密 协 议 书', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('cn-rule', 0, 16, w, '#1677ff', 1),
      ]
      const f = docFlow('cn', 0, w)
      f.para(14, '披露方（甲方）：＿＿＿＿＿＿＿＿　　接收方（乙方）：＿＿＿＿＿＿＿＿')
      f.section('一、保密信息定义')
      f.para(12, '本协议所称保密信息，指一方以书面、口头或其他形式向另一方披露的、标注或应被合理认定为保密的技术与商业信息。')
      f.section('二、保密义务')
      f.para(12, '接收方应对保密信息严格保密，仅用于约定目的，不得向第三方披露或用于自身利益。')
      f.section('三、保密期限')
      f.para(8, '保密义务自本协议签署之日起生效，至保密信息进入公知领域之日止，最短不少于 3 年。')
      f.section('四、违约责任')
      f.para(8, '接收方违反本协议的，应赔偿披露方因此遭受的全部损失，并承担维权合理费用。')
      f.section('五、其他')
      f.para(8, '本协议一式两份，双方各执一份，自签字（盖章）之日起生效。')
      f.advance(3)
      f.para(8, '甲方（盖章）：＿＿＿＿＿＿　　乙方（盖章）：＿＿＿＿＿＿')
      f.para(7, '签订日期：2026 年　　月　　日')
      const footer: AnyControl[] = [
        txt('cn-page', 88, 3, 90, 6, '第 {{page}} 页 / 共 {{pages}} 页', { fontSize: 9, textAlign: 'right', fill: '#555555' }),
      ]
      return fullPage(A4DOC, header, f.items, footer)
    },
  },

  /* ============ 通用公函 ============ */

  {
    id: 'market-doc-leave',
    name: '请假条 / 证明',
    category: 'doc',
    desc: 'A4 请假条：称呼 + 事由 + 起止时间 + 落款，可改为在职/实习证明',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = DOCW
      const header: AnyControl[] = [
        txt('dl-title', 0, 2, w, 11, '请 假 条', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('dl-rule', 0, 18, w, '#1677ff', 1),
      ]
      const f = docFlow('dl', 0, w)
      f.para(7, '尊敬的领导：')
      f.para(16, '本人因＿＿＿＿＿＿（事/病）需请假，请假时间自 2026 年 9 月 1 日至 2026 年 9 月 5 日，\n共计 5 天。请假期间工作已做好交接安排，恳请批准。')
      f.para(7, '此致\n敬礼')
      f.advance(2)
      f.para(7, '申请人：＿＿＿＿　　联系方式：＿＿＿＿')
      f.para(7, '日期：2026 年　　月　　日')
      f.advance(4)
      f.para(7, '（审批）直属领导意见：＿＿＿＿　　人力资源部：＿＿＿＿')
      return fullPage(A4DOC, header, f.items)
    },
  },
  {
    id: 'market-doc-notice',
    name: '通知 / 公告',
    category: 'doc',
    desc: 'A4 通知公告：标题 + 主送 + 事项条目 + 落款单位/日期',
    sizeLabel: 'A4 · 210×297',
    pageW: 210,
    pageH: 297,
    build: () => {
      const w = DOCW
      const header: AnyControl[] = [
        txt('dn-title', 0, 2, w, 11, '通　　知', { fontSize: 18, fontWeight: 'bold', textAlign: 'center' }),
        rule('dn-rule', 0, 18, w, '#1677ff', 1),
      ]
      const f = docFlow('dn', 0, w)
      f.para(7, '各部门、全体员工：')
      f.para(16, '现将近期有关事项通知如下，请遵照执行：\n一、国庆放假安排：10 月 1 日至 10 月 7 日，共 7 天，10 月 8 日（周六）正常上班。\n二、节前请做好安全检查与数据备份，关闭非必要电源设备。')
      f.para(12, '三、假期值班表另行发布，值班人员保持通讯畅通，遇突发事件及时上报。\n四、本通知自发布之日起执行，如有调整另行通知。')
      f.para(7, '特此通知。')
      f.advance(2)
      f.para(7, '落款单位：某某公司行政部')
      f.para(7, '2026 年 9 月 20 日')
      return fullPage(A4DOC, header, f.items)
    },
  },
]
