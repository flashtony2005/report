/**
 * LabelGrid —— 标签网格（多列重复）展开器
 *
 * ## 语义
 * 一个 `labelgrid` 控件 = 一套**卡片模板**（children，坐标相对卡片左上角）被按
 * **列数 × 行数** 重复平铺。它是一个**纯布局组件**，本身不带数据源：
 *
 * ```
 *  ┌─────────┬─────────┬─────────┐   columns = 3
 *  │  card 0 │  card 1 │  card 2 │   每张卡片 = children 的一份实例，
 *  ├─────────┼─────────┼─────────┤   完全相同地重复（行数由容器高度推导）
 *  │  card 3 │  card 4 │  card 5 │
 *  └─────────┴─────────┴─────────┘
 * ```
 *
 * 每张卡「印什么数据」由放进卡片里的**其他数据组件**负责（数据源是其他组件的事），
 * 标签网格只管把模板平铺 N 份。
 *
 * ## 为什么在分页前「摊平」成普通控件
 * 展开产物是一批**绝对定位的普通控件**（id 加行号后缀），因此：
 * - 分页复用现有「按位置切页」（`layoutStaticOnly` 的 `floor(top / bodyH)`），零特判；
 * - 渲染器 / 导出 / 打印链路完全不需要认识 labelgrid。
 *
 * 关键约束：卡片**不允许跨页**。展开时按页容量成行推进，行不够就整行下移到下一页，
 * 生成的 top 是「跨页绝对坐标」（page * bodyStep + 页内 top），与切页算法自洽。
 */
import type { AnyControl, LabelGridControl } from '@/types/control'
import type { PageUnit } from '@/types/template'
import { fromMm, toMm } from '@/core/units'
import { isControlPrintable } from './data-binder'
import type { EvalContext, GridLine, PageMetrics, RenderWarning } from './types'

/* ------------------------------- 默认值 ------------------------------- */

export const LABEL_GRID_DEFAULT_COLUMNS = 3
export const LABEL_GRID_DEFAULT_GAP = 2

/** 生成控件 id 的分隔标记（协议 id 不含 `~`，可反查归属） */
const GEN_SEP = '~'

/* ------------------------------- 几何解析 ------------------------------- */

export interface GridGeometry {
  columns: number
  gapX: number
  gapY: number
  cardWidth: number
  cardHeight: number
}

/** 卡片模板的包围盒（children 已归一到 0 原点，故等于右下最大边） */
export function labelCardBounds(children: readonly AnyControl[]): {
  width: number
  height: number
} {
  let width = 0
  let height = 0
  for (const c of children) {
    width = Math.max(width, (c.left ?? 0) + (c.width ?? 0))
    height = Math.max(height, (c.top ?? 0) + (c.height ?? 0))
  }
  return { width, height }
}

/**
 * 解析网格几何。**单位无关**：传入什么单位（page.unit）出来就是什么单位，
 * 设计画布与渲染引擎共用此函数，保证「设计即打印」不漂移。
 */
export function resolveGridGeometry(grid: {
  width: number
  height: number
  columns?: number
  gapX?: number
  gapY?: number
  cardWidth?: number
  cardHeight?: number
  children: readonly AnyControl[]
}): GridGeometry {
  const columns = Math.max(1, Math.round(grid.columns ?? LABEL_GRID_DEFAULT_COLUMNS))
  const gapX = Math.max(0, grid.gapX ?? LABEL_GRID_DEFAULT_GAP)
  const gapY = Math.max(0, grid.gapY ?? LABEL_GRID_DEFAULT_GAP)
  const bounds = labelCardBounds(grid.children)

  const autoWidth = (grid.width - gapX * (columns - 1)) / columns
  const cardWidth = Math.max(
    1,
    grid.cardWidth ?? (autoWidth > 0 ? autoWidth : bounds.width || 1),
  )
  const cardHeight = Math.max(1, grid.cardHeight ?? (bounds.height || grid.height || 1))

  return { columns, gapX, gapY, cardWidth, cardHeight }
}

/** 网格内可见的卡片行数（设计画布画几行虚线格子用） */
export function visibleCardRows(heightUnit: number, geo: GridGeometry): number {
  const step = geo.cardHeight + geo.gapY
  if (step <= 0) return 1
  return Math.max(1, Math.floor((heightUnit + geo.gapY) / step))
}

/* ------------------------------- 展开主流程 ------------------------------- */

/** 生成控件 id → 所属卡片的行上下文（配置 dataSource 时逐卡写入；否则恒空=纯布局平铺） */
export type RowCtxMap = Map<string, { row: Record<string, unknown>; rowIndex: number }>

/** 单条网格参考线 + 它落在第几页（page-relative 坐标已在 GridLine 内） */
export interface GridLinePlacement {
  pageIndex: number
  line: GridLine
}

export interface ExpandResult {
  /** labelgrid 已被替换为生成控件的扁平列表；其余控件原样保留、顺序不变 */
  components: AnyControl[]
  rowCtx: RowCtxMap
  warnings: RenderWarning[]
  /** 是否真的展开过（供调用方决定是否走额外分支 / 告警） */
  expanded: boolean
  /** 网格参考线（容器 + 卡片边框），按页切分，供渲染 / 导出画出与设计一致的网络 */
  gridLines: GridLinePlacement[]
}

/** 分页步长（mm）：与 layoutStaticOnly 的按位置切页保持同一真理源（整页相对模型 = 物理页高） */
export function bodyStepMm(metrics: PageMetrics): number {
  // 边距仅作可视化参考线，不再参与分页：整页高作为分页步长
  return Math.max(1, metrics.pageHeight)
}

/**
 * 解析标签网格的逐卡数据数组（dataSource = 数据根对象上的数组路径，如 `items`）。
 * - 未配置 dataSource → null（纯布局平铺）
 * - 配置了但取值不是数组 → null（调用方告警后回退纯布局平铺）
 * - 数组为空 → []（调用方告警后回退纯布局平铺）
 */
function gridDataArray(
  dataSource: string | undefined,
  ctx: EvalContext,
): Array<Record<string, unknown>> | null {
  if (!dataSource) return null
  const v = (ctx.data ?? {})[dataSource]
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : null
}

/**
 * 把正文里的 labelgrid 全部展开为绝对定位的普通控件。
 *
 * - 纯布局平铺（无 dataSource）：总卡片数 = 列数 × 行数（行数由容器高度推导，即属性面板「行数」），
 *   children 被**完全相同地**重复 N 份。
 * - 逐卡数据绑定（有 dataSource）：卡片总数 = 数据条数（每数据一条卡，跨页自洽），
 *   每张卡向 rowCtx 写入 { row: data[cardIndex], rowIndex: cardIndex }，
 *   卡内控件绑定 `{{row.字段}}` / `{{rowIndex + 1}}` 逐卡求值 → 每卡内容不同。
 *
 * @param bodyStep 分页步长（mm）= 物理页高，见 bodyStepMm
 * @param maxPages 最大页数保护（同时兜住超大行数）
 */
export function expandLabelGrids(
  components: readonly AnyControl[],
  ctx: EvalContext,
  unit: PageUnit,
  bodyStep: number,
  maxPages: number,
): ExpandResult {
  const out: AnyControl[] = []
  const rowCtx: RowCtxMap = new Map()
  const warnings: RenderWarning[] = []
  const gridLines: GridLinePlacement[] = []
  let expanded = false

  for (const control of components) {
    if (control.type !== 'labelgrid') {
      out.push(control)
      continue
    }
    expanded = true

    // 整个网格被条件渲染关掉 / 不打印 → 整体跳过
    if (!isControlPrintable(control, ctx)) continue

    // 逐卡数据源：配置后按数据条数平铺，每卡注入行上下文
    const dataArr = gridDataArray(control.dataSource, ctx)
    if (control.dataSource && dataArr === null) {
      warnings.push({
        code: 'LABEL_GRID_DATA_MISSING',
        message: `标签网格数据源「${control.dataSource}」不存在或不是数组，已按纯布局平铺`,
        controlId: control.id,
      })
    } else if (control.dataSource && dataArr !== null && dataArr.length === 0) {
      warnings.push({
        code: 'LABEL_GRID_DATA_EMPTY',
        message: `标签网格数据源「${control.dataSource}」为空，已按纯布局平铺（卡内绑定为空）`,
        controlId: control.id,
      })
    }
    const dataCount = dataArr !== null && dataArr.length > 0 ? dataArr.length : 0

    const children = control.children.filter(
      (c) => c.type !== 'zone' && c.type !== 'labelgrid',
    )
    // 空模板是合法的（用户还没往里放内容）：仍画出网格线，只是没有卡内元素。

    const geo = resolveGridGeometry({ ...control, children })
    const gridLeft = toMm(control.left, unit)
    const gridTop = toMm(control.top, unit)
    const gridWidth = toMm(control.width, unit)
    const gridHeight = toMm(control.height, unit)
    const gapX = toMm(geo.gapX, unit)
    const gapY = toMm(geo.gapY, unit)
    const cardW = toMm(geo.cardWidth, unit)
    const cardH = toMm(geo.cardHeight, unit)
    const stepY = cardH + gapY

    // 总卡片数：配置了逐卡数据源 → 跟随数据条数（每数据一条卡，跨页自洽）；
    // 否则 = 列数 × 行数（行数由容器高度推导）纯布局平铺
    const totalRows = Math.max(1, visibleCardRows(control.height ?? 0, geo))
    const total = dataCount > 0 ? dataCount : geo.columns * totalRows
    if (total <= 0) continue

    const showLines = control.showLines !== false
    const solid = control.lineStyle !== 'dashed'

    /** 某页可用高度能放几行卡片 */
    const rowCapacity = (avail: number): number =>
      stepY <= 0 ? 1 : Math.max(0, Math.floor((avail + gapY) / stepY))

    let pageIndex = 0
    let originTop = gridTop
    let capacity = rowCapacity(bodyStep - gridTop)
    if (capacity <= 0) {
      // 首页从网格 top 起放不下一整行 → 整体下移到下一页顶部
      pageIndex = 1
      originTop = 0
      capacity = rowCapacity(bodyStep)
    }
    if (capacity <= 0) {
      capacity = 1
      warnings.push({
        code: 'ROW_TOO_TALL',
        message: `标签卡高度（${geo.cardHeight}）超过整页可用高度，已强制每页 1 行，可能被裁切`,
        controlId: control.id,
      })
    }

    let rowOnPage = 0
    let truncated = false
    let cardIndex = 0

    while (cardIndex < total) {
      if (rowOnPage >= capacity) {
        pageIndex++
        rowOnPage = 0
        originTop = 0
        capacity = Math.max(1, rowCapacity(bodyStep))
      }
      if (pageIndex >= maxPages) {
        truncated = true
        break
      }

      const rowTop = pageIndex * bodyStep + originTop + rowOnPage * stepY
      // 卡片边框（page-relative 坐标：减掉页偏移，与 PlacedNode 同坐标系）
      if (showLines) {
        const pageRelTop = rowTop - pageIndex * bodyStep
        for (let col = 0; col < Math.min(geo.columns, total - cardIndex); col++) {
          gridLines.push({
            pageIndex,
            line: {
              left: gridLeft + col * (cardW + gapX),
              top: pageRelTop,
              width: cardW,
              height: cardH,
              solid,
            },
          })
        }
      }

      const cardsThisRow = Math.min(geo.columns, total - cardIndex)
      for (let col = 0; col < cardsThisRow; col++) {
        const cardLeft = gridLeft + col * (cardW + gapX)
        for (const child of children) {
          const genId = `${control.id}${GEN_SEP}${cardIndex}${GEN_SEP}${child.id}`
          out.push({
            ...child,
            id: genId,
            left: fromMm(cardLeft + toMm(child.left, unit), unit),
            top: fromMm(rowTop + toMm(child.top, unit), unit),
          } as AnyControl)
          // 逐卡数据绑定：按卡片索引注入行上下文（卡内控件绑定 {{row.字段}} / {{rowIndex}} 逐卡求值）
          if (dataArr) {
            rowCtx.set(genId, { row: dataArr[cardIndex] ?? {}, rowIndex: cardIndex })
          }
        }
        cardIndex++
      }

      rowOnPage++
    }

    if (truncated) {
      warnings.push({
        code: 'PAGE_LIMIT_REACHED',
        message: `标签网格平铺量超过 ${maxPages} 页保护上限，已截断`,
        controlId: control.id,
      })
    }

    // 容器边框按页切分成若干段（跨页时每段落在对应页，避免单条大矩形越页被裁剪）
    if (showLines && gridHeight > 0) {
      const first = Math.floor(gridTop / bodyStep)
      const last = Math.floor((gridTop + gridHeight - 1e-6) / bodyStep)
      for (let p = first; p <= last && p < maxPages; p++) {
        const segTopAbs = Math.max(gridTop, p * bodyStep)
        const segBottomAbs = Math.min(gridTop + gridHeight, (p + 1) * bodyStep)
        if (segBottomAbs - segTopAbs > 1e-6) {
          gridLines.push({
            pageIndex: p,
            line: {
              left: gridLeft,
              top: segTopAbs - p * bodyStep,
              width: gridWidth,
              height: segBottomAbs - segTopAbs,
              solid,
            },
          })
        }
      }
    }
  }

  return { components: out, rowCtx, warnings, expanded, gridLines }
}

/** 把行上下文并进求值上下文（生成控件原样返回，零开销；标签网格当前恒空） */
export function withRowCtx(
  controlId: string,
  ctx: EvalContext,
  rowCtx?: RowCtxMap,
): EvalContext {
  const hit = rowCtx?.get(controlId)
  return hit ? { ...ctx, row: hit.row, rowIndex: hit.rowIndex } : ctx
}
