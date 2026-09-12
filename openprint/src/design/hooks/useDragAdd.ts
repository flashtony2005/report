/**
 * useDragAdd —— 从控件库/字段树拖入画布（Vue 侧 hook）
 *
 * 两条拖拽链路：
 * 1) 控件库 → 落控件。框架无关部分（DRAG_TYPE_KEY / startControlDrag / 坐标换算）在
 *    ./control-drag，React 侧对应实现见 designer-react src/canvas/useDragDrop.ts。
 * 2) 字段树 → 落绑定（P5.1c）。命中控件写 binding（表格列保持 `items[].`，表格外的单值控件
 *    自动改 `items[0].`），落到空白则新建文本控件；命中与补丁规则见 ./field-drag。
 *
 * 交互：卡片/字段 draggable → dragstart 写入类型或字段路径 →
 * 画布容器 dragover 允许放置 → drop 时把 client 坐标换算为相对内容区
 * （或页眉/页脚区域）的 mm 坐标，再调用 store 的落点方法。
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import { useDesignerStore } from '@/design/stores/designer'
import type { AnyControl } from '@/types/control'
import { MM_TO_PX } from '@/utils/constants'
import { computeDropMm, isControlDragOver, readControlDrag } from './control-drag'
import { hitFieldDropTarget, isFieldDragOver, readFieldDrag } from './field-drag'

/** 落点上下文：stage px → 页面/内容/页眉页脚区 mm（两条拖拽链路共用） */
interface DropContext {
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

/** 画布侧：挂载到画布容器，处理 drop */
export function useDragAdd(stageRef: Ref<HTMLElement | null>): void {
  const store = useDesignerStore()

  /** client px → 画布 mm，并判定是否落在页眉/页脚区域内 */
  function resolveDropContext(e: DragEvent, el: HTMLElement): DropContext | null {
    const vp = store.viewport
    const d = store.designer
    if (!d) return null

    const rect = el.getBoundingClientRect()
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top
    // client px → 画布 mm（相对页面左上角）
    const geom = computeDropMm({ rect, vp, canvasX, canvasY }, d.contentOriginPx)
    const { pageMmX, pageMmY, dropLeft, dropTop } = geom

    // 检测是否拖入页眉/页脚区域
    let zoneHostId: string | undefined
    // 相对色带左上角（mm）的落点原点（默认正文区）
    let origin = { x: d.contentOriginPx.x / MM_TO_PX, y: d.contentOriginPx.y / MM_TO_PX }
    for (const z of d.getZones()) {
      const b = z.getBoundingRect()
      // 将 zone 画布坐标转为 stage-container px
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

    return { pageMmX, pageMmY, dropLeft, dropTop, zoneHostId, origin }
  }

  const onDragOver = (e: DragEvent) => {
    if (isControlDragOver(e) || isFieldDragOver(e)) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
  }

  const onDrop = (e: DragEvent) => {
    const el = stageRef.value
    if (!el) return

    /* ---------- 链路 1：字段树 → 落绑定 ---------- */
    if (isFieldDragOver(e)) {
      const path = readFieldDrag(e)
      if (!path) return
      e.preventDefault()
      const ctx = resolveDropContext(e, el)
      if (!ctx) return
      // 落点相对「内容区 / 页眉页脚区」的 mm 坐标
      const xMm = ctx.pageMmX - ctx.origin.x
      const yMm = ctx.pageMmY - ctx.origin.y
      const list = ctx.zoneHostId
        ? (store.zones.find((z) => z.id === ctx.zoneHostId)?.children ?? [])
        : store.controls
      const target = hitFieldDropTarget(list as AnyControl[], xMm, yMm)
      store.bindField({
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
    const ctx = resolveDropContext(e, el)
    if (!ctx) return
    const { pageMmX, pageMmY, dropLeft, dropTop, origin, zoneHostId } = ctx

    // 拖入标签网格容器：作为「首卡子组件」加入，渲染 / 导出时由引擎自动复制（容器即模板）
    const gridId = store.hitLabelGridContainer(dropLeft, dropTop)
    if (gridId && type !== 'signature') {
      store.addControlIntoLabelGrid(gridId, type, { leftMm: dropLeft, topMm: dropTop }, init)
      return
    }

    // 签名：不直接落控件，而是弹出手写画板，确认后按落点插入（UX 与 WPS 一致）
    if (type === 'signature') {
      store.pendingSignatureDrop = {
        leftMm: Math.max(0, pageMmX - origin.x),
        topMm: Math.max(0, pageMmY - origin.y),
      }
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

  onMounted(() => {
    stageRef.value?.addEventListener('dragover', onDragOver)
    stageRef.value?.addEventListener('drop', onDrop)
  })

  onBeforeUnmount(() => {
    stageRef.value?.removeEventListener('dragover', onDragOver)
    stageRef.value?.removeEventListener('drop', onDrop)
  })
}
