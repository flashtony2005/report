/**
 * ShapeProps —— 矩形 / 圆形 / 线条控件属性（React 版，P4.2）
 *
 * 与 Vue 版交互一致：形状切换（rect⇄circle）、填充/描边色、线宽、
 * 统一圆角 + 四角独立弧度、正圆还原、虚线开关。
 * patch 生成全部来自共享 shape-props-logic（两端同源）。
 */
import { Button, ColorPicker, InputNumber, Select, Switch } from 'antd'
import type { LineControl, RectControl } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { selectSelectedControl } from '../../stores/selectors'
import {
  cornerRadiusPatch,
  dashedPatch,
  isDashed,
  perfectCirclePatch,
  radiusOf,
  shapeChangePatch,
  unifiedRadiusPatch,
} from '@/design/panels/props/shared/shape-props-logic'

const FILL_SWATCHES = ['transparent', '#FFFFFF', '#F5F7FA', '#1677FF', '#000000']
const STROKE_SWATCHES = ['#000000', '#333333', '#999999', '#E5E7EB', '#1677FF', '#F5222D']

export default function ShapeProps() {
  const control = useDesignerStore(selectSelectedControl) as RectControl | LineControl | undefined
  if (!control || (control.type !== 'rect' && control.type !== 'line')) return null

  const isRect = control.type === 'rect'
  const isCircle = isRect && (control as RectControl).shape === 'circle'
  const rect = control as RectControl

  const patch = (p: Record<string, unknown>): void => {
    useDesignerStore.getState().updateControl(control.id, p)
  }

  return (
    <div className="props-section">
      <div className="props-title">{isCircle ? '圆形样式' : isRect ? '矩形样式' : '线条样式'}</div>

      {isRect && (
        <div className="props-row">
          <span className="props-label">形状</span>
          <Select
            size="small"
            style={{ flex: 1 }}
            value={(rect as RectControl).shape ?? 'rect'}
            options={[
              { label: '矩形', value: 'rect' },
              { label: '圆形', value: 'circle' },
            ]}
            onChange={(v) => patch(shapeChangePatch(rect, v))}
          />
        </div>
      )}

      {isRect && (
        <div className="props-row">
          <span className="props-label">填充</span>
          <ColorPicker
            size="small"
            disabledAlpha
            value={(rect as RectControl).fill ?? '#FFFFFF'}
            onChange={(c) => patch({ fill: c.toHexString() })}
          />
        </div>
      )}

      <div className="props-row">
        <span className="props-label">描边</span>
        <ColorPicker
          size="small"
          disabledAlpha
          value={control.stroke ?? '#000000'}
          onChange={(c) => patch({ stroke: c.toHexString() })}
        />
      </div>

      <div className="props-row">
        <span className="props-label">线宽</span>
        <InputNumber
          size="small"
          value={control.strokeWidth ?? 1}
          min={0}
          max={20}
          precision={1}
          onChange={(v) => patch({ strokeWidth: v ?? 1 })}
        />
      </div>

      {/* 统一圆角（仅矩形） */}
      {isRect && !isCircle && (
        <div className="props-row">
          <span className="props-label">圆角</span>
          <InputNumber
            size="small"
            value={(rect as RectControl).cornerRadius ?? 0}
            min={0}
            onChange={(v) => patch(unifiedRadiusPatch(v))}
          />
        </div>
      )}

      {/* 四角独立弧度（仅矩形） */}
      {isRect && !isCircle && (
        <div className="props-sub">
          <div className="props-title-tip">四角弧度（px）</div>
          <div className="grid grid-cols-2 gap-2">
            {(['TL', 'TR', 'BL', 'BR'] as const).map((side) => (
              <div key={side} className="props-row">
                <span className="props-label">{{ TL: '左上', TR: '右上', BL: '左下', BR: '右下' }[side]}</span>
                <InputNumber
                  size="small"
                  value={radiusOf(rect, side)}
                  min={0}
                  onChange={(v) => patch(cornerRadiusPatch(side, v))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 圆形：一键还原正圆 */}
      {isCircle && (
        <div className="props-row">
          <span className="props-label">正圆</span>
          <Button size="small" onClick={() => patch(perfectCirclePatch(rect))}>
            还原为正圆
          </Button>
        </div>
      )}

      {/* 虚线开关（矩形、圆形、线条都支持） */}
      <div className="props-row">
        <span className="props-label">虚线</span>
        <Switch size="small" checked={isDashed(control)} onChange={(v) => patch(dashedPatch(v))} />
      </div>
    </div>
  )
}
