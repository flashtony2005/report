/**
 * HeaderFooterEngine + 页面度量
 * 真理源：《OpenPrint-设计方案.md》§5.1（sections）、§5.13（orientation 交换）、§5.14（ZoneControl）、§7.2（每页注入）
 *
 * 两件事：
 * 1. computePageMetrics —— 把协议里的纸张定义换算成引擎唯一的尺寸真理源（全 mm）
 * 2. buildSectionControls —— 把 header/footer 的子组件解析成每页可复用的已定位控件
 *
 * 页码变量在**每页单独求值**（`{{page}} / {{pages}}`），所以页眉页脚不能只解析一次就复用，
 * 必须按页重算 —— 这是"第 X 页 / 共 Y 页"能正确输出的关键。
 */
import type { AnyControl } from '@/types/control'
import type { PageSetup, Section } from '@/types/template'
import { toMm } from '@/core/units'
import { isControlPrintable, resolveControlContent } from './data-binder'
import type { EvalContext, PageMetrics, PlacedControl, RenderWarning } from './types'

/* ------------------------------- 页面度量 ------------------------------- */

/**
 * 计算一页的可用区域。
 * 【约定】PageSetup.width/height 是**物理尺寸**（实际打印宽高，横向时宽>高），
 * orientation 仅是派生标志（设计器面板切换方向时已交换宽高）。
 * 这里**不再**按 orientation 交换 —— 与设计器 setPage、导出 export-pdf（w>h 判定）同口径。
 */
export function computePageMetrics(
  page: PageSetup,
  headerSection?: Section<AnyControl>,
  footerSection?: Section<AnyControl>,
): PageMetrics {
  const unit = page.unit
  const pageWidth = toMm(page.width, unit)
  const pageHeight = toMm(page.height, unit)

  const margin = {
    top: toMm(page.margin?.top ?? 0, unit),
    right: toMm(page.margin?.right ?? 0, unit),
    bottom: toMm(page.margin?.bottom ?? 0, unit),
    left: toMm(page.margin?.left ?? 0, unit),
  }

  const contentWidth = Math.max(0, pageWidth - margin.left - margin.right)
  const contentHeight = Math.max(0, pageHeight - margin.top - margin.bottom)

  const headerHeight = headerSection ? toMm(headerSection.height ?? 0, unit) : 0
  const footerHeight = footerSection ? toMm(footerSection.height ?? 0, unit) : 0
  // 正文可用高基准（流式表格切页预算）：沿用「页高 - 上下边距」。
  // 说明：边距对「绝对定位控件」已完全不参与渲染偏移（见 css-generator / CanvasDesigner），
  // 但对绑定了数据源的流式表格，保留内容区高度作为切页预算可避免末页出现空白尾页（回归），
  // 且表格 top 现已为整页相对坐标，顶部偏移问题同样解决。
  // 页眉/页脚色带占位（headerHeight/footerHeight）不在 metrics 层扣除，
  // 由 paginateFlowTable 按页裁剪：非首页切片从页眉下方起、每页可用高 = 页高 - 页眉 - 页脚。
  const bodyHeight = contentHeight

  return {
    pageWidth,
    pageHeight,
    margin,
    contentWidth,
    contentHeight,
    headerHeight,
    footerHeight,
    // 保留 bodyHeight 字段名，其语义现在等同于 contentHeight（与渲染 .op-body 高度一致）
    bodyHeight,
  }
}

/* ------------------------------ 区块控件构建 ----------------------------- */

/**
 * 把一个 section 的子组件解析成已定位控件。
 * 坐标已经是相对区块左上角（设计器序列化时保证），这里原样透传。
 */
export async function buildSectionControls(
  components: AnyControl[] | undefined,
  ctx: EvalContext,
  unit: PageSetup['unit'],
): Promise<{ controls: PlacedControl[]; warnings: RenderWarning[] }> {
  const controls: PlacedControl[] = []
  const warnings: RenderWarning[] = []
  if (!components?.length) return { controls, warnings }

  for (const control of components) {
    // zone 不应出现在 section.components 里（设计器已拆平），保险起见跳过
    if (control.type === 'zone') continue
    if (!isControlPrintable(control, ctx)) continue

    const { content, warnings: w } = await resolveControlContent(control, ctx)
    warnings.push(...w)
    controls.push({
      kind: 'control',
      id: control.id,
      left: toMm(control.left, unit),
      top: toMm(control.top, unit),
      width: toMm(control.width, unit),
      height: toMm(control.height, unit),
      angle: control.angle,
      content,
      control,
    })
  }

  return { controls, warnings }
}

/* ------------------------------- 出现规则 ------------------------------- */

/**
 * 区块是否在该页出现。
 * §5.1：`repeat` 默认 true（每页重复）。repeat=false 时按业界惯例：
 * - 页眉只出现在**首页**（封面式抬头）
 * - 页脚只出现在**末页**（签章/合计式收尾）
 */
export function shouldRenderSection(
  section: Section<AnyControl> | undefined,
  type: 'header' | 'footer',
  pageIndex: number,
  totalPages: number,
): boolean {
  if (!section) return false
  const repeat = section.repeat ?? true
  if (repeat) return true
  return type === 'header' ? pageIndex === 0 : pageIndex === totalPages - 1
}
