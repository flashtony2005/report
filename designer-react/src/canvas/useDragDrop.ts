/**
 * useDragDrop —— 从控件库/字段树拖入画布（React 侧，挂在 stage 容器）
 *
 * 两条拖拽链路：
 * 1) 控件库 → 落控件。框架无关部分（DRAG_TYPE_KEY / startControlDrag / 坐标换算）复用 Vue 项目
 *    `design/hooks/control-drag.ts`（vite alias 零复制）；落控件逻辑与 Vue 版
 *    useDragAdd.onDrop 逐行等价：标签网格命中 → zone 命中 → 签名弹板 → 正文落控件。
 * 2) 字段树 → 落绑定（P5.1c）。命中控件写 binding（表格列保持 `items[].`，表格外的单值控件
 *    自动改 `items[0].`），落到空白则新建文本控件；命中与补丁规则见 `design/hooks/field-drag.ts`。
 */
import { useEffect, type RefObject } from 'react'
import type { AnyControl, LabelGridControl } from '@/types/control'
import { useDesignerStore, getCanvasHost, type DesignerStore } from '../stores/designer'
import { MM_TO_PX } from '@/utils/constants'
import { computeDropMm, isControlDragOver, readControlDrag } from '@/design/hooks/control-drag'
import { hitFieldDropTarget, isFieldDragOver, readFieldDrag } from '@/design/hooks/field-drag'

/** 与 Vue store.hitLabelGridContainer 逐行等价（纯几何命中） */
function hitLabelGridContainer(controls: AnyControlList, x: number, y: number): string | null {
  for (const c of controls) {
    if (c.type !== 'labelgrid') continue
    const g = c as LabelGridControl
    const left = g.left ?? 0
    const top = g.top ?? 0
    const right = left + (g.width ?? 0)
    const bottom = top + (g.height ?? 0)
    if (x >= left && x <= right && y >= top && y <= bottom) return g.id
  }
  return null
}

type AnyControlList = { type: string; id: string }[]

interface ZoneLike {
  controlId: string
  getBoundingRect(): { left: number; top: number; width: number; height: number }
}

interface HostLike {
  contentOriginPx?: { x: number; y: number }
  getZones?: () => ZoneLike[]
}

/** 落点上下文：stage px → 页面/内容/页眉页脚区 mm（两条拖拽链路共用） */
interface DropContext {
  store: DesignerStore
  /** 相对页面左上角 mm */
  pageMmX: number
  pageMmY: number
  /** 相对内容区（正文原点）mm —— 标签网格命中用 */
  dropLeft: number
  dropTop: number
  /** 落点在页眉/页脚区时的区域控件 id */
  zoneHostId?: string
  /** 落点相对「内容区 / 区域」左上角的 mm 原点 */
  origin: { x: number; y: number }
}

/** client px → 画布 mm，并判定是否落在页眉/页脚区域内 */
function resolveDropContext(el: HTMLElement, e: DragEvent): DropContext | null {
  const store = useDesignerStore.getState()
  const host = (getCanvasHost() as unknown as HostLike) ?? null
  if (!host) return null

  const rect = el.getBoundingClientRect()
  const vp = store.viewport
  const canvasX = e.clientX - rect.left
  const canvasY = e.clientY - rect.top
  // 内核 contentOriginPx：与 Vue 版 d.contentOriginPx 同源
  const contentOriginPx = host.contentOriginPx
  if (!contentOriginPx) return null

  const { pageMmX, pageMmY, dropLeft, dropTop } = computeDropMm(
    { rect, vp, canvasX, canvasY },
    contentOriginPx,
  )

  // 检测是否拖入页眉/页脚区域
  let zoneHostId: string | undefined
  let origin = { x: contentOriginPx.x / MM_TO_PX, y: contentOriginPx.y / MM_TO_PX }
  for (const z of host.getZones?.() ?? []) {
    const b = z.getBoundingRect()
    const zLeft = b.left * vp.zoom + vp.offsetX
    const zRight = (b.left + b.width) * vp.zoom + vp.offsetX
    const zTop = b.top * vp.zoom + vp.offsetY
    const zBottom = (b.top + b.height) * vp.zoom + vp.offsetY
    if (canvasX >= zLeft && canvasX <= zRight && canvasY >= zTop && canvasY <= zBottom) {
      zoneHostId = z.controlId
      origin = { x: b.left / MM_TO_PX, y: b.top / MM_TO_PX }
      break
    }
  }

  return { store, pageMmX, pageMmY, dropLeft, dropTop, zoneHostId, origin }
}

export function useDragDrop(stageRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = stageRef.current
    if (!el) return

    const onDragOver = (e: DragEvent): void => {
      if (isControlDragOver(e) || isFieldDragOver(e)) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      }
    }

    const onDrop = (e: DragEvent): void => {
      if (!stageRef.current) return

      /* ---------- 链路 1：字段树 → 落绑定 ---------- */
      if (isFieldDragOver(e)) {
        const path = readFieldDrag(e)
        if (!path) return
        e.preventDefault()
        const ctx = resolveDropContext(stageRef.current, e)
        if (!ctx) return
        // 落点相对「内容区 / 页眉页脚区」的 mm 坐标
        const xMm = ctx.pageMmX - ctx.origin.x
        const yMm = ctx.pageMmY - ctx.origin.y
        const list = ctx.zoneHostId
          ? (ctx.store.zones.find((z) => z.id === ctx.zoneHostId)?.children ?? [])
          : ctx.store.controls
        const target = hitFieldDropTarget(list as AnyControl[], xMm, yMm)
        ctx.store.bindField({
          path,
          controlId: target?.control.id,
          columnIndex: target?.columnIndex,
          // 落到空白：新建文本控件（坐标夹到容器内，避免负值飘出可打印区）
          at: { leftMm: Math.max(0, xMm), topMm: Math.max(0, yMm) },
          zoneHostId: ctx.zoneHostId,
        })
        return
      }

      /* ---------- 链路 2：控件库 → 落控件 ---------- */
      const { type, init } = readControlDrag(e)
      if (!type) return
      e.preventDefault()
      const ctx = resolveDropContext(stageRef.current, e)
      if (!ctx) return
      const { store, pageMmX, pageMmY, dropLeft, dropTop, origin, zoneHostId } = ctx

      // 拖入标签网格容器：作为「首卡子组件」加入
      const gridId = hitLabelGridContainer(store.controls as unknown as AnyControlList, dropLeft, dropTop)
      if (gridId && type !== 'signature') {
        store.addControlIntoLabelGrid(gridId, type, { leftMm: dropLeft, topMm: dropTop }, init)
        return
      }

      // 签名：不直接落控件，而是弹出手写画板，确认后按落点插入（UX 与 WPS 一致）
      if (type === 'signature') {
        useDesignerStore.setState({
          pendingSignatureDrop: {
            leftMm: Math.max(0, pageMmX - origin.x),
            topMm: Math.max(0, pageMmY - origin.y),
          },
        })
        store.openSignaturePad()
        return
      }

      store.addControlOfType(
        type,
        {
          leftMm: pageMmX - origin.x,
          topMm: pageMmY - origin.y,
        },
        init,
        zoneHostId,
      )
    }

    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
    }
    // 仅挂载一次；store 通过 getState() 动态读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
