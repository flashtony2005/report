/**
 * SmartGuides —— 智能吸附对齐线（增强版）
 *
 * 拖拽控件时与其他控件/页面/页边距的边缘、中心对齐吸附，
 * 四边同时检测，命中后在 contextTop 上画参考线。
 * Shift 按住时临时禁用吸附。
 *
 * 渲染内容：
 * 1. 蓝色虚线边界辅助线 —— 沿元素上下左右 4 条边横穿整个画布，对齐标尺
 * 2. 红色实线 —— 边缘/中心吸附命中线（Figma 红粉）
 * 3. 绿色标签 —— 吸附间距（mm 数值）
 * 4. 灰色标签 —— 元素实时坐标（mm）
 */
import type { Canvas, FabricObject, Rect } from 'fabric'
import { MM_TO_PX, DEFAULT_SNAP_THRESHOLD, RULER_THICK } from '@/utils/constants'
import { isPrintObject } from '../controls'
import { rulerBand } from '../rulers/rulerHighlight'
import { computeMarginSnapLines } from './margin-snap'

const SNAP_PX = DEFAULT_SNAP_THRESHOLD * MM_TO_PX

/** 配色方案：
 *  蓝   = 元素边界辅助线（用户指定）
 *  玫红 = 吸附命中（与边界线区分）
 *  翠绿 = 距离标签
 *  灰   = 实时坐标信息
 *  护眼绿底白字药丸 = 辅助线端点坐标读数
 */
const COLOR_BOUNDING = '#378ADD'
const COLOR_SNAP = '#F43F5E'
const COLOR_DISTANCE = '#10B981'
const COLOR_POSITION = '#AFB4BD'
/** 药丸底色（护眼绿，白字；不透明保证浅/深色画布均清晰） */
const CHIP_BG = '#3FA776'
const CHIP_BORDER = 'rgba(255,255,255,0.45)'
const CHIP_FG = '#FFFFFF'

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

interface SnapCandidate {
  value: number
  orientation: 'v' | 'h'
  source: 'page' | 'margin' | 'element'
}

interface SnapResult {
  line: number
  orientation: 'v' | 'h'
  source: 'page' | 'margin' | 'element'
  /** 命中的吸附候选值 */
  candidateValue: number
  /** 目标边的原始值 */
  targetValue: number
}

interface MarginMm {
  top: number
  bottom: number
  left: number
  right: number
}

export interface SmartGuidesConfig {
  /** 网格尺寸（mm） */
  gridSizeMm: number
  /** 视觉网格线开关（仅作参考、不强绑定元素） */
  gridVisible: boolean
  /** 视觉网格线颜色（rgba / hex） */
  gridColor: string
}

/* ------------------------------------------------------------------ */
/*  SmartGuides                                                        */
/* ------------------------------------------------------------------ */

export class SmartGuides {
  private canvas: Canvas
  private getPage: () => Rect
  private getMarginMm: () => MarginMm
  private snapResults: SnapResult[] = []
  private movingTarget: FabricObject | null = null
  private shiftHeld = false
  private lastSnapV: SnapResult | null = null
  private lastSnapH: SnapResult | null = null

  /** 网格配置（由 CanvasDesigner 通过 setter 控制；仅视觉参考，不吸附） */
  config: SmartGuidesConfig = {
    gridSizeMm: 5,
    gridVisible: false,
    gridColor: 'rgba(120,130,145,0.5)',
  }

  /* ---------- 事件处理 ---------- */

  private onMoving = (e: { target?: FabricObject }) => {
    const target = e.target
    if (!target) {
      this.movingTarget = null
      this.snapResults = []
      rulerBand.value = null
      return
    }
    this.movingTarget = target
    if (!this.shiftHeld) this.snap(target)
    this.syncBand(target)
  }

  /** 缩放时也同步标尺高亮带（不改辅助线，只反映尺寸变化） */
  private onScaling = (e: { target?: FabricObject }) => {
    const target = e.target
    if (target) this.syncBand(target)
  }

  /** 选中/切换选中：把高亮带对准当前活动元素 */
  private onSelection = () => {
    const obj = this.canvas.getActiveObject()
    if (obj && isPrintObject(obj)) this.syncBand(obj)
    else rulerBand.value = null
  }

  private onSelectionCleared = () => {
    rulerBand.value = null
  }

  /** 把元素的包围盒（画布逻辑 px）写入标尺高亮带；非法尺寸则清除 */
  private syncBand(target: FabricObject): void {
    const b = target.getBoundingRect()
    if (b.width > 0 && b.height > 0) {
      rulerBand.value = { left: b.left, top: b.top, width: b.width, height: b.height }
    } else {
      rulerBand.value = null
    }
  }

  private onUp = () => {
    this.movingTarget = null
    this.snapResults = []
    // 注意：不清空 rulerBand —— 拖拽结束后元素仍处于选中态，高亮带保留反映其位置/尺寸
    this.canvas.requestRenderAll()
  }

  private onAfterRender = (opt: { ctx: CanvasRenderingContext2D }) => {
    // 网格始终可见（独立于拖拽）
    this.drawGrid(opt.ctx)
    // 拖拽时覆盖吸附辅助线（网格上叠加）
    if (this.movingTarget) {
      this.draw(opt.ctx)
    }
    // 常驻辅助线：开启 showGuides 的控件始终显示（与拖拽状态无关）
    this.drawPersistent(opt.ctx)
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Shift') this.shiftHeld = e.type === 'keydown'
  }

  /* ---------- 生命周期 ---------- */

  constructor(
    canvas: Canvas,
    getPage: () => Rect,
    getMarginMm: () => MarginMm,
  ) {
    this.canvas = canvas
    this.getPage = getPage
    this.getMarginMm = getMarginMm

    canvas.on('object:moving', this.onMoving)
    canvas.on('object:scaling', this.onScaling)
    canvas.on('mouse:up', this.onUp)
    canvas.on('selection:created', this.onSelection)
    canvas.on('selection:updated', this.onSelection)
    canvas.on('selection:cleared', this.onSelectionCleared)
    canvas.on('after:render', this.onAfterRender)
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKey)
  }

  dispose(): void {
    this.canvas.off('object:moving', this.onMoving)
    this.canvas.off('object:scaling', this.onScaling)
    this.canvas.off('mouse:up', this.onUp)
    this.canvas.off('selection:created', this.onSelection)
    this.canvas.off('selection:updated', this.onSelection)
    this.canvas.off('selection:cleared', this.onSelectionCleared)
    this.canvas.off('after:render', this.onAfterRender)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKey)
  }

  /* ---------- 候选集收集 ---------- */

  private collectCandidates(skip: FabricObject): SnapCandidate[] {
    const page = this.getPage()
    const margin = this.getMarginMm()
    const pw = page.width
    const ph = page.height
    // 右/下边距内边界必须从**当前页面尺寸**推导（此前硬编码 A4 的 210/297，
    // 非 A4 页面（如 100×150mm 标签）右/下边距吸附线会错位到页外）
    const lines = computeMarginSnapLines(pw, ph, margin)
    const ml = lines.left
    const mr = lines.right
    const mt = lines.top
    const mb = lines.bottom
    const results: SnapCandidate[] = []

    // 1. 页面边缘 + 中心（始终存在于未命名候选列表中）
    const addV = (value: number, source: SnapCandidate['source']) => results.push({ value, orientation: 'v', source })
    const addH = (value: number, source: SnapCandidate['source']) => results.push({ value, orientation: 'h', source })

    // 页面
    addV(0, 'page'); addV(pw / 2, 'page'); addV(pw, 'page')
    addH(0, 'page'); addH(ph / 2, 'page'); addH(ph, 'page')

    // 页边距（内边界）
    addV(ml, 'margin'); addV(mr, 'margin')
    addH(mt, 'margin'); addH(mb, 'margin')
    // 页边距中心
    addV(ml + (mr - ml) / 2, 'margin')
    addH(mt + (mb - mt) / 2, 'margin')

    // 2. 其他控件
    for (const obj of this.canvas.getObjects()) {
      if (obj === skip || obj === page || !isPrintObject(obj)) continue
      const b = obj.getBoundingRect()
      if (b.width === 0 && b.height === 0) continue
      addV(b.left, 'element')
      addV(b.left + b.width / 2, 'element')
      addV(b.left + b.width, 'element')
      addH(b.top, 'element')
      addH(b.top + b.height / 2, 'element')
      addH(b.top + b.height, 'element')
    }

    return results
  }

  /* ---------- 吸附计算 ---------- */

  private snap(target: FabricObject): void {
    const b = target.getBoundingRect()
    if (b.width === 0 && b.height === 0) { this.snapResults = []; return }

    const candidates = this.collectCandidates(target)
    const vCands = candidates.filter((c) => c.orientation === 'v')
    const hCands = candidates.filter((c) => c.orientation === 'h')

    // 目标六条参考位置
    const vTargets = [
      { key: 'left',    value: b.left },
      { key: 'centerX', value: b.left + b.width / 2 },
      { key: 'right',   value: b.left + b.width },
    ]
    const hTargets = [
      { key: 'top',     value: b.top },
      { key: 'centerY', value: b.top + b.height / 2 },
      { key: 'bottom',  value: b.top + b.height },
    ]

    this.snapResults = []

    // --- 记录所有命中（用于渲染辅助线） ---
    for (const t of vTargets) {
      for (const c of vCands) {
        if (Math.abs(c.value - t.value) <= SNAP_PX) {
          this.snapResults.push({
            line: c.value,
            orientation: 'v',
            source: c.source,
            candidateValue: c.value,
            targetValue: t.value,
          })
        }
      }
    }
    for (const t of hTargets) {
      for (const c of hCands) {
        if (Math.abs(c.value - t.value) <= SNAP_PX) {
          this.snapResults.push({
            line: c.value,
            orientation: 'h',
            source: c.source,
            candidateValue: c.value,
            targetValue: t.value,
          })
        }
      }
    }

    // --- 取最佳吸附线应用位置修正（候选线吸附；网格仅作参考、不强绑定） ---
    let bestV: SnapResult | null = null
    let bestVDist = Infinity
    for (const t of vTargets) {
      for (const c of vCands) {
        const dist = Math.abs(c.value - t.value)
        if (dist <= SNAP_PX && dist < bestVDist) {
          bestVDist = dist
          bestV = {
            line: c.value,
            orientation: 'v',
            source: c.source,
            candidateValue: c.value,
            targetValue: t.value,
          }
        }
      }
    }
    let bestH: SnapResult | null = null
    let bestHDist = Infinity
    for (const t of hTargets) {
      for (const c of hCands) {
        const dist = Math.abs(c.value - t.value)
        if (dist <= SNAP_PX && dist < bestHDist) {
          bestHDist = dist
          bestH = {
            line: c.value,
            orientation: 'h',
            source: c.source,
            candidateValue: c.value,
            targetValue: t.value,
          }
        }
      }
    }

    if (bestV) {
      const delta = bestV.candidateValue - bestV.targetValue
      target.set('left', (target.left ?? 0) + delta)
      target.setCoords()
    }
    if (bestH) {
      const delta = bestH.candidateValue - bestH.targetValue
      target.set('top', (target.top ?? 0) + delta)
      target.setCoords()
    }

    this.lastSnapV = bestV
    this.lastSnapH = bestH
  }

  /* ---------- 渲染 ---------- */

  private draw(ctx: CanvasRenderingContext2D): void {
    const target = this.movingTarget
    if (!target) return

    const vt = this.canvas.viewportTransform!
    const zoom = this.canvas.getZoom()
    const b = target.getBoundingRect()

    // 画布可视范围（逻辑坐标）：含页面外的灰色区域。
    // 元素拖出模板（A4）范围时，辅助线也贯穿整个画布、跟着出去。
    const cw = this.canvas.getWidth()
    const ch = this.canvas.getHeight()
    const viewX0 = -vt[4] / vt[0]
    const viewX1 = (cw - vt[4]) / vt[0]
    const viewY0 = -vt[5] / vt[3]
    const viewY1 = (ch - vt[5]) / vt[3]

    ctx.save()
    // 应用视口变换，后续坐标都是画布逻辑坐标
    ctx.transform(vt[0], vt[1], vt[2], vt[3], vt[4], vt[5])

    // 反锯齿
    ctx.imageSmoothingEnabled = false

    // --- 1. 蓝色虚线边界辅助线：沿元素上下左右 4 条边，横穿整个可视画布（含页面外） ---
    this.drawBoundary(ctx, b, viewX0, viewX1, viewY0, viewY1, zoom)

    // --- 2. 红色实线：吸附命中线（贯穿可视画布） ---
    // 去重（同一位置可能有多条记录）
    const drawn = new Set<string>()
    ctx.strokeStyle = COLOR_SNAP
    ctx.lineWidth = 1.5 / zoom
    for (const r of this.snapResults) {
      const key = `${r.orientation}:${r.line.toFixed(3)}`
      if (drawn.has(key)) continue
      drawn.add(key)

      ctx.beginPath()
      if (r.orientation === 'v') {
        ctx.moveTo(r.line, viewY0); ctx.lineTo(r.line, viewY1)
      } else {
        ctx.moveTo(viewX0, r.line); ctx.lineTo(viewX1, r.line)
      }
      ctx.stroke()
    }

    // --- 3. 绿色距离标签（吸附间距 mm） ---
    const fontScale = 1 / zoom
    ctx.fillStyle = COLOR_DISTANCE
    ctx.font = `${Math.max(10, 11 * fontScale)}px "Inter", "PingFang SC", sans-serif`

    const labelDrawn = new Set<string>()
    for (const r of this.snapResults) {
      const distMm = r.candidateValue - r.targetValue
      const absDist = (Math.abs(distMm) / MM_TO_PX).toFixed(1)
      const lk = `${r.orientation}:${r.line.toFixed(3)}:${absDist}`
      if (labelDrawn.has(lk)) continue
      labelDrawn.add(lk)

      let lx: number, ly: number
      if (r.orientation === 'v') {
        lx = r.line + 4 / zoom
        ly = b.top - 4 / zoom
      } else {
        lx = b.left - 4 / zoom
        ly = r.line - 4 / zoom
      }
      // 确保标签在画布可见范围内
      lx = Math.max(4 / zoom, Math.min(viewX1 - 60 / zoom, lx))
      ly = Math.max(8 / zoom, Math.min(viewY1, ly))
      ctx.fillText(`${absDist} mm`, lx, ly)
    }

    // --- 4. 元素实时坐标（左上角） ---
    const xMm = (b.left / MM_TO_PX).toFixed(1)
    const yMm = (b.top / MM_TO_PX).toFixed(1)
    ctx.fillStyle = COLOR_POSITION
    ctx.font = `${Math.max(9, 10 * fontScale)}px "Inter", "PingFang SC", sans-serif`
    const posLabelX = b.left + 3 / zoom
    const posLabelY = b.top - 5 / zoom
    ctx.fillText(`X:${xMm} Y:${yMm}`, Math.max(0, posLabelX), Math.max(10 / zoom, posLabelY))

    // --- 5. 辅助线端点坐标标签（对齐标尺位置，mm） ---
    this.drawChips(ctx, b, viewX0, viewX1, viewY0, viewY1, zoom)

    ctx.restore()
  }

  /** 蓝色虚线边界辅助线：沿元素上下左右 4 条边，横穿整个可视画布（含页面外） */
  private drawBoundary(
    ctx: CanvasRenderingContext2D,
    b: { left: number; top: number; width: number; height: number },
    viewX0: number, viewX1: number, viewY0: number, viewY1: number,
    zoom: number,
  ): void {
    const x0 = b.left
    const x1 = b.left + b.width
    const y0 = b.top
    const y1 = b.top + b.height
    ctx.strokeStyle = COLOR_BOUNDING
    ctx.lineWidth = 1 / zoom
    ctx.setLineDash([4 / zoom, 3 / zoom])
    ctx.beginPath()
    // 顶/底边水平线（横穿整画布，对齐水平标尺）
    ctx.moveTo(viewX0, y0); ctx.lineTo(viewX1, y0)
    ctx.moveTo(viewX0, y1); ctx.lineTo(viewX1, y1)
    // 左/右边竖直线（竖穿整画布，对齐垂直标尺）
    ctx.moveTo(x0, viewY0); ctx.lineTo(x0, viewY1)
    ctx.moveTo(x1, viewY0); ctx.lineTo(x1, viewY1)
    ctx.stroke()
    ctx.setLineDash([])
  }

  /** 辅助线端点坐标标签（靠近标尺那一头，mm） */
  private drawChips(
    ctx: CanvasRenderingContext2D,
    b: { left: number; top: number; width: number; height: number },
    viewX0: number, viewX1: number, viewY0: number, viewY1: number,
    zoom: number,
  ): void {
    const x0 = b.left
    const x1 = b.left + b.width
    const y0 = b.top
    const y1 = b.top + b.height
    // 放在「靠近标尺那一头」，但必须越过 RulerOverlay 覆盖层（左垂直标尺 / 顶水平标尺各 RULER_THICK px），
    // 否则文字会被标尺 DOM 遮住看不见。各偏移 RULER_THICK+4px 正好落在标尺外侧的画布可见区。
    const clampY = (v: number) => Math.max(viewY0 + (RULER_THICK + 6) / zoom, Math.min(viewY1 - 6 / zoom, v))
    const clampX = (v: number) => Math.max(viewX0 + (RULER_THICK + 6) / zoom, Math.min(viewX1 - 6 / zoom, v))
    // 水平线（顶/底）显示 Y，贴在左端、标尺外侧
    this.drawChip(ctx, `Y ${(y0 / MM_TO_PX).toFixed(1)}`, viewX0 + (RULER_THICK + 4) / zoom, clampY(y0), zoom, CHIP_BG, CHIP_BORDER, CHIP_FG)
    this.drawChip(ctx, `Y ${(y1 / MM_TO_PX).toFixed(1)}`, viewX0 + (RULER_THICK + 4) / zoom, clampY(y1), zoom, CHIP_BG, CHIP_BORDER, CHIP_FG)
    // 竖直线（左/右）显示 X，贴在顶端、标尺外侧
    this.drawChip(ctx, `X ${(x0 / MM_TO_PX).toFixed(1)}`, clampX(x0), viewY0 + (RULER_THICK + 4) / zoom, zoom, CHIP_BG, CHIP_BORDER, CHIP_FG)
    this.drawChip(ctx, `X ${(x1 / MM_TO_PX).toFixed(1)}`, clampX(x1), viewY0 + (RULER_THICK + 4) / zoom, zoom, CHIP_BG, CHIP_BORDER, CHIP_FG)
  }

  /** 常驻辅助线：遍历开启 showGuides 的控件，始终绘制其 4 条边界线 + 坐标标签（不限于拖拽时） */
  private drawPersistent(ctx: CanvasRenderingContext2D): void {
    const movingId = this.movingTarget ? (this.movingTarget as unknown as { controlId?: string }).controlId : undefined
    const vt = this.canvas.viewportTransform!
    const zoom = this.canvas.getZoom()
    const cw = this.canvas.getWidth()
    const ch = this.canvas.getHeight()
    const viewX0 = -vt[4] / vt[0]
    const viewX1 = (cw - vt[4]) / vt[0]
    const viewY0 = -vt[5] / vt[3]
    const viewY1 = (ch - vt[5]) / vt[3]

    for (const obj of this.canvas.getObjects()) {
      if (!isPrintObject(obj)) continue
      if ((obj as unknown as { showGuides?: boolean }).showGuides !== true) continue
      if ((obj as unknown as { controlId?: string }).controlId === movingId) continue // 拖拽中由 draw() 处理，避免重绘
      const b = obj.getBoundingRect()
      if (b.width === 0 && b.height === 0) continue
      ctx.save()
      ctx.transform(vt[0], vt[1], vt[2], vt[3], vt[4], vt[5])
      ctx.imageSmoothingEnabled = false
      this.drawBoundary(ctx, b, viewX0, viewX1, viewY0, viewY1, zoom)
      this.drawChips(ctx, b, viewX0, viewX1, viewY0, viewY1, zoom)
      ctx.restore()
    }
  }

  /** 网格视觉线绘制（零依赖，内联到 draw 前调用） */
  private drawGrid(ctx: CanvasRenderingContext2D): void {
    if (!this.config.gridVisible) return
    const vt = this.canvas.viewportTransform!
    const zoom = this.canvas.getZoom()
    if (zoom < 0.3) return // 太小不绘，否则糊成一片
    const page = this.getPage()
    const step = this.config.gridSizeMm * MM_TO_PX

    ctx.save()
    ctx.transform(vt[0], vt[1], vt[2], vt[3], vt[4], vt[5])
    ctx.strokeStyle = this.config.gridColor
    ctx.lineWidth = 0.5 / zoom
    ctx.beginPath()
    for (let x = 0; x <= page.width; x += step) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, page.height)
    }
    for (let y = 0; y <= page.height; y += step) {
      ctx.moveTo(0, y)
      ctx.lineTo(page.width, y)
    }
    ctx.stroke()
    ctx.restore()
  }

  /** 圆角矩形路径（Canvas2D 无原生 roundRect 兼容写法） */
  private roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  /** 小药丸标签：不透明深色底 + 浅色描边 + 白字，用于辅助线端点显示标尺坐标（mm）。
   *  不透明底色保证在浅色页面与深色画布上都清晰可读；浅描边让药丸边缘在深色背景中也能被分辨。 */
  private drawChip(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    zoom: number,
    bg: string,
    border: string,
    fg: string,
  ): void {
    ctx.save()
    ctx.font = `600 ${Math.max(10, 11 / zoom)}px "Inter", "PingFang SC", sans-serif`
    ctx.textBaseline = 'middle'
    const padX = 4 / zoom
    const h = (11 / zoom) + (4 / zoom)
    const w = ctx.measureText(text).width + padX * 2
    const top = y - h / 2
    const radius = 3 / zoom

    // 不透明底色
    ctx.beginPath()
    this.roundRectPath(ctx, x, top, w, h, radius)
    ctx.fillStyle = bg
    ctx.fill()
    // 浅色描边，确保深色背景下药丸边缘可见
    ctx.lineWidth = 1 / zoom
    ctx.strokeStyle = border
    ctx.stroke()

    // 文字
    ctx.fillStyle = fg
    ctx.fillText(text, x + padX, y)
    ctx.restore()
  }
}
