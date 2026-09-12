/**
 * RightPanel —— 右侧属性面板（React 版）
 *
 * 结构与 Vue 版一致：CommonProps（通用段，所有类型共享）+ 类型专属面板。
 * 按「当前选中控件类型」分发到对应属性面板。
 *
 * 已接入：text / zone / barcode / qrcode / math / signature / image /
 * shape / chart / labelgrid / table（P4.2）/ richtext（P4.3，tiptap 懒加载）。
 */
import type { ComponentType } from 'react'
import type { ControlType } from '@/types/control'
import { useDesignerStore } from '../stores/designer'
import { selectSelectedControl } from '../stores/selectors'
import CommonProps from './props/CommonProps'
import TextProps from './props/TextProps'
import ZoneProps from './props/ZoneProps'
import CodeProps from './props/CodeProps'
import MathProps from './props/MathProps'
import SignatureProps from './props/SignatureProps'
import ImageProps from './props/ImageProps'
import ShapeProps from './props/ShapeProps'
import ChartProps from './props/ChartProps'
import LabelGridProps from './props/LabelGridProps'
import TableProps from './props/TableProps'
import RichTextProps from './props/RichTextProps'
import './props.css'

const PANEL_BY_TYPE: Partial<Record<ControlType, ComponentType>> = {
  text: TextProps,
  zone: ZoneProps,
  barcode: CodeProps,
  qrcode: CodeProps,
  math: MathProps,
  signature: SignatureProps,
  image: ImageProps,
  rect: ShapeProps,
  line: ShapeProps,
  chart: ChartProps,
  labelgrid: LabelGridProps,
  table: TableProps,
  richtext: RichTextProps,
}

export default function RightPanel() {
  const control = useDesignerStore(selectSelectedControl)

  if (!control) {
    return (
      <div className="p-4 text-center text-xs text-gray-400">
        选中画布中的控件后，在此编辑属性
      </div>
    )
  }

  const Panel = PANEL_BY_TYPE[control.type]
  return (
    <div className="flex h-full flex-col overflow-y-auto p-2">
      {/* 与 Vue 版一致：类型专属面板在前，通用段在后 */}
      {Panel ? (
        <Panel />
      ) : (
        <div className="p-4 text-center text-xs text-gray-400">
          「{control.type}」属性面板将在 P3.4 接入
        </div>
      )}
      <CommonProps />
    </div>
  )
}
