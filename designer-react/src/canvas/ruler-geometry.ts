/**
 * ruler-geometry —— 标尺几何计算（纯函数，无 DOM / 无框架依赖）
 *
 * 从 Vue 版 `canvas/rulers/RulerOverlay.vue` 的 computed 中 1:1 抽出。
 * 抽出的理由：刻度换算跨框架重写时最容易错（漏一个 RULER_THICK 就整体偏移 20px），
 * 而「差 20px」在肉眼回归里极难发现。抽成纯函数后可脱离 DOM 断言。
 *
 * 坐标约定（《标尺与辅助系统》§4.3）：
 * - 页面左上角 = 画布坐标 (0,0)，zoom=1 时 1mm = MM_TO_PX px
 * - 画布在 stage 内向右下各偏移 RULER_THICK
 * - 因此：stage 坐标 = 画布坐标 * zoom + viewportOffset + RULER_THICK
 */
import { MM_TO_PX, RULER_THICK } from '@/utils/constants'

export interface RulerTick {
  /** stage 坐标（px） */
  coord: number
  /** 对应的模型毫米值 */
  mm: number
  major: boolean
  label: string | null
}

export interface RulerBand {
  /** 左边缘（画布逻辑 px） */
  left: number
  /** 上边缘（画布逻辑 px） */
  top: number
  /** 宽（画布逻辑 px） */
  width: number
  /** 高（画布逻辑 px） */
  height: number
}

export interface BandGeometry {
  x1: number
  x2: number
  y1: number
  y2: number
  /** 顶标尺带宽度（px） */
  wPx: number
  /** 左标尺带高度（px） */
  hPx: number
  /** 元素宽（mm） */
  widthMm: number
  /** 元素高（mm） */
  heightMm: number
  /** 左标尺高度标签的旋转中心 y */
  hLabelCy: number
}

/** 刻度密度自适应：放大时更密，缩小时更疏 */
export function tickStep(zoom: number): number {
  if (zoom >= 2) return 1
  if (zoom >= 1) return 5
  if (zoom >= 0.5) return 10
  return 20
}

/**
 * 计算某一轴的可见刻度。
 * @param zoom 当前缩放
 * @param offset 视口偏移（**不含** RULER_THICK，函数内部自行加上）
 * @param size 该轴视口尺寸（px）
 */
export function computeTicks(opts: {
  zoom: number
  offset: number
  size: number
}): RulerTick[] {
  const { zoom, offset, size } = opts
  const offsetWithThick = offset + RULER_THICK
  const step = tickStep(zoom)

  // 可见范围内的 mm 区间（向两侧取整，避免边缘漏刻度）
  const startMm = Math.floor(-offsetWithThick / (MM_TO_PX * zoom))
  const endMm = Math.ceil((-offsetWithThick + size) / (MM_TO_PX * zoom))
  // 起点对齐到 step 的整数倍，保证缩放/平移时刻度不会跳动
  const start = Math.floor(startMm / step) * step

  const ticks: RulerTick[] = []
  for (let mm = start; mm <= endMm; mm += step) {
    const coord = mm * MM_TO_PX * zoom + offsetWithThick
    if (coord < RULER_THICK || coord > size) continue
    ticks.push({ coord, mm, major: true, label: String(mm) })
  }
  return ticks
}

/** 选中/拖拽元素在标尺上的高亮带几何 */
export function computeBand(
  band: RulerBand | null,
  vp: { zoom: number; offsetX: number; offsetY: number },
): BandGeometry | null {
  if (!band) return null
  const zoom = vp.zoom
  const offsetX = vp.offsetX + RULER_THICK
  const offsetY = vp.offsetY + RULER_THICK
  const x1 = band.left * zoom + offsetX
  const x2 = (band.left + band.width) * zoom + offsetX
  const y1 = band.top * zoom + offsetY
  const y2 = (band.top + band.height) * zoom + offsetY
  return {
    x1,
    x2,
    y1,
    y2,
    wPx: x2 - x1,
    hPx: y2 - y1,
    widthMm: band.width / MM_TO_PX,
    heightMm: band.height / MM_TO_PX,
    hLabelCy: (y1 + y2) / 2,
  }
}
