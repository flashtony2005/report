/**
 * PrintZone —— 页眉/页脚区域控件（《设计方案》§5.14）
 *
 * Word 式布局：页眉/页脚位于**页顶/页底边缘**（Y 贴边），正文独占内容区。
 * 与渲染端一致：页眉/页脚 section 是**整页全宽**（left:0, width=页宽，不受左右边距影响），
 * 高度方向贴页顶/页底 —— 所见即所得（拖到色带左边缘 = 纸张左边缘）。
 * 画布表现：一条横向锁定色带：
 * - header 色带：top=0（页顶），高度可改（仅底部中点手柄）
 * - footer 色带：top=页高-高（页底），高度可改（仅顶部中点手柄）
 * - 自身不可移动/旋转（位置由页顶/页底固定）
 * - 单例：每页最多一个 header + 一个 footer（由 CanvasDesigner.addZone 保证）
 * - 序列化目标是 sections[header/footer]，不进 body.components
 */
import { Rect } from 'fabric'
import type { ZoneControl } from '@/types/control'
import { mm, px, round2, type IPrintObject } from './PrintObject'

export class PrintZone extends Rect implements IPrintObject {
  controlId: string
  controlType = 'zone' as const

  zone: 'header' | 'footer'
  repeat = true

  private readonly pageHeightMm: number
  private readonly marginLeftMm: number
  private readonly marginRightMm: number

  constructor(
    control: ZoneControl,
    pageWidthMm: number,
    pageHeightMm: number,
    marginLeftMm = 0,
    marginRightMm = 0,
  ) {
    const h = mm(control.zoneHeight)
    super({
      left: 0, // 整页全宽贴纸边（与渲染端 .op-header/.op-footer 一致，不受左右边距影响）
      top: control.zone === 'header' ? 0 : mm(pageHeightMm) - h,
      width: mm(pageWidthMm),
      height: h,
      fill: control.zone === 'header' ? 'rgba(22,119,255,0.05)' : 'rgba(22,119,255,0.04)',
      stroke: 'rgba(22,119,255,0.45)',
      strokeWidth: 1,
      strokeDashArray: [6, 3],
      // 位置锁定：不可移动/旋转/横拉
      lockMovementX: true,
      lockMovementY: true,
      lockRotation: true,
      hasControls: true,
      hasBorders: true,
      selectable: true,
    })
    this.controlId = control.id
    this.zone = control.zone
    this.repeat = control.repeat ?? true
    this.pageHeightMm = pageHeightMm
    this.marginLeftMm = marginLeftMm
    this.marginRightMm = marginRightMm
    this.restrictControls()
  }

  /** 只留内边缘手柄：header 用底部中点(mb)，footer 用顶部中点(mt) */
  private restrictControls(): void {
    const edge = this.zone === 'header' ? 'mb' : 'mt'
    const controls = { ...this.controls }
    for (const key of Object.keys(controls)) {
      if (key !== edge) {
        // 其余手柄禁用
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete controls[key]
      }
    }
    this.controls = controls
  }

  /** 页面尺寸变化时由 CanvasDesigner 调用，重贴页顶/页底（保持整页全宽） */
  relayout(pageWidthMm: number, pageHeightMm: number): void {
    const h = this.height * this.scaleY
    this.set({
      left: 0, // 整页全宽贴纸边（与渲染端一致，不受左右边距影响）
      width: mm(pageWidthMm),
      scaleX: 1,
      scaleY: 1,
      height: h,
      top: this.zone === 'header' ? 0 : mm(pageHeightMm) - h,
    })
    this.setCoords()
  }

  get zoneHeightMm(): number {
    return round2(px(this.height * this.scaleY))
  }

  toControl(): ZoneControl {
    return {
      id: this.controlId,
      type: 'zone',
      zone: this.zone,
      left: 0,
      top: 0,
      width: round2(px(this.getScaledWidth())),
      height: this.zoneHeightMm,
      zoneHeight: this.zoneHeightMm,
      repeat: this.repeat,
      printable: true,
      children: [], // 子组件由 CanvasDesigner.serialize 按几何归属填充
    }
  }

  applyControlProps(control: ZoneControl): void {
    this.repeat = control.repeat ?? true
    if (control.zoneHeight && control.zoneHeight !== this.zoneHeightMm) {
      const h = mm(control.zoneHeight)
      this.set({
        scaleY: 1,
        height: h,
        top: this.zone === 'header' ? 0 : mm(this.pageHeightMm) - h,
      })
      this.setCoords()
    }
    this.canvas?.requestRenderAll()
  }
}
