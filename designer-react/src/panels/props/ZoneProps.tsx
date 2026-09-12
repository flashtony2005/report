/**
 * ZoneProps —— 页眉/页脚区域控件属性（§5.14.3）：高度 / 每页重复
 * 页码变量 {{page}} / {{pageTotal}} 仅在 zone 内文本生效（渲染期注入）。
 * 与 Vue 版 `panels/props/ZoneProps.vue` 行为一致。
 */
import { Alert, InputNumber, Switch } from 'antd'
import type { ZoneControl } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { useSelectedControl } from '../../stores/selectors'
import '../props.css'

export default function ZoneProps() {
  const control = useSelectedControl() as ZoneControl | null

  if (!control) return null

  const patch = (p: Record<string, unknown>): void =>
    useDesignerStore.getState().updateControl(control.id, p)

  return (
    <div className="props-section">
      <div className="props-title">{control.zone === 'header' ? '页眉区域' : '页脚区域'}</div>

      <div className="props-row">
        <span className="props-label" style={{ minWidth: 72 }}>
          高度 (mm)
        </span>
        <InputNumber
          size="small"
          value={control.zoneHeight}
          min={5}
          max={80}
          precision={1}
          style={{ width: '100%' }}
          onChange={(v) => patch({ zoneHeight: v ?? 20, height: v ?? 20 })}
        />
      </div>

      <div className="props-row">
        <span className="props-label" style={{ minWidth: 72 }}>
          每页重复
        </span>
        <Switch
          size="small"
          checked={control.repeat ?? true}
          onChange={(v) => patch({ repeat: v })}
        />
      </div>

      <Alert
        type="info"
        banner={false}
        style={{ fontSize: 12 }}
        title={
          <span>
            区域内文本支持页码变量：<code>{'{{page}}'}</code> / <code>{'{{pageTotal}}'}</code>
            ，渲染时自动注入。直接把控件拖入色带即可成为子组件。
          </span>
        }
      />
    </div>
  )
}
