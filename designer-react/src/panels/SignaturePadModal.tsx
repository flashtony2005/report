/**
 * SignaturePadModal —— 弹出式手写签名面板（React 版 / antd，WPS 式）
 *
 * 从 Vue 版 `SignaturePadModal.vue` 迁移（P5.3）。行为对齐：
 * - 笔迹以「笔画栈」存储（每笔 = 点序列 + 笔宽 + 笔色），支持撤销 / 清空并重绘；
 * - 确认时按实际笔迹包围盒裁剪透明留白，导出 PNG（2× 高清），控件宽高 = 包围盒(mm)；
 * - 落点：拖拽触发时用 pendingSignatureDrop，点击插入回落内容区默认 (60mm, 60mm)。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button, ColorPicker, InputNumber, Modal, Slider, message } from 'antd'
import { useDesignerStore } from '../stores/designer'
import './signature-pad.css'

/** 画板逻辑尺寸（CSS px）；满宽映射 60mm，保证插入尺寸自然 */
const PAD_W = 480
const PAD_H = 220
/** 1 CSS px → mm（满宽 480px = 60mm） */
const PX_TO_MM = 60 / PAD_W
/** 导出倍率：导出 PNG 用 2× 保证打印清晰 */
const EXPORT_SCALE = 2

interface Point {
  x: number
  y: number
}
interface Stroke {
  points: Point[]
  penWidth: number
  color: string
}

const PRESET_COLORS = ['#000000', '#d4380d', '#1677ff', '#237804', '#722ed1']

let dpr = 1

const round1 = (v: number): number => Math.round(v * 10) / 10

export default function SignaturePadModal(): ReactElement {
  const open = useDesignerStore((s) => s.signatureModalOpen)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const drawingRef = useRef(false)
  const [strokesCount, setStrokesCount] = useState(0)
  const [penWidth, setPenWidth] = useState(1)
  const [penColor, setPenColor] = useState('#000000')

  /** 重绘全部笔画（clear + replay），用于清空 / 撤销 / 尺寸就绪 */
  const redraw = (): void => {
    const el = canvasRef.current
    const ctx = el?.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, PAD_W * dpr, PAD_H * dpr)
    ctx.scale(dpr, dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of strokesRef.current) drawStroke(ctx, s)
  }

  /** 初始化画板尺寸 + 清空 */
  const setupCanvas = (): void => {
    const el = canvasRef.current
    if (!el) return
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    el.width = Math.round(PAD_W * dpr)
    el.height = Math.round(PAD_H * dpr)
    el.style.width = `${PAD_W}px`
    el.style.height = `${PAD_H}px`
    redraw()
  }

  // 每次打开重置画板
  useEffect(() => {
    if (!open) return
    strokesRef.current = []
    drawingRef.current = false
    setStrokesCount(0)
    setPenWidth(1)
    setPenColor('#000000')
    // 等 DOM 挂载后再初始化画板尺寸
    const raf = requestAnimationFrame(() => setupCanvas())
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 计算笔迹在画板中的最小包围盒（CSS px） */
  const trimmedBounds = (): { x: number; y: number; w: number; h: number } | null => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const s of strokesRef.current) {
      for (const p of s.points) {
        // 笔宽外扩半个线宽，避免裁掉边缘
        const r = s.penWidth / 2
        minX = Math.min(minX, p.x - r)
        minY = Math.min(minY, p.y - r)
        maxX = Math.max(maxX, p.x + r)
        maxY = Math.max(maxY, p.y + r)
      }
    }
    if (!Number.isFinite(minX)) return null
    const x = Math.max(0, Math.floor(minX))
    const y = Math.max(0, Math.floor(minY))
    const w = Math.min(PAD_W, Math.ceil(maxX)) - x
    const h = Math.min(PAD_H, Math.ceil(maxY)) - y
    if (w <= 0 || h <= 0) return null
    return { x, y, w, h }
  }

  /** 导出裁剪后的 PNG data-URI（EXPORT_SCALE 倍分辨率） */
  const exportPng = (): string | null => {
    const bounds = trimmedBounds()
    if (!bounds) return null
    const el = canvasRef.current
    if (!el) return null
    const out = document.createElement('canvas')
    out.width = Math.round(bounds.w * EXPORT_SCALE)
    out.height = Math.round(bounds.h * EXPORT_SCALE)
    const octx = out.getContext('2d')!
    // 从主画板（backing 坐标 = css * dpr）裁剪对应区域到导出画板
    octx.drawImage(
      el,
      bounds.x * dpr,
      bounds.y * dpr,
      bounds.w * dpr,
      bounds.h * dpr,
      0,
      0,
      out.width,
      out.height,
    )
    return out.toDataURL('image/png')
  }

  const pointerPos = (e: PointerEvent): Point => {
    const el = canvasRef.current!
    const rect = el.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * PAD_W
    const y = ((e.clientY - rect.top) / rect.height) * PAD_H
    return { x: Math.max(0, Math.min(PAD_W, x)), y: Math.max(0, Math.min(PAD_H, y)) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const el = canvasRef.current
    if (!el) return
    el.setPointerCapture?.(e.pointerId)
    drawingRef.current = true
    const p = pointerPos(e.nativeEvent)
    strokesRef.current.push({ points: [p], penWidth, color: penColor })
    setStrokesCount(strokesRef.current.length)
    const ctx = el.getContext('2d')
    if (ctx) {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.fillStyle = penColor
      ctx.beginPath()
      ctx.arc(p.x, p.y, penWidth / 2, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return
    e.preventDefault()
    const stroke = strokesRef.current[strokesRef.current.length - 1]
    if (!stroke) return
    const p = pointerPos(e.nativeEvent)
    const last = stroke.points[stroke.points.length - 1]!
    stroke.points.push(p)
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) {
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = stroke.penWidth
      ctx.beginPath()
      ctx.moveTo(last.x, last.y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return
    drawingRef.current = false
    canvasRef.current?.releasePointerCapture?.(e.pointerId)
  }

  const clearPad = (): void => {
    strokesRef.current = []
    setStrokesCount(0)
    redraw()
  }

  const undoStroke = (): void => {
    strokesRef.current.pop()
    setStrokesCount(strokesRef.current.length)
    redraw()
  }

  const close = (): void => {
    useDesignerStore.setState({ pendingSignatureDrop: null })
    useDesignerStore.getState().closeSignaturePad()
  }

  const confirmInsert = (): void => {
    const hasContent = strokesRef.current.some((s) => s.points.length > 0)
    if (!hasContent) {
      void message.warning('请先写下签名')
      return
    }
    const src = exportPng()
    if (!src) {
      void message.error('签名导出失败')
      return
    }
    const bounds = trimmedBounds()!
    const widthMm = Math.max(8, round1(bounds.w * PX_TO_MM))
    const heightMm = Math.max(6, round1(bounds.h * PX_TO_MM))
    const store = useDesignerStore.getState()
    // 拖入画布时记录落点；点击插入则回落到内容区默认位置
    const drop = store.pendingSignatureDrop
    useDesignerStore.setState({ pendingSignatureDrop: null })
    store.addControlOfType(
      'signature',
      drop ?? { leftMm: 60, topMm: 60 },
      { src, penWidth, color: penColor, width: widthMm, height: heightMm } as never,
    )
    void message.success('已插入签名')
    close()
  }

  const hasContent = strokesCount > 0 && strokesRef.current.some((s) => s.points.length > 0)

  return (
    <Modal
      title="手写签名"
      open={open}
      onCancel={close}
      width={560}
      mask={{ closable: false }}
      footer={
        <div className="signature-footer">
          <Button size="small" onClick={close}>
            取消
          </Button>
          <Button size="small" type="primary" disabled={!hasContent} onClick={confirmInsert}>
            插入
          </Button>
        </div>
      }
    >
      <div className="signature-body">
        {/* 笔迹画板 */}
        <div className="signature-pad-wrap">
          <canvas
            ref={canvasRef}
            className="signature-pad"
            data-testid="signature-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>

        {/* 工具栏：笔色 + 笔宽 + 撤销/清空 */}
        <div className="signature-tools">
          <div className="signature-colors">
            {PRESET_COLORS.map((c) => (
              <span
                key={c}
                className={`color-dot${penColor === c ? ' color-dot-active' : ''}`}
                style={{ background: c }}
                onClick={() => setPenColor(c)}
              />
            ))}
            <ColorPicker
              size="small"
              showText={false}
              disabledAlpha
              value={penColor}
              onChangeComplete={(c) => setPenColor(c.toHexString())}
              className="signature-colorpicker"
            />
          </div>

          <div className="signature-penwidth">
            <span className="signature-penwidth-label">画笔粗细</span>
            <Slider
              min={1}
              max={20}
              step={1}
              value={penWidth}
              onChange={(v) => setPenWidth(v)}
              className="signature-slider"
            />
            <InputNumber
              size="small"
              min={1}
              max={20}
              step={1}
              value={penWidth}
              onChange={(v) => setPenWidth(v ?? 1)}
              className="signature-penwidth-input"
            />
          </div>

          <Button size="small" disabled={strokesCount === 0} onClick={undoStroke}>
            撤销
          </Button>
          <Button size="small" disabled={!hasContent} onClick={clearPad}>
            清空
          </Button>
        </div>

        <div className="signature-hint">
          在上方区域手写签名，确认后将以图片形式插入画布（可调位置/大小）。
        </div>
      </div>
    </Modal>
  )
}

/** 重绘单条笔画（模块级，供 redraw 使用） */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.points.length === 0) return
  ctx.strokeStyle = s.color
  ctx.lineWidth = s.penWidth
  if (s.points.length === 1) {
    // 单点：画一个圆点，避免点一下没痕迹
    const p = s.points[0]!
    ctx.beginPath()
    ctx.arc(p.x, p.y, s.penWidth / 2, 0, Math.PI * 2)
    ctx.fillStyle = s.color
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(s.points[0]!.x, s.points[0]!.y)
  for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i]!.x, s.points[i]!.y)
  ctx.stroke()
}
