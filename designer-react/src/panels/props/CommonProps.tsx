/**
 * CommonProps —— 所有控件通用属性：名称 / 几何 / 旋转 / 锁定 / 打印开关（§5.4a）
 * 与 Vue 版 `panels/props/CommonProps.vue` 行为一致，几何单位 mm（协议层）。
 * 纯展示组件：无共享逻辑可抽，两端各自渲染但 patch 语义逐字段对齐。
 */
import { Input, InputNumber, Switch } from 'antd'
import type { AnyControl } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { useSelectedControl } from '../../stores/selectors'
import '../props.css'

export default function CommonProps() {
  const control = useSelectedControl() as AnyControl | null

  if (!control) return null

  const patch = (p: Record<string, unknown>): void =>
    useDesignerStore.getState().updateControl(control.id, p)

  const isZone = control.type === 'zone'
  const num = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0)

  return (
    <div className="props-section">
      <div className="props-title">通用</div>

      <div className="props-row">
        <span className="props-label">名称</span>
        <Input
          size="small"
          value={control.name ?? ''}
          placeholder="图层名称"
          onChange={(e) => patch({ name: e.target.value || undefined })}
        />
      </div>

      {!isZone && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="props-row">
              <span className="props-label">X</span>
              <InputNumber
                size="small"
                value={num(control.left)}
                precision={1}
                step={0.1}
                style={{ width: '100%' }}
                onChange={(v) => patch({ left: v ?? 0 })}
              />
            </div>
            <div className="props-row">
              <span className="props-label">Y</span>
              <InputNumber
                size="small"
                value={num(control.top)}
                precision={1}
                step={0.1}
                style={{ width: '100%' }}
                onChange={(v) => patch({ top: v ?? 0 })}
              />
            </div>
            <div className="props-row">
              <span className="props-label">宽</span>
              <InputNumber
                size="small"
                value={num(control.width)}
                precision={1}
                min={0}
                style={{ width: '100%' }}
                onChange={(v) => patch({ width: v ?? 0 })}
              />
            </div>
            <div className="props-row">
              <span className="props-label">高</span>
              <InputNumber
                size="small"
                value={num(control.height)}
                precision={1}
                min={0}
                style={{ width: '100%' }}
                onChange={(v) => patch({ height: v ?? 0 })}
              />
            </div>
          </div>

          <div className="props-row">
            <span className="props-label">旋转</span>
            <InputNumber
              size="small"
              value={control.angle ?? 0}
              min={-360}
              max={360}
              style={{ width: 100 }}
              onChange={(v) => patch({ angle: v ?? 0 })}
            />
          </div>

          <div className="props-row">
            <span className="props-label">锁定</span>
            <Switch
              size="small"
              checked={control.locked ?? false}
              onChange={(v) => patch({ locked: v || undefined })}
            />
          </div>
        </>
      )}

      <div className="props-row">
        <span className="props-label">打印此元素</span>
        <Switch
          size="small"
          checked={control.printable ?? true}
          onChange={(v) => patch({ printable: v })}
        />
      </div>

      <div className="props-row">
        <span className="props-label">常驻辅助线</span>
        <Switch
          size="small"
          checked={control.showGuides ?? false}
          onChange={(v) => patch({ showGuides: v || undefined })}
        />
      </div>
    </div>
  )
}
