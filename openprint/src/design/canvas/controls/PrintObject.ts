/**
 * PrintObject —— 所有打印控件的公共契约
 *
 * 设计约定（《设计方案》§8.1.2）：
 * - 每个控件是 Fabric 子类，实例上挂 `controlId` 与 `controlType`
 * - `toControl()` 把 Fabric 对象序列化回协议模型（px → mm 由这里统一换算）
 * - 属性面板通过 `applyControlProps(control)` 把模型写回 Fabric 对象
 *
 * 坐标：协议层 mm（相对 Section 左上角）⇄ 画布层 px（MM_TO_PX，zoom=1）。
 */
import type { FabricObject } from 'fabric'
import type { AnyControl, ControlType } from '@/types/control'
import { MM_TO_PX } from '@/utils/constants'

/** 所有打印控件实例都实现的接口 */
export interface IPrintObject {
  controlId: string
  controlType: ControlType
  /** 所属区域：body 或某个 zone 的 controlId */
  zoneId?: string
  /** 所属标签网格（labelgrid）controlId：作为其首卡子组件存在（设计期可移动/编辑） */
  childOf?: string
  toControl(): AnyControl
  // 参数声明为 AnyControl（方法双变允许各子类收窄为自己的控件类型）
  applyControlProps(control: AnyControl): void
}

export function isPrintObject(obj: unknown): obj is FabricObject & IPrintObject {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'controlId' in obj &&
    'controlType' in obj &&
    typeof (obj as IPrintObject).toControl === 'function'
  )
}

/* ------------------------------ 几何换算 helpers ------------------------------ */

export const mm = (v: number): number => v * MM_TO_PX
export const px = (v: number): number => v / MM_TO_PX

/**
 * 读取对象的公共几何（px → mm），返回 ControlBase 的几何部分。
 *
 * 【坐标系警告】这里的 left/top 是 **Fabric 绝对画布坐标**（页面左上角为原点），
 * 而协议层 / store 模型用的是「相对页边距内容区（或所属色带）左上角」。
 * 因此 `toControl()` 的结果 **不可直接写回 store**，必须先经
 * `CanvasDesigner.readControl(obj)` 归一化，否则 `updateControl()` 会再叠加
 * 一次 origin，控件每次操作都向右下平移一个页边距。
 */
export function readBaseGeometry(obj: FabricObject & IPrintObject) {
  // 兜底：fabric 对象的几何在异常时序下可能为 NaN/undefined（如 viewport 未就绪时
  // 创建的对象），`?? 0` 对 NaN 无效，必须用 Number.isFinite 收敛，否则序列化回协议的
  // left/top 带 NaN，写回 store 后 NInputNumber 会渲染删除线。
  const r1 = (n: number): number => Math.round(n * 10) / 10
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    id: obj.controlId,
    left: r1(px(num(obj.left))),
    top: r1(px(num(obj.top))),
    width: r1(px(num(obj.getScaledWidth()))),
    height: r1(px(num(obj.getScaledHeight()))),
    angle: num(obj.angle),
  }
}

export const round2 = (n: number): number => Math.round(n * 100) / 100
