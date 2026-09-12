/**
 * designer store —— 当前模板 / 选中控件 / 画布状态（React 版 / Zustand）
 *
 * 从 Vue 版 `src/design/stores/designer.ts` 迁移。
 * 行为必须与 Vue 版完全一致，由跨框架契约测试（`*.contract.spec.ts`）把关。
 *
 * 迁移要点：
 * 1. Vue `ref` → zustand state；`computed` → 派生函数（见 selectors.ts）
 * 2. **画布内核句柄不进 store**（模块级 `canvasHost`）——Fabric 对象一旦被
 *    状态管理代理会出诡异 bug，与 Vue 版用 `shallowRef` 是同一个考量
 * 3. 模型坐标单位 = mm（协议层），px 换算由画布内核负责，本层不碰
 *
 * P1 阶段只包含模型层（契约验证所需）；画布挂载、保存/加载、
 * 单元格编辑、AI 等留到 P2+。
 */
import { create } from 'zustand'
import type {
  AnyControl,
  ControlType,
  LabelGridControl,
  RectControl,
  TableColumn,
  TableControl,
  ZoneControl,
} from '@/types/control'
import type { GridConfig, PageSetup, TemplateData } from '@/types/template'
import { createDefaultControl } from '@/design/control-factory'
import {
  singleValueBindingPatch,
  tableColumnBindingPatch,
  toSingleValuePath,
} from '@/design/hooks/field-drag'
import { seedSummaryTail, syncDataTableHeight } from '@/core/layout-engine/table-cells'
import type { ImportColumn } from '@/types/data-import'
import { assertTemplate } from '@/core/spec/validator'
import { genId } from '@/utils/id'
import { createLocalRepository } from '@/repository/local-repo'
import type { TemplateRepository } from '@/repository/types'
import type { ViewportState } from '@/design/canvas/CanvasDesigner'
import { useHistoryStore, type HistoryCommand } from './history'

/** 水印默认配置（开启后居中单个、45°、浅灰） */
export const DEFAULT_WATERMARK = {
  enabled: false,
  text: 'OpenPrint',
  color: '#cccccc',
  fontSize: 16,
  rotation: 45,
  tile: false,
}

/** A4 纵向默认页面（§5.13 预设只活在 UI，协议存精确数字） */
const DEFAULT_PAGE: PageSetup = {
  width: 210,
  height: 297,
  unit: 'mm',
  orientation: 'portrait',
  margin: { top: 10, bottom: 10, left: 10, right: 10 },
  backgroundColor: '#ffffff',
  watermark: { ...DEFAULT_WATERMARK },
}

/** 画布网格默认配置（运行时视图状态，辅助设计，不持久化） */
const DEFAULT_GRID: GridConfig = { visible: false, sizeMm: 5, color: '#78829180' }

/* ------------------------------------------------------------------ */
/* 画布内核句柄 —— 刻意放在 store 之外                                    */
/* ------------------------------------------------------------------ */

/** 画布内核需要实现的接口（P2 接入 Fabric 时实现；P1 为 null） */
export interface CanvasHost {
  addControl(c: AnyControl, opts?: { zoneHostId?: string }): void
  updateControl(c: AnyControl): void
  removeControl(id: string): void
  clearControls(): void
  syncZOrder(ids: string[]): void
  setActiveControl(id: string | null): void
  setPage(p: PageSetup): void
  setManualPageCount(n: number): void
  setPageBackground(color: string): void
  setWatermark(w: unknown): void
  setGridVisible(v: boolean): void
  setGridSize(mm: number): void
  setGridColor(c: string): void
  setMarginGuidesVisible(visible: boolean): void
  setMarginLocked(locked: boolean): void
  syncGridChildren(grid: LabelGridControl): void
  getControlById(id: string): unknown
  serialize(): { body: AnyControl[]; zones: ZoneControl[] } | null
  /* ---- 缩放工具栏（P6.1）：CanvasDesigner 原生同名方法；测试假对象可不实现 ---- */
  zoomIn?(): void
  zoomOut?(): void
  setZoom?(z: number): void
  fitToHost?(): void
  /**
   * 底层 Fabric 画布（P7 overlay 层需要）。
   *
   * 表格/图表/公式的 HTML/SVG 覆盖层（方案 A）必须读画布对象的实时几何
   * （`viewportTransform` 视口变换 + `getObjects()` 逐个取 left/top/angle/缩放），
   * 而这些都是 Fabric 独占的运行时状态。刻意用结构化最小投影而非 `fabric.Canvas`
   * 类型，避免 store 反向依赖 fabric；测试里的假 host 可以不实现。
   */
  canvas?: {
    /** [scaleX, skewY, skewX, scaleY, translateX, translateY] */
    viewportTransform: number[]
    getObjects(): unknown[]
  }
}

let canvasHost: CanvasHost | null = null

/* ------------------------------------------------------------------ */
/* 模板仓库 —— 模块级单例（等价 Vue 版 store 内 repository ref）          */
/* ------------------------------------------------------------------ */

/** 未配置后端时默认 localStorage 仓库（主任铁律：无后端全链路可用） */
let repository: TemplateRepository = createLocalRepository()

/** 注入后端仓库（Phase 6：createHttpRepository）；mode 标记持久化模式（默认 cloud） */
export function setTemplateRepository(repo: TemplateRepository, mode: 'local' | 'cloud' = 'cloud'): void {
  repository = repo
  useDesignerStore.setState({ backendMode: mode })
}

/** 测试用：恢复默认本地仓库 */
export function resetTemplateRepository(): void {
  repository = createLocalRepository()
  useDesignerStore.setState({ backendMode: 'local' })
}

/** 当前模板仓库（TemplateModal / 模板市场等消费方读取） */
export function getTemplateRepository(): TemplateRepository {
  return repository
}

/** 挂载画布内核（由 CanvasStage.tsx 在 useEffect 里调用） */
export function attachCanvasHost(host: CanvasHost): void {
  canvasHost = host
}

/** 卸载画布内核 —— 必须幂等（React StrictMode 下 useEffect 会跑两次） */
export function detachCanvasHost(): void {
  canvasHost = null
}

export function getCanvasHost(): CanvasHost | null {
  return canvasHost
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

interface DesignerState {
  templateName: string
  /** 当前已保存模板的仓库 id（null = 从未保存，保存时走 create） */
  currentTemplateId: string | null
  /** 持久化模式：local = localStorage / cloud = 后端接口 */
  backendMode: 'local' | 'cloud'
  pageSetup: PageSetup
  /** body 区控件模型（zone 子控件在 zones[].children 内） */
  controls: AnyControl[]
  zones: ZoneControl[]
  selectedIds: string[]
  dirty: boolean
  lastSavedAt: string | null
  /** 手动分页下限：物理页数至少为 N（0 = 完全由内容推导；随模板持久化） */
  minPages: number
  /** 当前有效物理页数 */
  pageCount: number
  /** 当前查看的页码（0 起） */
  activePage: number
  gridConfig: GridConfig
  marginLocked: boolean
  /**
   * 视口状态（缩放/平移）—— 由画布内核的 onViewportChange 回写。
   * 放在 store 而非组件 useState 的原因：标尺 / 缩放工具栏 / 状态栏多处消费，
   * 与 Vue 版 `viewport ref` 对齐。模型即契约：{ zoom, offsetX, offsetY }。
   */
  viewport: ViewportState
  /** 手写签名弹窗开关（等价 Vue 版 signatureModalOpen ref） */
  signatureModalOpen: boolean
  /** 签名完成后落点的挂起坐标（拖拽添加签名控件时记录，等价 Vue 版 pendingSignatureDrop） */
  pendingSignatureDrop: { leftMm: number; topMm: number } | null
  /**
   * 当前正在双击编辑的单元格（方案 A：HTML overlay 原生 contenteditable 编辑）。
   * null = 无编辑。等价 Vue 版 editingCell ref。
   */
  editingCell: { controlId: string; row: number; col: number } | null
  /**
   * 画布变换版本号：Fabric 对象移动/缩放/旋转或视口变化时自增，
   * 驱动 overlay 层重算定位（Fabric 对象不是响应式的，只能靠事件打点）。
   */
  canvasTick: number
}

interface DesignerActions {
  /** 打开手写签名弹窗（等价 Vue 版 openSignaturePad） */
  openSignaturePad: () => void
  /** 关闭手写签名弹窗并清空挂起落点（等价 Vue 版 closeSignaturePad） */
  closeSignaturePad: () => void
  /** 画布内核视口变化回写（CanvasStage 挂载时接线） */
  setViewport: (vp: ViewportState) => void
  /** 设置画布网格（开关/间距/颜色）：仅运行时视图状态，不标记 dirty、不持久化（镜像 Vue 版 setGrid） */
  setGrid: (patch: Partial<GridConfig>) => void
  /** 画布内核报告的有效物理页数变化（缩放内容/增删控件后重算） */
  setPageCount: (n: number) => void
  /** 进入单元格编辑（双击表格命中格子时由画布回调触发，等价 Vue 版 openCellEditor） */
  openCellEditor: (controlId: string, row: number, col: number) => void
  /** 退出单元格编辑（等价 Vue 版 closeCellEditor） */
  closeCellEditor: () => void
  /** 画布变换打点（Fabric 对象移动/缩放/视口变化 → overlay 重算定位） */
  bumpCanvasTick: () => void
  /**
   * 画布交互（拖拽/缩放手柄结束）回写控件。
   * 与 updateControl 的区别：画布上对象已经变成 next，本方法**不再回写画布**，
   * 只负责 replace + reflow + 历史 + dirty（等价 Vue 版 onObjectModified 处理段）。
   */
  applyCanvasControl: (next: AnyControl) => void
  setMinPages: (n: number) => void
  addZone: (zone: 'header' | 'footer') => void
  /** 导入数据 → 画布生成内嵌数据表格（自动居中、自动分页、数值尾行） */
  importTable: (payload: {
    columns: ImportColumn[]
    records: Array<Record<string, unknown>>
    sourceName?: string
  }) => void
  addControlOfType: (
    type: ControlType,
    at: { leftMm: number; topMm: number },
    init?: Partial<AnyControl>,
    zoneHostId?: string,
  ) => void
  setLabelGridChildren: (gridId: string, children: AnyControl[]) => void
  /**
   * 字段树拖拽落绑定（P5.1c）。三种落点：
   * - 命中表格列 → 改该列 field（保持 `items[].` 明细前缀，逐行取值）
   * - 命中表格外的单值控件 → 写 binding（自动改写为 `items[0].` 取首条记录）
   * - 未命中控件（落到空白）→ 就地新建一个绑定该字段的文本控件
   * 由画布 drop 侧命中测试后调用（见 canvas/useDragDrop.ts）。
   */
  bindField: (args: {
    path: string
    /** 命中控件的 id；缺省表示落到空白，走新建分支 */
    controlId?: string
    /** 命中控件为表格时的列索引 */
    columnIndex?: number
    /** 落点（相对内容区/页眉页脚区 mm），新建文本控件时使用 */
    at?: { leftMm: number; topMm: number }
    /** 落点在页眉/页脚区时，该区域控件 id */
    zoneHostId?: string
  }) => void
  addControlIntoLabelGrid: (
    gridId: string,
    type: ControlType,
    atAbsolute: { leftMm: number; topMm: number },
    init?: Partial<AnyControl>,
  ) => void
  removeLabelGridChild: (gridId: string, childId: string) => void
  clearLabelGridChildren: (gridId: string) => void
  updateControl: (id: string, patch: Partial<AnyControl>) => void
  updateControlSilent: (id: string, patch: Partial<AnyControl>) => void
  removeControl: (id: string) => void
  /**
   * 复制控件：克隆 → **换新 id**（勿复用原 id，否则画布上两个同 id 控件）→ 右下偏移 10mm。
   * zone 本身与标签网格子件不复制（后者的增删走属性面板）；复制后选中副本。
   */
  duplicateControl: (id: string) => void
  moveControl: (id: string, dir: 'up' | 'down') => void
  selectControl: (id: string | null) => void
  /**
   * 批量设置选中（画布内核 onSelectionChange 回调用）。
   * 内含「选中集里不含正在编辑的表格 → 退出单元格编辑」的联动，
   * 与 Vue 版 onSelectionChange 处理段一致。
   */
  setSelection: (ids: string[]) => void
  buildTemplate: () => TemplateData<AnyControl>
  newBlankTemplate: () => void
  /** 改模板名（默认标记 dirty；新建模板确认时传 false 保持干净态） */
  renameTemplate: (name: string, markDirty?: boolean) => void
  /** 手动保存：序列化 → 协议校验 → 写仓库（唯一持久化入口）。已保存过 = update，首次 = create */
  saveTemplate: () => Promise<{ ok: boolean; error?: string }>
  /** 另存为：以新名称创建一份新模板（不清空画布，仅复制持久化） */
  saveTemplateAs: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** 加载模板到画布（启动恢复 / 打开模板 / 导入共用） */
  loadTemplate: (record: { id: string; name: string; data: TemplateData<AnyControl> }) => void
  undo: () => void
  redo: () => void
  $reset: () => void
}

export type DesignerStore = DesignerState & DesignerActions

const initialState: DesignerState = {
  templateName: '销售出库单模板',
  currentTemplateId: null,
  backendMode: 'local',
  pageSetup: { ...DEFAULT_PAGE },
  controls: [],
  zones: [],
  selectedIds: [],
  dirty: false,
  lastSavedAt: null,
  minPages: 0,
  pageCount: 1,
  activePage: 0,
  viewport: { zoom: 1, offsetX: 0, offsetY: 0 },
  signatureModalOpen: false,
  pendingSignatureDrop: null,
  editingCell: null,
  canvasTick: 0,
  gridConfig: { ...DEFAULT_GRID },
  marginLocked: true,
}

export const useDesignerStore = create<DesignerStore>((set, get) => {
  /** 推一条历史命令 */
  const pushHistory = (cmd: HistoryCommand): void => {
    useHistoryStore.getState().push(cmd)
  }

  /** 在 body / labelgrid 子控件 / zone 子控件 / zone 自身中查找 */
  const findControl = (id: string): AnyControl | undefined => {
    const { controls, zones } = get()
    const inBody = controls.find((c) => c.id === id)
    if (inBody) return inBody
    for (const g of controls) {
      if (g.type === 'labelgrid') {
        const child = (g as LabelGridControl).children.find((c) => c.id === id)
        if (child) return child
      }
    }
    for (const z of zones) {
      if (z.id === id) return z
      const child = z.children.find((c) => c.id === id)
      if (child) return child
    }
    return undefined
  }

  /** 用新对象替换同 id 控件（不可变写回） */
  const replaceControl = (updated: AnyControl): void => {
    const { controls, zones } = get()
    const i = controls.findIndex((c) => c.id === updated.id)
    if (i >= 0) {
      const next = controls.slice()
      next[i] = updated
      set({ controls: next })
      return
    }
    // 标签网格首卡子组件
    for (let gi = 0; gi < controls.length; gi++) {
      const g = controls[gi]!
      if (g.type !== 'labelgrid') continue
      const grid = g as LabelGridControl
      const ci = (grid.children ?? []).findIndex((c) => c.id === updated.id)
      if (ci >= 0) {
        const children = (grid.children ?? []).slice()
        children[ci] = updated
        const next = controls.slice()
        next[gi] = { ...grid, children } as AnyControl
        set({ controls: next })
        return
      }
    }
    for (const z of zones) {
      if (z.id === updated.id && updated.type === 'zone') {
        set({ zones: zones.map((x) => (x.id === z.id ? (updated as ZoneControl) : x)) })
        return
      }
      const ci = z.children.findIndex((c) => c.id === updated.id)
      if (ci >= 0) {
        set({
          zones: zones.map((zz) => {
            if (zz.id !== z.id) return zz
            const children = zz.children.slice()
            children[ci] = updated
            return { ...zz, children }
          }),
        })
        return
      }
    }
  }

  /** 页眉/页脚高度或页边距变化后重放正文控件位置 */
  const reflowBody = (): void => {
    for (const c of get().controls) canvasHost?.updateControl(c)
  }

  const setLabelGridChildren = (gridId: string, children: AnyControl[]): void => {
    const { controls } = get()
    const i = controls.findIndex((c) => c.id === gridId)
    if (i < 0) return
    const updated = { ...(controls[i] as LabelGridControl), children }
    const next = controls.slice()
    next[i] = updated as unknown as AnyControl
    set({ controls: next })
    const obj = canvasHost?.getControlById(gridId) as
      | { applyControlProps: (c: AnyControl) => void }
      | undefined
    obj?.applyControlProps(updated as unknown as AnyControl)
    canvasHost?.syncGridChildren(updated)
    set({ dirty: true })
  }

  return {
    ...initialState,

    /* ------------------------------ 手动分页 ------------------------------ */

    openSignaturePad: () => {
      set({ signatureModalOpen: true })
    },
    closeSignaturePad: () => {
      set({ signatureModalOpen: false, pendingSignatureDrop: null })
    },
    setViewport: (vp) => {
      set({ viewport: vp })
    },

    setGrid: (patch) => {
      set((s) => {
        const next = { ...s.gridConfig, ...patch }
        if (next.sizeMm <= 0) next.sizeMm = DEFAULT_GRID.sizeMm
        return { gridConfig: next }
      })
      // CanvasStage 的 gridConfig effect 会把变化推给画布内核，这里不重复推
    },

    setPageCount: (n) => {
      set((s) => ({
        pageCount: n,
        // 当前查看的页超出新页数 → 夹紧到最后一页（与 Vue 版 onPageCountChange 一致）
        activePage: s.activePage >= n ? Math.max(0, n - 1) : s.activePage,
      }))
    },

    openCellEditor: (controlId, row, col) => {
      set({ editingCell: { controlId, row, col } })
    },

    closeCellEditor: () => {
      set({ editingCell: null })
    },

    bumpCanvasTick: () => {
      set((s) => ({ canvasTick: s.canvasTick + 1 }))
    },

    applyCanvasControl: (next) => {
      const old = findControl(next.id)
      replaceControl(next)
      // 页眉/页脚拖拽改高后，正文区起点平移 → 重放正文控件
      if (next.type === 'zone') reflowBody()
      if (old) {
        pushHistory({
          undo: () => {
            replaceControl(old)
            canvasHost?.updateControl(old)
          },
          redo: () => {
            replaceControl(next)
            canvasHost?.updateControl(next)
          },
          description: `移动/缩放 ${next.type}`,
        })
      }
      set({ dirty: true })
    },

    setMinPages: (n) => {
      const v = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0) || 0)
      set({ minPages: v })
      canvasHost?.setManualPageCount(v)
    },

    /* -------------------------------- zone -------------------------------- */

    addZone: (zone) => {
      const { zones, pageSetup } = get()
      const existing = zones.find((z) => z.zone === zone)
      if (existing) {
        set({ selectedIds: [existing.id] })
        canvasHost?.setActiveControl(existing.id)
        return
      }
      const height = zone === 'header' ? 20 : 14
      const control: ZoneControl = {
        id: genId('zone'),
        type: 'zone',
        zone,
        left: 0,
        top: 0,
        width: pageSetup.width,
        height,
        zoneHeight: height,
        repeat: true,
        printable: true,
        children: [],
      }
      set({ zones: [...zones, control] })
      canvasHost?.addControl(control)
      const zoneId = control.id
      pushHistory({
        undo: () => get().removeControl(zoneId),
        redo: () => {
          if (!get().zones.some((z) => z.id === zoneId)) {
            set({ zones: [...get().zones, control] })
          }
          canvasHost?.addControl(control)
        },
        description: `添加${zone === 'header' ? '页眉' : '页脚'}`,
      })
      set({ dirty: true })
    },

    /* ------------------------------ 控件操作 ------------------------------ */

    /**
     * 导入数据 → 在画布生成一张「内嵌数据表格」。
     * 表格以 control.data 携带记录行（与 dataSource 字段绑定解耦），
     * 引擎渲染期自动分页；按内容区宽度自适应居中、表头重复、整表边框。
     */
    importTable: (payload) => {
      const { pageSetup } = get()
      const m = pageSetup.margin
      const contentWidth = Math.max(40, Math.round((pageSetup.width - m.left - m.right) * 10) / 10)
      const left = Math.round(m.left * 10) / 10
      const top = Math.round(m.top * 10) / 10
      const n = Math.max(1, payload.columns.length)
      const colWidth = Math.round((contentWidth / n) * 10) / 10

      const id = genId()
      const columns: TableColumn[] = payload.columns.map((c) => ({
        title: c.title || c.key,
        // 内嵌数据行经 resolveRows 落入 ctx.row，列 field 用 items[]. 前缀逐行取值
        field: `items[].${c.key}`,
        width: colWidth,
        headerAlign: 'center',
      }))
      let control: TableControl = {
        id,
        type: 'table',
        left,
        top,
        width: contentWidth,
        height: 60,
        printable: true,
        columns,
        headerRows: 1,
        data: payload.records,
        options: {
          repeatHeader: true,
          repeatFooter: true,
          pageRows: 'auto',
          borders: 'all',
          verticalAlign: 'middle',
          defaultCellStyle: { align: 'center' },
        },
      }

      // 植入「本页合计 / 总计 / 大写金额」尾行：按首行采样推断数值列，金额取最后一个数值列
      const sample = payload.records[0] ?? {}
      const numericColumns = payload.columns
        .map((c, i) => (typeof sample[c.key] === 'number' ? i : -1))
        .filter((i) => i >= 0)
      const moneyColumn =
        numericColumns.find((i) =>
          /金额|总额|合计|钱|amt|total|amount|price|sum/i.test(payload.columns[i]!.key),
        ) ?? numericColumns[numericColumns.length - 1]
      control = seedSummaryTail(control, { numericColumns, moneyColumn })

      set({ controls: [...get().controls, control] })
      canvasHost?.addControl(control)
      pushHistory({
        undo: () => get().removeControl(id),
        redo: () => {
          if (!findControl(id)) {
            set({ controls: [...get().controls, control] })
            canvasHost?.addControl(control)
          }
        },
        description: `导入数据表（${payload.sourceName ?? '数据'}）`,
      })
      set({ dirty: true })
      get().selectControl(id)
    },

    addControlOfType: (type, at, init, zoneHostId) => {
      const base = createDefaultControl(type, at)
      if (!base) return
      let control = init ? ({ ...base, ...init } as AnyControl) : base
      // 圆形默认正圆：确保外接框为正方形（宽=高）
      if (control.type === 'rect' && (control as RectControl).shape === 'circle') {
        const r = control as RectControl
        if (r.width !== r.height) {
          const size = Math.max(r.width, r.height)
          r.width = size
          r.height = size
        }
      }
      // 数据表：控件高度 = 行高之和（所见即所得）
      if (control.type === 'table') {
        const synced = syncDataTableHeight(control as TableControl)
        if (synced !== control) control = synced as unknown as AnyControl
      }
      if (control.type === 'zone') {
        // 拖入页眉/页脚区域控件本身
        const { zones } = get()
        if (zones.some((z) => z.zone === control.zone)) {
          const target = zones.find((z) => z.zone === control.zone)!
          get().selectControl(target.id)
          return
        }
        set({ zones: [...zones, control as ZoneControl] })
        canvasHost?.addControl(control)
      } else if (zoneHostId) {
        // 拖入页眉/页脚区域内的子控件
        const { zones } = get()
        const host = zones.find((z) => z.id === zoneHostId)
        if (host) {
          set({
            zones: zones.map((z) =>
              z.id === zoneHostId ? { ...z, children: [...z.children, control] } : z,
            ),
          })
          canvasHost?.addControl(control, { zoneHostId })
        } else {
          // zone 已不存在，降级到 body
          set({ controls: [...get().controls, control] })
          canvasHost?.addControl(control)
        }
      } else {
        set({ controls: [...get().controls, control] })
        canvasHost?.addControl(control)
      }
      const createdId = control.id
      const hostId = zoneHostId
      pushHistory({
        undo: () => get().removeControl(createdId),
        redo: () => {
          const c = findControl(createdId) ?? control
          if (!findControl(createdId)) {
            if (c.type === 'zone') set({ zones: [...get().zones, c as ZoneControl] })
            else if (hostId) {
              set({
                zones: get().zones.map((z) =>
                  z.id === hostId ? { ...z, children: [...z.children, c] } : z,
                ),
              })
            } else set({ controls: [...get().controls, c] })
          }
          canvasHost?.addControl(c, { zoneHostId: hostId })
        },
        description: `添加 ${control.type}`,
      })
      set({ dirty: true })
    },

    setLabelGridChildren,

    bindField: ({ path, controlId, columnIndex, at, zoneHostId }) => {
      if (!path) return
      if (controlId) {
        const current = findControl(controlId)
        if (!current) return
        // 表格：绑定落点所在的列（保持 items[]. 明细前缀，逐行取值）
        if (current.type === 'table' && columnIndex != null) {
          const patch = tableColumnBindingPatch(current as TableControl, columnIndex, path)
          if (patch) {
            get().updateControl(controlId, patch as Partial<AnyControl>)
            get().selectControl(controlId)
          }
          return
        }
        // 其余可绑定控件（文本/条码/二维码/图片）：单值路径（items[0].）
        const patch = singleValueBindingPatch(current, path)
        if (patch) {
          get().updateControl(controlId, patch)
          get().selectControl(controlId)
        }
        return
      }
      // 落到空白：新建一个绑定该字段的文本控件（单值路径）
      if (at) {
        get().addControlOfType(
          'text',
          at,
          { contentType: 'variable', binding: toSingleValuePath(path) } as Partial<AnyControl>,
          zoneHostId,
        )
      }
    },

    addControlIntoLabelGrid: (gridId, type, atAbsolute, init) => {
      const { controls } = get()
      const cur = controls.find((c) => c.id === gridId) as LabelGridControl | undefined
      if (!cur) return
      const cardLeft = Math.max(0, atAbsolute.leftMm - (cur.left ?? 0))
      const cardTop = Math.max(0, atAbsolute.topMm - (cur.top ?? 0))
      let child = createDefaultControl(type, { leftMm: cardLeft, topMm: cardTop })
      if (!child) return
      if (init) child = { ...child, ...init } as AnyControl
      // 标记归属：作为所属网格的首卡子组件
      child.childOf = gridId
      if (child.type === 'rect' && (child as RectControl).shape === 'circle') {
        const r = child as RectControl
        if (r.width !== r.height) {
          const size = Math.max(r.width, r.height)
          r.width = size
          r.height = size
        }
      }
      if (child.type === 'table') {
        const synced = syncDataTableHeight(child as TableControl)
        if (synced !== child) child = synced as unknown as AnyControl
      }
      const prev = cur.children ?? []
      const next = [...prev, child]
      setLabelGridChildren(gridId, next)
      pushHistory({
        undo: () => setLabelGridChildren(gridId, prev),
        redo: () => setLabelGridChildren(gridId, next),
        description: '添加组件到标签网格首卡',
      })
      get().selectControl(gridId)
    },

    removeLabelGridChild: (gridId, childId) => {
      const { controls } = get()
      const cur = controls.find((c) => c.id === gridId) as LabelGridControl | undefined
      if (!cur) return
      const child = (cur.children ?? []).find((c) => c.id === childId)
      if (!child) return
      const prev = (cur.children ?? []).slice()
      const next = prev.filter((c) => c.id !== childId)
      setLabelGridChildren(gridId, next)
      pushHistory({
        undo: () => setLabelGridChildren(gridId, prev),
        redo: () => setLabelGridChildren(gridId, next),
        description: `删除 ${child.type}`,
      })
      set({ dirty: true })
    },

    clearLabelGridChildren: (gridId) => {
      const { controls } = get()
      const cur = controls.find((c) => c.id === gridId) as LabelGridControl | undefined
      if (!cur || !(cur.children ?? []).length) return
      const prev = (cur.children ?? []).slice()
      setLabelGridChildren(gridId, [])
      pushHistory({
        undo: () => setLabelGridChildren(gridId, prev),
        redo: () => setLabelGridChildren(gridId, []),
        description: '清空首卡',
      })
      set({ dirty: true })
    },

    updateControl: (id, patch) => {
      const current = findControl(id)
      if (!current) return
      const old = JSON.parse(JSON.stringify(current)) as AnyControl
      let merged = { ...current, ...patch, id: current.id, type: current.type } as AnyControl
      if (merged.type === 'table') {
        const synced = syncDataTableHeight(merged as TableControl)
        if (synced !== merged) merged = synced as unknown as AnyControl
      }
      replaceControl(merged)
      canvasHost?.updateControl(merged)
      if (merged.type === 'zone') reflowBody()
      pushHistory({
        undo: () => {
          replaceControl(old)
          canvasHost?.updateControl(old)
          if (get().selectedIds.includes(id)) set({ selectedIds: [id] })
        },
        redo: () => {
          replaceControl(merged)
          canvasHost?.updateControl(merged)
        },
        description: `编辑 ${current.type}`,
      })
      set({ dirty: true })
    },

    updateControlSilent: (id, patch) => {
      const current = findControl(id)
      if (!current) return
      let merged = { ...current, ...patch, id: current.id, type: current.type } as AnyControl
      if (merged.type === 'table') {
        const synced = syncDataTableHeight(merged as TableControl)
        if (synced !== merged) merged = synced as unknown as AnyControl
      }
      replaceControl(merged)
      canvasHost?.updateControl(merged)
    },

    removeControl: (id) => {
      const { controls, zones, selectedIds, editingCell } = get()
      // 删掉的正是正在编辑的表格 → 先退出单元格编辑，否则 overlay 指向已不存在控件
      if (editingCell?.controlId === id) set({ editingCell: null })
      // 标签网格首卡子组件：从所属网格 children 移除
      const hostGrid = controls.find(
        (c) =>
          c.type === 'labelgrid' && (c as LabelGridControl).children?.some((ch) => ch.id === id),
      )
      if (hostGrid) {
        const grid = hostGrid as LabelGridControl
        const child = grid.children?.find((c) => c.id === id)
        if (!child) return
        const prev = (grid.children ?? []).slice()
        const next = prev.filter((c) => c.id !== id)
        setLabelGridChildren(grid.id, next)
        if (selectedIds.includes(id)) set({ selectedIds: [] })
        pushHistory({
          undo: () => setLabelGridChildren(grid.id, prev),
          redo: () => setLabelGridChildren(grid.id, next),
          description: `删除 ${child.type}`,
        })
        set({ dirty: true })
        return
      }
      const current = findControl(id)
      if (!current) return
      const old = JSON.parse(JSON.stringify(current)) as AnyControl
      let zoneHostId: string | undefined
      const i = controls.findIndex((c) => c.id === id)
      if (i >= 0) {
        set({ controls: controls.filter((c) => c.id !== id) })
      } else {
        let targetZone: ZoneControl | undefined
        for (const z of zones) {
          if (z.children.some((c) => c.id === id)) {
            targetZone = z
            zoneHostId = z.id
            break
          }
        }
        if (targetZone) {
          set({
            zones: zones.map((z) =>
              z.id === targetZone!.id ? { ...z, children: z.children.filter((c) => c.id !== id) } : z,
            ),
          })
        }
        if (zones.some((z) => z.id === id)) {
          set({ zones: zones.filter((z) => z.id !== id) })
        }
      }
      canvasHost?.removeControl(id)
      if (selectedIds.includes(id)) set({ selectedIds: [] })
      const hostId = zoneHostId
      pushHistory({
        undo: () => {
          if (old.type === 'zone') set({ zones: [...get().zones, old as ZoneControl] })
          else set({ controls: [...get().controls, old] })
          canvasHost?.addControl(old, { zoneHostId: hostId })
        },
        redo: () => {
          set({ controls: get().controls.filter((c) => c.id !== id) })
          canvasHost?.removeControl(id)
        },
        description: `删除 ${current.type}`,
      })
      set({ dirty: true })
    },

    duplicateControl: (id) => {
      const { controls, zones } = get()
      const src = findControl(id)
      // zone 本身不复制；标签网格子件（findControl 能查到但既不在正文也不在 zone.children）不复制
      if (!src || src.type === 'zone') return
      const bodyIndex = controls.findIndex((c) => c.id === id)
      let hostId: string | undefined
      if (bodyIndex < 0) {
        hostId = zones.find((z) => z.children.some((c) => c.id === id))?.id
        if (!hostId) return
      }
      const clone = JSON.parse(JSON.stringify(src)) as AnyControl
      clone.id = genId()
      clone.left += 10
      clone.top += 10
      const place = (target: AnyControl): void => {
        if (bodyIndex >= 0) {
          set({ controls: [...get().controls, target] })
          canvasHost?.addControl(target)
        } else {
          set({
            zones: get().zones.map((z) =>
              z.id === hostId ? { ...z, children: [...z.children, target] } : z,
            ),
          })
          canvasHost?.addControl(target, { zoneHostId: hostId })
        }
      }
      place(clone)
      pushHistory({
        undo: () => get().removeControl(clone.id),
        redo: () => place(clone),
        description: `复制 ${clone.type}`,
      })
      set({ selectedIds: [clone.id], dirty: true })
    },

    moveControl: (id, dir) => {
      const { controls } = get()
      const i = controls.findIndex((c) => c.id === id)
      if (i < 0) return
      const j = dir === 'up' ? i + 1 : i - 1
      if (j < 0 || j >= controls.length) return
      const apply = (arr: AnyControl[]) => {
        set({ controls: arr })
        canvasHost?.syncZOrder(arr.map((c) => c.id))
      }
      const before = controls.slice()
      const swapped = before.slice()
      const [moved] = swapped.splice(i, 1)
      swapped.splice(j, 0, moved!)
      apply(swapped)
      pushHistory({
        undo: () => apply(before.slice()),
        redo: () => apply(swapped.slice()),
        description: `调整层级 ${dir === 'up' ? '上移' : '下移'}`,
      })
      set({ dirty: true })
    },

    selectControl: (id) => {
      const ids = id ? [id] : []
      // 选中切走后若正在编辑的表格已不在选中集内 → 退出单元格编辑（与 Vue 版一致）
      const e = get().editingCell
      set({
        selectedIds: ids,
        ...(e && !ids.includes(e.controlId) ? { editingCell: null } : {}),
      })
      canvasHost?.setActiveControl(id)
    },

    setSelection: (ids) => {
      const e = get().editingCell
      set({
        selectedIds: ids,
        ...(e && !ids.includes(e.controlId) ? { editingCell: null } : {}),
      })
    },

    /* ------------------------------ 保存/加载 ------------------------------ */

    renameTemplate: (name, markDirty = true) => {
      set(markDirty ? { templateName: name, dirty: true } : { templateName: name })
    },

    saveTemplateAs: async (name) => {
      set({ templateName: name, currentTemplateId: null })
      return get().saveTemplate()
    },

    saveTemplate: async () => {
      try {
        if (!get().templateName.trim()) set({ templateName: '未命名模板' })
        const template = get().buildTemplate()
        assertTemplate(template)
        const id = get().currentTemplateId
        const name = get().templateName
        if (id) {
          await repository.update(id, { name, data: template })
        } else {
          const record = await repository.create({
            name,
            editable: true,
            deletable: true,
            data: template,
          })
          set({ currentTemplateId: record.id })
        }
        set({
          dirty: false,
          lastSavedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    loadTemplate: (record) => {
      assertTemplate(record.data)
      const doc = record.data.document
      // 保留默认背景/水印，旧模板缺字段时自动回退
      const page: PageSetup = {
        ...DEFAULT_PAGE,
        ...doc.page,
        backgroundColor: doc.page.backgroundColor ?? DEFAULT_PAGE.backgroundColor,
        watermark: doc.page.watermark ?? { ...DEFAULT_WATERMARK },
      }
      const minPages = doc.page.minPages ?? 0
      set({
        currentTemplateId: record.id,
        templateName: record.name,
        pageSetup: page,
        minPages,
        pageCount: 1,
        activePage: 0,
        zones: [],
        controls: [],
        selectedIds: [],
        dirty: false,
      })
      canvasHost?.setPage(doc.page)
      canvasHost?.setManualPageCount(minPages)
      canvasHost?.setPageBackground(page.backgroundColor ?? '#ffffff')
      canvasHost?.setWatermark(page.watermark)
      canvasHost?.clearControls()

      const loadNormalize = (c: AnyControl): AnyControl => {
        const base = { ...c, id: c.id || genId() }
        if (base.type === 'table') {
          return syncDataTableHeight(base as TableControl) as unknown as AnyControl
        }
        return base
      }

      // 先建 zone（子控件需要宿主坐标）
      const nextZones: ZoneControl[] = []
      for (const section of doc.sections) {
        if (section.type === 'header' || section.type === 'footer') {
          const zone: ZoneControl = {
            id: genId('zone'),
            type: 'zone',
            zone: section.type,
            left: 0,
            top: 0,
            width: doc.page.width,
            height: section.height ?? 20,
            zoneHeight: section.height ?? 20,
            repeat: section.repeat ?? true,
            printable: true,
            children: [],
          }
          nextZones.push(zone)
          canvasHost?.addControl(zone)
        }
      }
      // 再装 body 与 zone 子控件
      const nextControls: AnyControl[] = []
      for (const section of doc.sections) {
        if (section.type === 'body') {
          for (const c of section.components) {
            const control = loadNormalize(c)
            nextControls.push(control)
            canvasHost?.addControl(control)
          }
        } else {
          const host = nextZones.find((z) => z.zone === section.type)
          for (const c of section.components) {
            const control = loadNormalize(c)
            host?.children.push(control)
            canvasHost?.addControl(control, { zoneHostId: host?.id })
          }
        }
      }
      set({ zones: nextZones, controls: nextControls })
      useHistoryStore.getState().clear()
    },

    buildTemplate: () => {
      const synced = canvasHost?.serialize()
      if (synced) set({ controls: synced.body, zones: synced.zones })
      const { pageSetup, controls, zones, minPages } = get()
      const sections: TemplateData<AnyControl>['document']['sections'] = []
      const header = zones.find((z) => z.zone === 'header')
      const footer = zones.find((z) => z.zone === 'footer')
      if (header) {
        sections.push({
          type: 'header',
          height: header.zoneHeight,
          repeat: header.repeat ?? true,
          components: header.children,
        })
      }
      sections.push({ type: 'body', components: controls })
      if (footer) {
        sections.push({
          type: 'footer',
          height: footer.zoneHeight,
          repeat: footer.repeat ?? true,
          components: footer.children,
        })
      }
      return {
        version: '1.0',
        document: {
          type: 'report',
          page: { ...pageSetup, minPages: minPages || undefined },
          sections,
        },
      }
    },

    newBlankTemplate: () => {
      set({
        templateName: '未命名模板',
        currentTemplateId: null,
        pageSetup: { ...DEFAULT_PAGE },
        gridConfig: { ...DEFAULT_GRID },
        controls: [],
        zones: [],
        selectedIds: [],
        minPages: 0,
        pageCount: 1,
        activePage: 0,
        dirty: false,
        lastSavedAt: null,
      })
      canvasHost?.clearControls()
      canvasHost?.setGridVisible(false)
      canvasHost?.setGridSize(DEFAULT_GRID.sizeMm)
      canvasHost?.setGridColor(DEFAULT_GRID.color)
      canvasHost?.setPage(DEFAULT_PAGE)
      canvasHost?.setManualPageCount(0)
      canvasHost?.setPageBackground(DEFAULT_PAGE.backgroundColor ?? '#ffffff')
      canvasHost?.setWatermark(DEFAULT_PAGE.watermark)
      useHistoryStore.getState().clear()
    },

    undo: () => useHistoryStore.getState().undo(),
    redo: () => useHistoryStore.getState().redo(),

    $reset: () => set({ ...initialState, pageSetup: { ...DEFAULT_PAGE } }),
  }
})

/** 契约测试用：把 designer + history 两个 store 一起复位 */
export function resetDesignerStores(): void {
  useDesignerStore.getState().$reset()
  useHistoryStore.setState({ undoStack: [], redoStack: [], batch: null, _enabled: true })
}
