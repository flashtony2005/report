/**
 * SignatureProps —— 手写签名属性面板
 * 预览笔迹 + 回显画笔粗细/笔色 + 「重新签名」（重新打开手写画板）。
 * 位置/大小/锁定/删除等通用属性由 CommonProps 负责。与 Vue 版行为一致。
 */
import { Button } from 'antd'
import type { SignatureControl } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { useSelectedControl } from '../../stores/selectors'
import '../props.css'

export default function SignatureProps() {
  const control = useSelectedControl() as SignatureControl | null

  if (!control) return null

  return (
    <div className="props-section">
      <div className="props-title">签名</div>

      <div className="props-row">
        <div className="signature-preview">
          {control.src ? (
            <img src={control.src} alt="签名预览" />
          ) : (
            <span style={{ fontSize: 12, color: 'var(--brand-text-3, #6b7280)' }}>尚未签名</span>
          )}
        </div>
      </div>

      <div className="props-row">
        <span className="props-label">画笔粗细</span>
        <span style={{ fontSize: 12 }}>{control.penWidth ?? 1} px</span>
      </div>

      <div className="props-row">
        <span className="props-label">笔色</span>
        <span className="color-swatch" style={{ background: control.color ?? '#000000' }} />
      </div>

      <div className="props-row" style={{ width: '100%' }}>
        <Button
          size="small"
          type="primary"
          block
          onClick={() => useDesignerStore.getState().openSignaturePad()}
        >
          重新签名
        </Button>
      </div>
    </div>
  )
}
