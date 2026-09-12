/**
 * PrintSignature —— 手写签名控件（类比 PrintImage）
 *
 * 签名是**位图**（用户笔迹无法矢量还原），故复用图片的"Group 宿主 + FabricImage"方案：
 * 底层 Rect 占位框（无 src / 加载中显示），笔迹 PNG 就绪后替换为 FabricImage 并铺满控件框。
 * 序列化只存 PNG data-URI（src）+ 笔刷元数据（penWidth / color），恢复时由 src 重绘。
 */
import { FabricImage, Rect, Group, Textbox, LayoutManager, FixedLayout } from 'fabric'
import type { SignatureControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'

export class PrintSignature extends Group implements IPrintObject {
  controlId: string
  controlType = 'signature' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  src: string
  penWidth: number
  color: string
  /** 控件原始几何（mm），loadImage 时 Group width/height 失真的兜底 */
  private _controlWidth = 0
  private _controlHeight = 0

  constructor(control: SignatureControl) {
    const w = mm(control.width)
    const h = mm(control.height)
    const placeholder = new Rect({
      width: w,
      height: h,
      left: -w / 2,
      top: -h / 2,
      fill: 'rgba(22,119,255,0.04)',
      stroke: '#c0c4cc',
      strokeDashArray: [4, 3],
      strokeWidth: 1,
      rx: 0,
      ry: 0,
    })
    const label = new Textbox(control.src ? '签名' : '手写签名', {
      left: -w / 2,
      top: -8,
      width: w,
      fontSize: 11,
      fill: '#909399',
      textAlign: 'center',
      selectable: false,
      evented: false,
    })
    super([placeholder, label], {
      left: mm(control.left),
      top: mm(control.top),
      angle: control.angle ?? 0,
      lockMovementX: control.locked,
      lockMovementY: control.locked,
      // Group 默认 origin 是 center，统一用 left/top
      originX: 'left',
      originY: 'top',
      // FixedLayout：add/remove 子对象时不重算 left/top，避免上传图片后控件跳位
      layoutManager: new LayoutManager(new FixedLayout()),
    })
    this.controlId = control.id
    this.src = control.src ?? ''
    this.penWidth = control.penWidth ?? 3
    this.color = control.color ?? '#000000'
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this._controlWidth = control.width
    this._controlHeight = control.height
    void this.loadImage()
  }

  /** 异步加载笔迹 PNG 替换占位（inline data-URI，本地自包含） */
  async loadImage(): Promise<void> {
    if (!this.src) return
    try {
      const img = await FabricImage.fromURL(this.src, {})
      const w = this.width || mm(this._controlWidth)
      const h = this.height || mm(this._controlHeight)
      img.set({
        left: -w / 2,
        top: -h / 2,
        originX: 'left',
        originY: 'top',
        scaleX: w / (img.width || w),
        scaleY: h / (img.height || h),
      })
      this.remove(...this.getObjects())
      this.add(img)
      img.set({ left: -w / 2, top: -h / 2 })
      this.set({ width: w, height: h })
      this.setCoords()
      this.canvas?.requestRenderAll()
    } catch {
      // 加载失败保持占位框，不阻断设计器
    }
  }

  toControl(): SignatureControl {
    return {
      ...readBaseGeometry(this),
      type: 'signature',
      src: this.src,
      penWidth: this.penWidth,
      color: this.color,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: SignatureControl): void {
    this.src = control.src ?? ''
    this.penWidth = control.penWidth ?? 3
    this.color = control.color ?? '#000000'
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this._controlWidth = control.width
    this._controlHeight = control.height
    this.set({
      lockMovementX: control.locked,
      lockMovementY: control.locked,
    })
    void this.loadImage()
    this.setCoords()
    this.canvas?.requestRenderAll()
  }
}
