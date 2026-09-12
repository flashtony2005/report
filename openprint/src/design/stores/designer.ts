/**
 * designer store —— 当前模板 / 选中控件 / 画布状态（《实施指南》Phase 4 先行版）
 *
 * 数据流：
 * - 画布交互（拖拽/缩放手柄）→ CanvasDesigner 事件 → 更新本 store 的模型
 * - 属性面板编辑 → 本 store 更新模型 → 同步回 CanvasDesigner
 * - 模型坐标单位 = mm（协议层），画布层 px 换算由 CanvasDesigner 负责
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type {
  AnyControl,
  ControlType,
  LabelGridControl,
  RectControl,
  TableColumn,
  TableControl,
  ZoneControl,
} from '@/types/control'
import type { GridConfig, PageSetup, TemplateData, WatermarkConfig } from '@/types/template'
import { CanvasDesigner, type ViewportState } from '@/design/canvas/CanvasDesigner'
import { createLocalRepository } from '@/repository/local-repo'
import type { TemplateRepository } from '@/repository/types'
import { assertTemplate } from '@/core/spec/validator'
import { genId } from '@/utils/id'
import { useHistoryStore } from './history'
import { type ImportColumn } from '@/types/data-import'
import { seedSummaryTail, syncDataTableHeight } from '@/core/layout-engine/table-cells'
// 默认控件工厂已抽到共享模块（Vue / React 两端共用同一份，防默认值漂移）
import { createDefaultControl } from '@/design/control-factory'
import {
  singleValueBindingPatch,
  tableColumnBindingPatch,
  toSingleValuePath,
} from '@/design/hooks/field-drag'

/** 水印默认配置（开启后居中单个、45°、浅灰） */
export const DEFAULT_WATERMARK: WatermarkConfig = {
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

export const useDesignerStore = defineStore('designer', () => {
  /* ------------------------------- 状态 ------------------------------- */
  const templateName = ref('销售出库单模板')
  const pageSetup = ref<PageSetup>({ ...DEFAULT_PAGE })
  /** body 区控件模型（zone 子控件在 zones[].children 内） */
  const controls = ref<AnyControl[]>([])
  const zones = ref<ZoneControl[]>([])
  const selectedIds = ref<string[]>([])
  const dirty = ref(false)
  const lastSavedAt = ref<string | null>(null)

  /** 手动分页下限：物理页数至少为 N（0 = 完全由内容推导；随模板持久化） */
  const minPages = ref(0)
  /** 当前有效物理页数（由画布推导后同步，右侧页面面板展示/导航用） */
  const pageCount = ref(1)
  /** 当前查看的页码（0 起，页码导航 chips 高亮用） */
  const activePage = ref(0)

  /** 画布内核（非响应式，避免深度代理 Fabric 对象） */
  const designer = shallowRef<CanvasDesigner | null>(null)
  const viewport = ref<ViewportState>({ zoom: 1, offsetX: 0, offsetY: 0 })

  /**
   * 模板仓库：未配置后端时默认 localStorage（主任 2026-08-08 定：
   * 一切编辑纯本地，仅手动保存才持久化；后端 http-repo 经 setRepository 注入）。
   */
  const repository = shallowRef<TemplateRepository>(createLocalRepository())
  /** 当前模板在仓库中的 id（未保存过 = null） */
  const currentTemplateId = ref<string | null>(null)
  /** 持久化模式：local=本地存储 / cloud=云端（顶栏徽标 + 保存提示用） */
  const backendMode = ref<'local' | 'cloud'>('local')
  /** 画布网格配置（运行时视图状态，辅助设计，不持久化） */
  const gridConfig = ref<GridConfig>({ ...DEFAULT_GRID })
  /** 页边距锁定：默认开启，正文控件限制在边距内移动（设计安全区）；关闭后可自由移动（边距仅参考线） */
  const marginLocked = ref(true)

  /**
   * 当前正在双击编辑的单元格（方案 A：HTML overlay 原生 contenteditable 编辑）。
   * 为 null 时表示无编辑。
   */
  const editingCell = ref<{ controlId: string; row: number; col: number } | null>(null)
  /** 画布变换版本号：Fabric 对象移动/缩放/旋转或视口变化时自增，驱动 overlay 重算定位 */
  const canvasTick = ref(0)

  /** 手写签名弹窗开关：组件库点「签名」→ 打开弹出画板，确认后插入主画布 */
  const signatureModalOpen = ref(false)
  /** 签名从控件库拖入画布时的落点（mm）；点击插入时为 null，回落到默认位置 */
  const pendingSignatureDrop = ref<{ leftMm: number; topMm: number } | null>(null)

  function openCellEditor(controlId: string, row: number, col: number): void {
    editingCell.value = { controlId, row, col }
  }
  function closeCellEditor(): void {
    editingCell.value = null
  }
  function bumpCanvasTick(): void {
    canvasTick.value++
  }

  /** 打开手写签名弹窗 */
  function openSignaturePad(): void {
    signatureModalOpen.value = true
  }
  /** 关闭手写签名弹窗 */
  function closeSignaturePad(): void {
    signatureModalOpen.value = false
    pendingSignatureDrop.value = null
  }

  /* ------------------------------ computed ----------------------------- */
  const selectedControl = computed<AnyControl | null>(() => {
    const id = selectedIds.value[0]
    if (!id) return null
    return findControl(id) ?? null
  })

  const saveStateText = computed(() =>
    dirty.value ? '未保存' : lastSavedAt.value ? `已保存 ${lastSavedAt.value}` : '已保存',
  )

  /* ------------------------------- 查找 -------------------------------- */

  function findControl(id: string): AnyControl | undefined {
    const inBody = controls.value.find((c) => c.id === id)
    if (inBody) return inBody
    // 标签网格首卡子组件（画布可选中/编辑，属性面板路由到子组件）
    for (const g of controls.value) {
      if (g.type === 'labelgrid') {
        const child = (g as LabelGridControl).children.find((c) => c.id === id)
        if (child) return child
      }
    }
    for (const z of zones.value) {
      if (z.id === id) return z
      const child = z.children.find((c) => c.id === id)
      if (child) return child
    }
    return undefined
  }

  function replaceControl(updated: AnyControl): void {
    const i = controls.value.findIndex((c) => c.id === updated.id)
    if (i >= 0) {
      controls.value[i] = updated
      return
    }
    // 标签网格首卡子组件：替换所属网格 children 中的对应项
    for (let gi = 0; gi < controls.value.length; gi++) {
      const g = controls.value[gi]!
      if (g.type !== 'labelgrid') continue
      const grid = g as LabelGridControl
      const ci = (grid.children ?? []).findIndex((c) => c.id === updated.id)
      if (ci >= 0) {
        const next = (grid.children ?? []).slice()
        next[ci] = updated
        controls.value[gi] = { ...grid, children: next }
        return
      }
    }
    for (const z of zones.value) {
      if (z.id === updated.id && updated.type === 'zone') {
        const zi = zones.value.findIndex((x) => x.id === z.id)
        zones.value[zi] = updated as ZoneControl
        return
      }
      const ci = z.children.findIndex((c) => c.id === updated.id)
      if (ci >= 0) {
        z.children[ci] = updated
        return
      }
    }
  }

  /* ----------------------------- 画布挂载 ------------------------------ */

  function attachCanvas(el: HTMLCanvasElement, container: HTMLElement): void {
    const d = new CanvasDesigner()
    d.init(el, container, {
      onSelectionChange: (ids) => {
        selectedIds.value = ids
        // 选中切走 → 退出单元格编辑，避免 overlay 抢走画布指针
        if (editingCell.value && !ids.includes(editingCell.value.controlId)) closeCellEditor()
      },
      onObjectModified: (newControl) => {
        const old = findControl(newControl.id)
        replaceControl(newControl)
        // 页眉/页脚拖拽改高后，正文区起点平移 → 重放正文控件
        if (newControl.type === 'zone') reflowBody()
        if (old) {
          const history = useHistoryStore()
          history.push({
            undo: () => {
              replaceControl(old)
              designer.value?.updateControl(old)
            },
            redo: () => {
              replaceControl(newControl)
              designer.value?.updateControl(newControl)
            },
            description: `移动/缩放 ${newControl.type}`,
          })
        }
        dirty.value = true
      },
      onViewportChange: (vp) => {
        viewport.value = vp
      },
      onTransformTick: () => {
        canvasTick.value++
      },
      onPageCountChange: (count) => {
        pageCount.value = count
        if (activePage.value >= count) activePage.value = Math.max(0, count - 1)
      },
      onCellEdit: (info) => {
        // 物化 cells 网格（旧模板首次编辑时自动迁移）：派生数据，不入撤销栈、不标脏
        updateControlSilent(info.controlId, info.control as AnyControl)
        openCellEditor(info.controlId, info.row, info.col)
      },
    })
    d.setPage(pageSetup.value)
    designer.value = d
    viewport.value = d.getViewportState()
    pageCount.value = d.effectivePageCount
    d.setPageBackground(pageSetup.value.backgroundColor ?? '#ffffff')
    d.setWatermark(pageSetup.value.watermark)
  }

  function detachCanvas(): void {
    designer.value?.dispose()
    designer.value = null
  }

  /* ----------------------------- 控件操作 ------------------------------ */

  /** 从控件库拖入：在给定位置（相对内容区 mm）创建控件；init 允许控件库注入额外初始属性（如圆形 shape） */
  function addControlOfType(
    type: ControlType,
    at: { leftMm: number; topMm: number },
    init?: Partial<AnyControl>,
    zoneHostId?: string,
  ): void {
    const base = createDefaultControl(type, at)
    if (!base) return
    let control = init ? ({ ...base, ...init } as AnyControl) : base
    // 圆形默认正圆：确保外接框为正方形（宽=高），避免默认矩形尺寸导致椭圆
    if (control.type === 'rect' && (control as RectControl).shape === 'circle') {
      const r = control as RectControl
      if (r.width !== r.height) {
        const size = Math.max(r.width, r.height)
        r.width = size
        r.height = size
      }
    }
    // 数据表：控件高度 = 行高之和（所见即所得），覆盖默认 60mm 或拖入时 init.height
    if (control.type === 'table') {
      const synced = syncDataTableHeight(control as TableControl)
      if (synced !== control) control = synced as unknown as AnyControl
    }
    if (control.type === 'zone') {
      // 拖入页眉/页脚区域控件本身
      if (zones.value.some((z) => z.zone === control.zone)) {
        selectControl(zones.value.find((z) => z.zone === control.zone)!.id)
        return
      }
      zones.value.push(control)
      designer.value?.addControl(control)
    } else if (zoneHostId) {
      // 拖入页眉/页脚区域内的子控件
      const host = zones.value.find((z) => z.id === zoneHostId)
      if (host) {
        host.children.push(control)
        designer.value?.addControl(control, { zoneHostId })
      } else {
        // zone 已不存在，降级到 body
        controls.value.push(control)
        designer.value?.addControl(control)
      }
    } else {
      controls.value.push(control)
      designer.value?.addControl(control)
    }
    // 撤销 = 删除此控件
    const history = useHistoryStore()
    const createdId = control.id
    const hostId = zoneHostId
    history.push({
      undo: () => removeControl(createdId),
      redo: () => {
        const c = findControl(createdId) ?? control
        if (!findControl(createdId)) {
          if (c.type === 'zone') zones.value.push(c as ZoneControl)
          else if (hostId) {
            const host = zones.value.find((z) => z.id === hostId)
            host?.children.push(c)
          } else controls.value.push(c)
        }
        designer.value?.addControl(c, { zoneHostId: hostId })
      },
      description: `添加 ${control.type}`,
    })
    dirty.value = true
  }

  /**
   * 导入数据 → 在画布生成一张「内嵌数据表格」。
   *
   * 表格以 `control.data` 携带解析后的记录行（与 dataSource 字段绑定彻底解耦），
   * 渲染期由引擎自动分页（flow table）。表格按内容区宽度自适应居中、表头重复、整表边框。
   * 行/列的去留与标题改名已在导入弹窗中确定，这里只负责落地成控件。
   */
  function importTable(payload: {
    columns: ImportColumn[]
    records: Array<Record<string, unknown>>
    sourceName?: string
  }): void {
    const ps = pageSetup.value
    const m = ps.margin
    const contentWidth = Math.max(40, Math.round((ps.width - m.left - m.right) * 10) / 10)
    const left = Math.round(m.left * 10) / 10
    const top = Math.round(m.top * 10) / 10
    const n = Math.max(1, payload.columns.length)
    const colWidth = Math.round((contentWidth / n) * 10) / 10

    const id = genId()
    const columns: TableColumn[] = payload.columns.map((c) => ({
      title: c.title || c.key,
      // 内嵌数据行经 resolveRows 落入 ctx.row，列 field 用 items[]. 前缀即可逐行取值
      field: `items[].${c.key}`,
      width: colWidth,
      headerAlign: 'center',
    }))
    const control: TableControl = {
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
        // 默认单元格居中（与初始化表格一致）
        defaultCellStyle: { align: 'center' },
      },
    }

    // 植入「本页合计 / 总计 / 大写金额」尾行：按首行采样推断数值列，金额取最后一个数值列
    const sample = payload.records[0] ?? {}
    const numericColumns = payload.columns
      .map((c, i) => (typeof sample[c.key] === 'number' ? i : -1))
      .filter((i) => i >= 0)
    const moneyColumn =
      numericColumns.find((i) => /金额|总额|合计|钱|amt|total|amount|price|sum/i.test(payload.columns[i]!.key)) ??
      numericColumns[numericColumns.length - 1]
    const tableControl = seedSummaryTail(control, { numericColumns, moneyColumn })
    controls.value.push(tableControl)
    designer.value?.addControl(tableControl)
    const history = useHistoryStore()
    history.push({
      undo: () => removeControl(id),
      redo: () => {
        if (!findControl(id)) {
          controls.value.push(tableControl)
          designer.value?.addControl(tableControl)
        }
      },
      description: `导入数据表（${payload.sourceName ?? '数据'}）`,
    })
    dirty.value = true
    selectControl(id)
  }

  /** 插入页眉/页脚区域控件（§5.14：单例，重复点击聚焦已有色带） */
  function addZone(zone: 'header' | 'footer'): void {
    const existing = zones.value.find((z) => z.zone === zone)
    if (existing) {
      selectControl(existing.id)
      return
    }
    const control: ZoneControl = {
      id: genId('zone'),
      type: 'zone',
      zone,
      left: 0,
      top: 0,
      width: pageSetup.value.width,
      height: zone === 'header' ? 20 : 14,
      zoneHeight: zone === 'header' ? 20 : 14,
      repeat: true,
      printable: true,
      children: [],
    }
    zones.value.push(control)
    designer.value?.addControl(control)
    // 撤销 = 删除 zone
    const history = useHistoryStore()
    const zoneId = control.id
    history.push({
      undo: () => removeControl(zoneId),
      redo: () => {
        if (!zones.value.some((z) => z.id === zoneId)) zones.value.push(control)
        designer.value?.addControl(control)
      },
      description: `添加${zone === 'header' ? '页眉' : '页脚'}`,
    })
    dirty.value = true
  }

  /* --------------------------- 标签网格（多列重复） --------------------------- */

  /** 当前选中是否可以「转为标签网格」：至少 1 个正文控件，且不含 zone / 已有网格 */
  const canMakeLabelGrid = computed(() => {
    const picked = selectedIds.value
      .map((id) => controls.value.find((c) => c.id === id))
      .filter((c): c is AnyControl => !!c)
    return (
      picked.length > 0 &&
      picked.length === selectedIds.value.length &&
      picked.every((c) => c.type !== 'zone' && c.type !== 'labelgrid')
    )
  })

  /**
   * 把选中的一组控件「转为标签网格」（一张纸平铺 N 张标签的核心入口）。
   *
   * 选中的控件被当作**一张卡片模板**：坐标归一到包围盒左上角写进 children，
   * 原控件从正文移除，替换为一个 labelgrid。标签网格是纯布局组件，不带数据源；
   * 列数按内容区宽度自动铺满，行数按剩余高度铺满（渲染期多行会自动继续跨页）。
   */
  function convertSelectionToLabelGrid(): string | null {
    const ids = [...selectedIds.value]
    const picked = ids
      .map((id) => controls.value.find((c) => c.id === id))
      .filter((c): c is AnyControl => !!c && c.type !== 'zone' && c.type !== 'labelgrid')
    if (picked.length === 0) return null

    const r1 = (n: number): number => Math.round(n * 10) / 10
    const minLeft = r1(Math.min(...picked.map((c) => c.left)))
    const minTop = r1(Math.min(...picked.map((c) => c.top)))
    const maxRight = r1(Math.max(...picked.map((c) => c.left + c.width)))
    const maxBottom = r1(Math.max(...picked.map((c) => c.top + c.height)))
    const cardWidth = Math.max(1, r1(maxRight - minLeft))
    const cardHeight = Math.max(1, r1(maxBottom - minTop))

    const snapshot = JSON.parse(JSON.stringify(picked)) as AnyControl[]
    const children = snapshot.map((c) => ({
      ...c,
      left: r1(c.left - minLeft),
      top: r1(c.top - minTop),
    }))

    const gap = 3
    const ps = pageSetup.value
    const contentWidth = Math.max(1, ps.width - ps.margin.left - ps.margin.right)
    const contentHeight = Math.max(1, ps.height - ps.margin.top - ps.margin.bottom)
    const columns = Math.max(1, Math.floor((contentWidth - minLeft + gap) / (cardWidth + gap)))
    const rows = Math.max(1, Math.floor((contentHeight - minTop + gap) / (cardHeight + gap)))

    const grid: LabelGridControl = {
      id: genId('lgrid'),
      type: 'labelgrid',
      left: minLeft,
      top: minTop,
      width: r1(cardWidth * columns + gap * (columns - 1)),
      height: r1(cardHeight * rows + gap * (rows - 1)),
      printable: true,
      columns,
      gapX: gap,
      gapY: gap,
      cardWidth,
      cardHeight,
      children,
      name: `标签网格（${columns} 列）`,
    }

    // 移除原控件 → 插入网格
    for (const c of picked) {
      const i = controls.value.findIndex((x) => x.id === c.id)
      if (i >= 0) controls.value.splice(i, 1)
      designer.value?.removeControl(c.id)
    }
    controls.value.push(grid)
    designer.value?.addControl(grid)
    selectControl(grid.id)
    dirty.value = true

    const history = useHistoryStore()
    history.push({
      undo: () => {
        const i = controls.value.findIndex((x) => x.id === grid.id)
        if (i >= 0) controls.value.splice(i, 1)
        designer.value?.removeControl(grid.id)
        for (const c of snapshot) {
          if (!findControl(c.id)) controls.value.push(c)
          designer.value?.addControl(c)
        }
        selectedIds.value = snapshot.map((c) => c.id)
      },
      redo: () => {
        for (const c of snapshot) {
          const i = controls.value.findIndex((x) => x.id === c.id)
          if (i >= 0) controls.value.splice(i, 1)
          designer.value?.removeControl(c.id)
        }
        if (!findControl(grid.id)) controls.value.push(grid)
        designer.value?.addControl(grid)
        selectControl(grid.id)
      },
      description: '转为标签网格',
    })
    return grid.id
  }

  /**
   * 命中检测：点 (x,y)（相对内容区 mm）落在某个 labelgrid 容器内则返回其 id。
   * 用于「把控件拖进标签网格首卡」交互——容器即模板，落点决定子组件在首卡中的位置。
   */
  function hitLabelGridContainer(x: number, y: number): string | null {
    for (const c of controls.value) {
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

  /**
   * 字段树拖拽落绑定（P5.1c）。三种落点：
   * - 命中表格列 → 改该列 field（保持 `items[].` 明细前缀，逐行取值）
   * - 命中表格外的单值控件 → 写 binding（自动改写为 `items[0].` 取首条记录）
   * - 未命中控件（落到空白）→ 就地新建一个绑定该字段的文本控件
   * 命中测试在画布 drop 侧完成（见 hooks/useDragAdd.ts）。
   */
  function bindField(args: {
    path: string
    /** 命中控件的 id；缺省表示落到空白，走新建分支 */
    controlId?: string
    /** 命中控件为表格时的列索引 */
    columnIndex?: number
    /** 落点（相对内容区/页眉页脚区 mm），新建文本控件时使用 */
    at?: { leftMm: number; topMm: number }
    /** 落点在页眉/页脚区时，该区域控件 id */
    zoneHostId?: string
  }): void {
    const { path, controlId, columnIndex, at, zoneHostId } = args
    if (!path) return
    if (controlId) {
      const current = findControl(controlId)
      if (!current) return
      // 表格：绑定落点所在的列（保持 items[]. 明细前缀，逐行取值）
      if (current.type === 'table' && columnIndex != null) {
        const patch = tableColumnBindingPatch(current as TableControl, columnIndex, path)
        if (patch) {
          updateControl(controlId, patch as Partial<AnyControl>)
          selectControl(controlId)
        }
        return
      }
      // 其余可绑定控件（文本/条码/二维码/图片）：单值路径（items[0].）
      const patch = singleValueBindingPatch(current, path)
      if (patch) {
        updateControl(controlId, patch)
        selectControl(controlId)
      }
      return
    }
    // 落到空白：新建一个绑定该字段的文本控件（单值路径）
    if (at) {
      addControlOfType(
        'text',
        at,
        { contentType: 'variable', binding: toSingleValuePath(path) } as Partial<AnyControl>,
        zoneHostId,
      )
    }
  }

  /** 写回某 labelgrid 的 children 并同步画布（网格位图 + 首卡子对象增删/重定位；不单独记历史，由调用方包 undo/redo） */
  function setLabelGridChildren(gridId: string, children: AnyControl[]): void {
    const i = controls.value.findIndex((c) => c.id === gridId)
    if (i < 0) return
    const updated = { ...(controls.value[i] as LabelGridControl), children }
    controls.value.splice(i, 1, updated)
    const obj = designer.value?.getControlById(gridId) as unknown as
      | { applyControlProps: (c: AnyControl) => void }
      | undefined
    obj?.applyControlProps(updated)
    // 首卡子组件以真实 Fabric 对象呈现：新增/更新/删除三向同步
    designer.value?.syncGridChildren(updated)
    dirty.value = true
  }

  /**
   * 把控件库拖入的控件作为「首卡子组件」加入标签网格：
   * 落点（内容区 mm）换算为首卡相对坐标写进 children，其余卡片在渲染 / 导出时由
   * expandLabelGrids 自动复制。即「设计第一张 = 设计全部」，预览 / 打印 1:1 复刻。
   */
  function addControlIntoLabelGrid(
    gridId: string,
    type: ControlType,
    atAbsolute: { leftMm: number; topMm: number },
    init?: Partial<AnyControl>,
  ): void {
    const cur = controls.value.find((c) => c.id === gridId) as LabelGridControl | undefined
    if (!cur) return
    const cardLeft = Math.max(0, atAbsolute.leftMm - (cur.left ?? 0))
    const cardTop = Math.max(0, atAbsolute.topMm - (cur.top ?? 0))
    let child = createDefaultControl(type, { leftMm: cardLeft, topMm: cardTop })
    if (!child) return
    if (init) child = { ...child, ...init } as AnyControl
    // 标记归属：作为所属网格的首卡子组件（画布对象 childOf + 模型 childOf 一致）
    child.childOf = gridId
    // 圆形默认正圆：宽 = 高
    if (child.type === 'rect' && (child as RectControl).shape === 'circle') {
      const r = child as RectControl
      if (r.width !== r.height) {
        const size = Math.max(r.width, r.height)
        r.width = size
        r.height = size
      }
    }
    // 数据表：高度跟随行高之和（所见即所得）
    if (child.type === 'table') {
      const synced = syncDataTableHeight(child as TableControl)
      if (synced !== child) child = synced as unknown as AnyControl
    }
    const prev = cur.children ?? []
    const next = [...prev, child]
    setLabelGridChildren(gridId, next)
    const history = useHistoryStore()
    history.push({
      undo: () => setLabelGridChildren(gridId, prev),
      redo: () => setLabelGridChildren(gridId, next),
      description: '添加组件到标签网格首卡',
    })
    selectControl(gridId)
  }

  /** 删除首卡中的某个子组件 */
  function removeLabelGridChild(gridId: string, childId: string): void {
    const cur = controls.value.find((c) => c.id === gridId) as LabelGridControl | undefined
    if (!cur) return
    const prev = cur.children ?? []
    const next = prev.filter((c) => c.id !== childId)
    if (next.length === prev.length) return
    setLabelGridChildren(gridId, next)
    const history = useHistoryStore()
    history.push({
      undo: () => setLabelGridChildren(gridId, prev),
      redo: () => setLabelGridChildren(gridId, next),
      description: '删除标签网格子组件',
    })
  }

  /** 清空首卡内容（删除所有 children） */
  function clearLabelGridChildren(gridId: string): void {
    const cur = controls.value.find((c) => c.id === gridId) as LabelGridControl | undefined
    if (!cur || (cur.children?.length ?? 0) === 0) return
    const prev = cur.children ?? []
    setLabelGridChildren(gridId, [])
    const history = useHistoryStore()
    history.push({
      undo: () => setLabelGridChildren(gridId, prev),
      redo: () => setLabelGridChildren(gridId, []),
      description: '清空标签网格首卡',
    })
  }

  /** 属性面板编辑：更新模型并同步画布 */
  function updateControl(id: string, patch: Partial<AnyControl>): void {
    const current = findControl(id)
    if (!current) return
    const old = JSON.parse(JSON.stringify(current)) as AnyControl // 深拷贝旧状态
    let merged = { ...current, ...patch, id: current.id, type: current.type } as AnyControl
    // 数据表：控件高度跟随行高之和，保证画布包围盒 = 渲染尺寸（所见即所得）
    if (merged.type === 'table') {
      const synced = syncDataTableHeight(merged as TableControl)
      if (synced !== merged) merged = synced as unknown as AnyControl
    }
    replaceControl(merged)
    designer.value?.updateControl(merged)
    // 页眉/页脚高度变化 → 正文区起点平移，重放正文控件保持所见即所得
    if (merged.type === 'zone') reflowBody()
    const history = useHistoryStore()
    history.push({
      undo: () => {
        replaceControl(old)
        designer.value?.updateControl(old)
        if (selectedIds.value.includes(id)) selectedIds.value = [id]
      },
      redo: () => {
        replaceControl(merged)
        designer.value?.updateControl(merged)
      },
      description: `编辑 ${current.type}`,
    })
    dirty.value = true
  }

  /**
   * 静默更新：只同步模型与画布，**不入撤销栈、不标脏**。
   * 仅用于派生数据物化（如首次双击表格时把列配置展开成 cells 网格），
   * 用户可感知的编辑一律走 updateControl。
   */
  function updateControlSilent(id: string, patch: Partial<AnyControl>): void {
    const current = findControl(id)
    if (!current) return
    let merged = { ...current, ...patch, id: current.id, type: current.type } as AnyControl
    // 数据表：控件高度跟随行高之和，保证画布包围盒 = 渲染尺寸（所见即所得）
    if (merged.type === 'table') {
      const synced = syncDataTableHeight(merged as TableControl)
      if (synced !== merged) merged = synced as unknown as AnyControl
    }
    replaceControl(merged)
    designer.value?.updateControl(merged)
  }

  /**
   * 页眉/页脚高度或页边距变化后，按模型重放正文控件位置。
   * 正文控件模型 top 不变（相对正文区），仅画布绝对 y 随正文区起点平移，保持与渲染端 WYSIWYG。
   */
  function reflowBody(): void {
    for (const c of controls.value) designer.value?.updateControl(c)
  }

  function removeControl(id: string): void {
    // 标签网格首卡子组件：从所属网格 children 移除（syncGridChildren 会一并删画布对象）
    const hostGrid = controls.value.find(
      (c) => c.type === 'labelgrid' && (c as LabelGridControl).children?.some((ch) => ch.id === id),
    )
    if (hostGrid) {
      const grid = hostGrid as LabelGridControl
      const child = grid.children?.find((c) => c.id === id)
      if (!child) return
      const prev = (grid.children ?? []).slice()
      const next = prev.filter((c) => c.id !== id)
      setLabelGridChildren(grid.id, next)
      if (selectedIds.value.includes(id)) selectedIds.value = []
      const history = useHistoryStore()
      history.push({
        undo: () => setLabelGridChildren(grid.id, prev),
        redo: () => setLabelGridChildren(grid.id, next),
        description: `删除 ${child.type}`,
      })
      dirty.value = true
      return
    }
    const current = findControl(id)
    if (!current) return
    if (editingCell.value?.controlId === id) closeCellEditor()
    const old = JSON.parse(JSON.stringify(current)) as AnyControl
    let zoneHostId: string | undefined
    const i = controls.value.findIndex((c) => c.id === id)
    if (i >= 0) controls.value.splice(i, 1)
    else {
      for (const z of zones.value) {
        const ci = z.children.findIndex((c) => c.id === id)
        if (ci >= 0) { zoneHostId = z.id; z.children.splice(ci, 1); break }
      }
      const zi = zones.value.findIndex((z) => z.id === id)
      if (zi >= 0) zones.value.splice(zi, 1)
    }
    designer.value?.removeControl(id)
    if (selectedIds.value.includes(id)) selectedIds.value = []
    const history = useHistoryStore()
    // 撤销 = 重新添加（含 zone 宿主归属）
    const hostId = zoneHostId
    history.push({
      undo: () => {
        if (old.type === 'zone') zones.value.push(old as ZoneControl)
        else controls.value.push(old)
        designer.value?.addControl(old, { zoneHostId: hostId })
      },
      redo: () => {
        const idx = controls.value.findIndex((c) => c.id === id)
        if (idx >= 0) controls.value.splice(idx, 1)
        designer.value?.removeControl(id)
      },
      description: `删除 ${current.type}`,
    })
    dirty.value = true
  }

  /**
   * 复制单个控件（与 React 端 `designer-react/src/stores/designer.ts` 同语义）：
   * 换新 id + 右下偏移 10mm，复制后选中副本并记一条历史。
   * zone 本身不复制；标签网格首卡子件不复制（其宿主为 labelgrid，不在 zones[].children 内）。
   */
  function duplicateControl(id: string): void {
    const src =
      controls.value.find((c) => c.id === id) ??
      zones.value.find((z) => z.children.some((c) => c.id === id))?.children.find((c) => c.id === id)
    if (!src) return
    if (src.type === 'zone') return
    const clone: AnyControl = JSON.parse(JSON.stringify(src))
    clone.id = genId()
    clone.left += 10
    clone.top += 10
    // 与原控件同宿主：正文留在正文，zone 子件留在原 zone 内
    const zoneHostId = zones.value.find((z) => z.children.some((c) => c.id === id))?.id
    if (zoneHostId) zones.value.find((z) => z.id === zoneHostId)!.children.push(clone)
    else controls.value.push(clone)
    designer.value?.addControl(clone, { zoneHostId })
    selectControl(clone.id)
    const history = useHistoryStore()
    history.push({
      undo: () => removeControl(clone.id),
      redo: () => {
        if (zoneHostId) zones.value.find((z) => z.id === zoneHostId)!.children.push(clone)
        else controls.value.push(clone)
        designer.value?.addControl(clone, { zoneHostId })
        selectControl(clone.id)
      },
      description: `复制 ${clone.type}`,
    })
    dirty.value = true
  }

  /** 调整正文控件层级（解决组件相互覆盖）：dir='up' 上移一层（更靠前/更可见），'down' 下移一层 */
  function moveControl(id: string, dir: 'up' | 'down'): void {
    const i = controls.value.findIndex((c) => c.id === id)
    if (i < 0) return
    const j = dir === 'up' ? i + 1 : i - 1
    if (j < 0 || j >= controls.value.length) return
    const apply = (arr: AnyControl[]) => {
      controls.value = arr
      designer.value?.syncZOrder(controls.value.map((c) => c.id))
    }
    const before = controls.value.slice()
    const swapped = before.slice()
    const [moved] = swapped.splice(i, 1)
    swapped.splice(j, 0, moved!)
    apply(swapped)
    const history = useHistoryStore()
    history.push({
      undo: () => apply(before.slice()),
      redo: () => apply(swapped.slice()),
      description: `调整层级 ${dir === 'up' ? '上移' : '下移'}`,
    })
    dirty.value = true
  }

  function selectControl(id: string | null): void {
    selectedIds.value = id ? [id] : []
    designer.value?.setActiveControl(id)
  }

  /* ----------------------------- 保存/加载 ----------------------------- */

  /** 从画布序列化出完整 template.json（协议结构） */
  function buildTemplate(): TemplateData<AnyControl> {
    const synced = designer.value?.serialize()
    if (synced) {
      controls.value = synced.body
      zones.value = synced.zones
    }
    const sections: TemplateData<AnyControl>['document']['sections'] = []
    const header = zones.value.find((z) => z.zone === 'header')
    const footer = zones.value.find((z) => z.zone === 'footer')
    if (header) {
      sections.push({
        type: 'header',
        height: header.zoneHeight,
        repeat: header.repeat ?? true,
        components: header.children,
      })
    }
    sections.push({ type: 'body', components: controls.value })
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
        page: { ...pageSetup.value, minPages: minPages.value || undefined },
        sections,
      },
    }
  }

  function markSaved(): void {
    dirty.value = false
    lastSavedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  }

  /** 注入后端仓库（Phase 6：createHttpRepository）；mode 标记持久化模式（默认 cloud） */
  function setRepository(repo: TemplateRepository, mode: 'local' | 'cloud' = 'cloud'): void {
    repository.value = repo
    backendMode.value = mode
  }

  /** 设置画布网格（开关 / 间距）。仅运行时视图状态，应用到 SmartGuides；不标记 dirty、不持久化 */
  function setGrid(patch: Partial<GridConfig>): void {
    const next = { ...gridConfig.value, ...patch }
    if (next.sizeMm <= 0) next.sizeMm = DEFAULT_GRID.sizeMm
    gridConfig.value = next
    const d = designer.value
    if (d) {
      d.setGridVisible(next.visible)
      d.setGridSize(next.sizeMm)
      d.setGridColor(next.color)
    }
  }

  /** 设置页边距锁定：锁定=正文控件限制在边距内移动（设计安全区）；关闭=可自由移动（边距仅参考线） */
  function setMarginLocked(locked: boolean): void {
    marginLocked.value = locked
    designer.value?.setMarginLocked(locked)
  }

  /**
   * 应用页面装饰（背景色 + 水印）到画布，并标记 dirty（随模板持久化）。
   * 右栏「页面外观」各组控件改完即调此方法即时预览。
   */
  function applyPageDecoration(): void {
    const d = designer.value
    if (d) {
      d.setPageBackground(pageSetup.value.backgroundColor ?? '#ffffff')
      d.setWatermark(pageSetup.value.watermark)
    }
    dirty.value = true
  }

  /* ----------------------------- 手动分页 ----------------------------- */

  /** 设置手动分页下限（floor，最小 0）并同步画布 */
  function setMinPages(n: number): void {
    const v = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0) || 0)
    minPages.value = v
    designer.value?.setManualPageCount(v)
  }

  /** 加一页：物理页数 +1（minPages = max(内容推导, 当前下限) + 1） */
  function addPage(): void {
    const d = designer.value
    const content = d?.contentPageCount ?? 1
    setMinPages(Math.max(minPages.value, content) + 1)
  }

  /** 减一页：手动下限 -1（内容推导页数仍会兜底，不会少于内容所需页数） */
  function removePage(): void {
    setMinPages(Math.max(0, minPages.value - 1))
  }

  /** 跳转到第 index 页（0 起）：滚动画布视口并把页码高亮 */
  function goToPage(index: number): void {
    const i = Math.max(0, Math.min(index, pageCount.value - 1))
    activePage.value = i
    designer.value?.scrollToPage(i)
  }

  /** 新建空白模板：清空画布与模型，currentTemplateId 归零（保存时走 create） */
  function newBlankTemplate(): void {
    closeCellEditor()
    currentTemplateId.value = null
    templateName.value = '未命名模板'
    pageSetup.value = { ...DEFAULT_PAGE }
    gridConfig.value = { ...DEFAULT_GRID }
    controls.value = []
    zones.value = []
    selectedIds.value = []
    minPages.value = 0
    pageCount.value = 1
    activePage.value = 0
    designer.value?.clearControls()
    designer.value?.setGridVisible(false)
    designer.value?.setGridSize(DEFAULT_GRID.sizeMm)
    designer.value?.setGridColor(DEFAULT_GRID.color)
    designer.value?.setPage(pageSetup.value)
    designer.value?.setManualPageCount(0)
    designer.value?.setPageBackground(pageSetup.value.backgroundColor ?? '#ffffff')
    designer.value?.setWatermark(pageSetup.value.watermark)
    useHistoryStore().clear()
    dirty.value = false
    lastSavedAt.value = null
  }

  /** 另存为：以新名称创建一份新模板（不清空当前画布，仅复制持久化） */
  async function saveTemplateAs(name: string): Promise<{ ok: boolean; error?: string }> {
    templateName.value = name
    currentTemplateId.value = null
    return saveTemplate()
  }

  /**
   * 手动保存：序列化 → 协议校验 → 写入仓库（唯一会触发持久化的入口）。
   * 已保存过 = update，首次 = create。
   */
  async function saveTemplate(): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!templateName.value.trim()) templateName.value = '未命名模板'
      const template = buildTemplate()
      assertTemplate(template)
      if (currentTemplateId.value) {
        await repository.value.update(currentTemplateId.value, {
          name: templateName.value,
          data: template,
        })
      } else {
        const record = await repository.value.create({
          name: templateName.value,
          editable: true,
          deletable: true,
          data: template,
        })
        currentTemplateId.value = record.id
      }
      markSaved()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 加载模板到画布（启动恢复 / 打开模板共用） */
  function loadTemplate(record: { id: string; name: string; data: TemplateData<AnyControl> }): void {
    const d = designer.value
    if (!d) return
    assertTemplate(record.data)
    closeCellEditor()
    const doc = record.data.document

    currentTemplateId.value = record.id
    templateName.value = record.name
    // 保留默认背景/水印，旧模板缺字段时自动回退
    pageSetup.value = {
      ...DEFAULT_PAGE,
      ...doc.page,
      backgroundColor: doc.page.backgroundColor ?? DEFAULT_PAGE.backgroundColor,
      watermark: doc.page.watermark ?? { ...DEFAULT_WATERMARK },
    }
    minPages.value = doc.page.minPages ?? 0
    d.setPage(doc.page)
    d.setManualPageCount(minPages.value)
    d.setPageBackground(pageSetup.value.backgroundColor ?? '#ffffff')
    d.setWatermark(pageSetup.value.watermark)
    d.clearControls()
    pageCount.value = d.effectivePageCount
    activePage.value = 0

    zones.value = []
    controls.value = []

    // 先建 zone（子控件需要宿主坐标）
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
        zones.value.push(zone)
        d.addControl(zone, { select: false })
      }
    }
    // 载入时归一化：数据表控件高度 = 行高之和（画布包围盒 = 渲染尺寸，所见即所得）；
    // 布局网格高度即真理，syncDataTableHeight 会原样返回，不影响。
    const loadNormalize = (c: AnyControl): AnyControl => {
      const base = { ...c, id: c.id || genId() }
      if (base.type === 'table') {
        return syncDataTableHeight(base as TableControl) as unknown as AnyControl
      }
      return base
    }

    // 再装 body 与 zone 子控件
    for (const section of doc.sections) {
      if (section.type === 'body') {
        for (const c of section.components) {
          const control = loadNormalize(c)
          controls.value.push(control)
          d.addControl(control, { select: false })
        }
      } else {
        const host = zones.value.find((z) => z.zone === section.type)
        for (const c of section.components) {
          const control = loadNormalize(c)
          host?.children.push(control)
          d.addControl(control, { select: false, zoneHostId: host?.id })
        }
      }
    }
    dirty.value = false
    selectedIds.value = []
    useHistoryStore().clear()
  }
  async function restoreLastTemplate(): Promise<boolean> {
    try {
      const list = await repository.value.list()
      const latest = [...list].sort((a, b) =>
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      )[0]
      if (!latest) return false
      const record = await repository.value.get(latest.id)
      if (!record) return false
      loadTemplate(record)
      markSaved()
      return true
    } catch {
      return false
    }
  }

  /* ------------------------------ 缩放代理 ------------------------------ */

  function setZoom(z: number): void {
    designer.value?.setZoom(z)
  }

  function fitCanvas(): void {
    const container = document.querySelector<HTMLElement>('.canvas-stage')
    if (container) designer.value?.fitToContainer(container)
  }

  return {
    templateName,
    pageSetup,
    controls,
    zones,
    selectedIds,
    selectedControl,
    dirty,
    lastSavedAt,
    saveStateText,
    designer,
    viewport,
    repository,
    backendMode,
    gridConfig,
    editingCell,
    canvasTick,
    minPages,
    pageCount,
    activePage,
    setMinPages,
    addPage,
    removePage,
    goToPage,
    openCellEditor,
    closeCellEditor,
    bumpCanvasTick,
  signatureModalOpen,
  pendingSignatureDrop,
  openSignaturePad,
  closeSignaturePad,
    setGrid,
    marginLocked,
    setMarginLocked,
    attachCanvas,
    detachCanvas,
    addControlOfType,
    importTable,
    addZone,
    canMakeLabelGrid,
    convertSelectionToLabelGrid,
    hitLabelGridContainer,
    addControlIntoLabelGrid,
    bindField,
    removeLabelGridChild,
    clearLabelGridChildren,
    updateControl,
    updateControlSilent,
    reflowBody,
    removeControl,
    duplicateControl,
    moveControl,
    selectControl,
    buildTemplate,
    markSaved,
    currentTemplateId,
    setRepository,
    newBlankTemplate,
    saveTemplateAs,
    saveTemplate,
    loadTemplate,
    restoreLastTemplate,
    applyPageDecoration,
    setZoom,
    fitCanvas,

    // 撤销/重做委托
    undo: () => useHistoryStore().undo(),
    redo: () => useHistoryStore().redo(),
    canUndo: computed(() => useHistoryStore().canUndo),
    canRedo: computed(() => useHistoryStore().canRedo),
  }
})
