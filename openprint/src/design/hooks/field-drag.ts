/**
 * field-drag —— 字段树拖拽绑定的框架无关部分
 *
 * 交互：数据源字段树条目 draggable → dragstart 写入字段路径（startFieldDrag）→
 * 画布容器 dragover 允许放置 → drop 时由框架侧 hook（Vue useDragAdd / React useDragDrop）
 * 读取路径、命中落点控件，再交给 store 的 bindField 落绑定。
 *
 * 路径口径（与 DatabaseExplorer 面板提示一致）：
 * - 命中**表格列** → 保持明细数组前缀 `items[].字段名`（逐行取值，行上下文）
 * - 命中**表格外的单值控件**（正文/页眉/页脚的文本、条码、二维码、图片）→ 自动改写为
 *   `items[0].字段名`（取首条记录），否则引擎按数组取值会取到 undefined（「字段缺失」告警）
 * - 未命中任何控件（落到空白）→ 由 store 就地新建一个绑定该字段的文本控件
 *
 * 与 control-drag.ts 同构：纯函数 + 模块级 pendingPath 兜底（同标签页拖拽为同步过程）。
 */
import type { AnyControl, TableColumn, TableControl } from '@/types/control'

/** 拖拽字段路径携带的 MIME（历史沿用，勿改：老版本字段树已写入该键） */
export const FIELD_DRAG_KEY = 'application/x-openprint-binding'

/** 模块级兜底：同标签页内拖拽是同步过程，getData 失败时可用 */
let pendingPath: string | undefined

/** 字段树侧：条目 dragstart 调用 */
export function startFieldDrag(e: DragEvent, path: string): void {
  e.dataTransfer?.setData(FIELD_DRAG_KEY, path)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  pendingPath = path
}

/** 画布侧：drop 时取回字段路径（取不到则返回空串） */
export function readFieldDrag(e: DragEvent): string {
  const path = e.dataTransfer?.getData(FIELD_DRAG_KEY) || pendingPath || ''
  pendingPath = undefined
  return path
}

/** dragover 判断：是否为本应用的字段拖拽 */
export function isFieldDragOver(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(FIELD_DRAG_KEY)
}

/** 是否为明细数组路径（items[].xxx） */
export function isArrayPath(path: string): boolean {
  return path.includes('[].')
}

/**
 * 明细数组路径 → 单值路径：`items[].phone` → `items[0].phone`。
 * 非明细路径（如 ERP 的 `customer.name`）原样返回，不做任何改写。
 * 已带下标的路径（`items[0].phone`）也不会被二次改写。
 */
export function toSingleValuePath(path: string): string {
  return path.replace(/\[\]\./g, '[0].')
}

/** 落点命中结果 */
export interface FieldDropTarget {
  /** 命中的控件（表格时为表格本身） */
  control: AnyControl
  /** 命中控件为表格时：落点所在的列索引；-1 表示表格无列 */
  columnIndex?: number
}

/**
 * 命中测试：从上往下（数组末尾为最上层，与图层顺序一致）找第一个包围落点的控件。
 * @param controls body 控件列表或页眉/页脚区子控件列表
 * @param xMm 相对该容器左上角的 mm 坐标
 * @param yMm 同上
 */
export function hitFieldDropTarget(
  controls: readonly AnyControl[],
  xMm: number,
  yMm: number,
): FieldDropTarget | null {
  for (let i = controls.length - 1; i >= 0; i--) {
    const c = controls[i]!
    const left = c.left ?? 0
    const top = c.top ?? 0
    if (xMm < left || xMm > left + (c.width ?? 0)) continue
    if (yMm < top || yMm > top + (c.height ?? 0)) continue
    if (c.type === 'table') {
      return { control: c, columnIndex: hitTableColumn(c as TableControl, xMm) }
    }
    return { control: c }
  }
  return null
}

/** 表格列命中：按 columns[].width 依次累加，返回落点所在列索引；无列时返回 -1 */
export function hitTableColumn(table: TableControl, xMm: number): number {
  const cols = table.columns ?? []
  if (cols.length === 0) return -1
  let cursor = table.left ?? 0
  let last = 0
  for (let i = 0; i < cols.length; i++) {
    const w = cols[i]!.width ?? 0
    last = i
    if (xMm >= cursor && xMm <= cursor + w) return i
    cursor += w
  }
  // 落在表格右边缘之外（浮点误差 / 落点略偏）→ 归到最后一列
  return last
}

/**
 * 表格列绑定补丁：写入 `field`（保持 `items[].` 明细前缀，逐行取值）。
 * 列索引非法时返回 null（调用方据此保持原样，不产生空操作历史）。
 */
export function tableColumnBindingPatch(
  table: TableControl,
  columnIndex: number,
  path: string,
): { columns: TableColumn[] } | null {
  const cols = table.columns ?? []
  if (columnIndex < 0 || columnIndex >= cols.length) return null
  const columns = cols.map((c, i) =>
    i === columnIndex ? ({ ...c, field: path, expression: undefined } as TableColumn) : c,
  )
  return { columns }
}

/**
 * 单值控件绑定补丁（正文/页眉/页脚里的文本、条码、二维码、图片）。
 * 路径自动改写为 `items[0].字段名`（取首条记录）—— 表格外的控件没有行上下文。
 * 不支持绑定的控件类型返回 null。
 */
export function singleValueBindingPatch(
  control: AnyControl,
  path: string,
): Partial<AnyControl> | null {
  const p = toSingleValuePath(path)
  switch (control.type) {
    case 'text':
    case 'barcode':
    case 'qrcode':
      // 置 contentType='variable' 并清掉 expression/value，避免三态优先级互相打架
      return {
        contentType: 'variable',
        binding: p,
        expression: undefined,
        value: undefined,
      } as Partial<AnyControl>
    case 'image':
      return { value: { mode: 'binding', content: p } } as Partial<AnyControl>
    default:
      return null
  }
}
