/**
 * PrintImage —— 图片控件（《设计方案》§5.8）
 * inline/url/asset/binding 四种来源；无图时显示占位框。
 */
import { FabricImage, Rect, Group, Textbox, LayoutManager, FixedLayout } from 'fabric'
import type { ImageControl } from '@/types/control'
import { mm, readBaseGeometry, type IPrintObject } from './PrintObject'

/**
 * 图片控件用 Group 承载：底层是 Rect 占位框，加载成功后替换为 FabricImage。
 * Group 方案对 "加载成功/失败/占位" 三态最稳。
 */
export class PrintImage extends Group implements IPrintObject {
  controlId: string
  controlType = 'image' as const
  zoneId?: string
  printable = true
  visibleIf?: string
  controlName?: string

  value?: ImageControl['value']
  fit: NonNullable<ImageControl['fit']> = 'contain'
  cornerRadius?: number
  /** 控件原始几何（mm），loadImage 时 Group width/height 失真的兜底 */
  private _controlWidth = 0
  private _controlHeight = 0

  constructor(control: ImageControl) {
    const w = mm(control.width)
    const h = mm(control.height)
    const placeholder = new Rect({
      width: w,
      height: h,
      left: -w / 2,
      top: -h / 2,
      fill: 'rgba(22,119,255,0.06)',
      stroke: '#c0c4cc',
      strokeDashArray: [4, 3],
      strokeWidth: 1,
      rx: control.cornerRadius ?? 0,
      ry: control.cornerRadius ?? 0,
    })
    const label = new Textbox(control.value?.mode === 'binding' ? `{{${control.value.content}}}` : '图片', {
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
      // Group 默认 origin 是 center，与 Rect 默认 left/top 不同——统一用 left/top
      originX: 'left',
      originY: 'top',
      // FixedLayout：add/remove 子对象时不重算 left/top，避免上传图片后控件跳位
      layoutManager: new LayoutManager(new FixedLayout()),
    })
    this.controlId = control.id
    this.value = control.value
    this.fit = control.fit ?? 'contain'
    this.cornerRadius = control.cornerRadius
    this.printable = control.printable ?? true
    this.visibleIf = control.visibleIf
    this.controlName = control.name
    this._controlWidth = control.width
    this._controlHeight = control.height
    // 从模板恢复时若已有图片内容，立即加载
    void this.loadImage()
  }

  /** 异步加载真实图片替换占位（inline/url 来源；binding 设计期保持占位） */
  async loadImage(): Promise<void> {
    if (!this.value || this.value.mode === 'binding' || !this.value.content) return
    // data: URL 不需要 crossOrigin；外部 URL 设 anonymous 避免画布污染
    const isDataUrl = this.value.content.startsWith('data:')
    const loadOpts = isDataUrl ? {} : { crossOrigin: 'anonymous' as const }
    try {
      const img = await FabricImage.fromURL(this.value.content, loadOpts)
      // Group 的 width/height 可能在子对象变化后失真，用控件原始几何兜底
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
      // Group.add 触发 enterGroup 会 inverse transform 子对象坐标，
      // FixedLayout 下不再有 commitLayout 修正，需手动复位
      img.set({ left: -w / 2, top: -h / 2 })
      this.set({ width: w, height: h })
      this.setCoords()
      this.canvas?.requestRenderAll()
    } catch {
      // 加载失败保持占位框，不阻断设计器
    }
  }

  toControl(): ImageControl {
    return {
      ...readBaseGeometry(this),
      type: 'image',
      value: this.value,
      fit: this.fit,
      cornerRadius: this.cornerRadius,
      printable: this.printable,
      visibleIf: this.visibleIf,
      name: this.controlName,
    }
  }

  applyControlProps(control: ImageControl): void {
    this.value = control.value
    this.fit = control.fit ?? 'contain'
    this.cornerRadius = control.cornerRadius
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
