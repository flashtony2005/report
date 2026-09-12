/**
 * CodeProps —— 条码 / 二维码控件属性（§5.7）
 * 内容三态复用共享 panel-logic（resolveContentMode / contentModePatch），与 Vue 版行为一致。
 */
import { Select, Switch } from 'antd'
import type { BarcodeControl, QrcodeControl } from '@/types/control'
import {
  contentModePatch,
  resolveContentMode,
  type ContentMode,
} from '@/design/panels/props/shared/panel-logic'
import { useDesignerStore } from '../../stores/designer'
import { useSelectedControl } from '../../stores/selectors'
import ContentValueEditor from './ContentValueEditor'
import '../props.css'

const BARCODE_FORMATS = [
  { label: 'CODE128', value: 'CODE128' },
  { label: 'EAN-13', value: 'EAN13' },
  { label: 'EAN-8', value: 'EAN8' },
  { label: 'CODE39', value: 'CODE39' },
  { label: 'ITF-14', value: 'ITF14' },
  { label: 'UPC-A', value: 'UPCA' },
]

const QRCODE_LEVELS = [
  { label: 'L（7%）', value: 'L' },
  { label: 'M（15%）', value: 'M' },
  { label: 'Q（25%）', value: 'Q' },
  { label: 'H（30%）', value: 'H' },
]

export default function CodeProps() {
  const control = useSelectedControl() as BarcodeControl | QrcodeControl | null

  if (!control) return null

  const patch = (p: Record<string, unknown>): void =>
    useDesignerStore.getState().updateControl(control.id, p)

  const isBarcode = control.type === 'barcode'
  const contentMode = resolveContentMode(control)
  const onModeChange = (m: ContentMode): void => patch(contentModePatch(m))

  return (
    <div className="props-section">
      <div className="props-title">{isBarcode ? '条码设置' : '二维码设置'}</div>

      <ContentValueEditor
        mode={contentMode}
        value={control.value ?? ''}
        binding={control.binding ?? ''}
        expression={control.expression ?? ''}
        placeholder="编码内容"
        singleLine
        bindingDefault="order.orderNo"
        expressionDefault="{{order.orderNo}}"
        onModeChange={onModeChange}
        onValueChange={(v) => patch({ value: v || undefined })}
        onBindingChange={(v) => patch({ binding: v })}
        onExpressionChange={(v) => patch({ expression: v || undefined })}
      />

      {isBarcode ? (
        <>
          <div className="props-row">
            <span className="props-label">格式</span>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={(control as BarcodeControl).format ?? 'CODE128'}
              options={BARCODE_FORMATS}
              onChange={(v) => patch({ format: v })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">显示文字</span>
            <Switch
              size="small"
              checked={(control as BarcodeControl).showText ?? true}
              onChange={(v) => patch({ showText: v })}
            />
          </div>
        </>
      ) : (
        <div className="props-row">
          <span className="props-label">纠错级</span>
          <Select
            size="small"
            style={{ width: '100%' }}
            value={(control as QrcodeControl).errorLevel ?? 'M'}
            options={QRCODE_LEVELS}
            onChange={(v) => patch({ errorLevel: v })}
          />
        </div>
      )}
    </div>
  )
}
