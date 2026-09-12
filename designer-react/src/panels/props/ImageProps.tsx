/**
 * ImageProps —— 图片控件属性（§5.8）
 * inline 上传转 Base64 / url 外链 / binding 绑定字段（弹窗选字段）。
 * 与 Vue 版行为一致；字段选择弹窗为 React 版 VariableModal。
 */
import { Button, Input, InputNumber, Select, Upload } from 'antd'
import { useState } from 'react'
import type { ImageControl, ImageValueMode } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { useSelectedControl } from '../../stores/selectors'
import VariableModal from './VariableModal'
import '../props.css'

const MODE_OPTIONS = [
  { label: '上传图片', value: 'inline' },
  { label: '图片 URL', value: 'url' },
  { label: '绑定字段', value: 'binding' },
]

const FIT_OPTIONS = [
  { label: '包含 contain', value: 'contain' },
  { label: '覆盖 cover', value: 'cover' },
  { label: '拉伸 fill', value: 'fill' },
  { label: '原始 none', value: 'none' },
]

export default function ImageProps() {
  const control = useSelectedControl() as ImageControl | null
  const [varModalShow, setVarModalShow] = useState(false)

  if (!control) return null

  const patch = (p: Record<string, unknown>): void =>
    useDesignerStore.getState().updateControl(control.id, p)

  const mode: ImageValueMode = control.value?.mode ?? 'inline'
  const patchContent = (content: string): void =>
    patch({ value: { mode, content } })

  /** 上传 → Base64 inline（§5.8 默认来源，自包含离线可用） */
  const onUpload = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => patchContent(reader.result as string)
    reader.readAsDataURL(file)
  }

  return (
    <>
      <div className="props-section">
        <div className="props-title">图片来源</div>

        <div className="props-row">
          <span className="props-label">方式</span>
          <Select
            size="small"
            style={{ width: '100%' }}
            value={mode}
            options={MODE_OPTIONS}
            onChange={(m) => patch({ value: { mode: m as ImageValueMode, content: '' } })}
          />
        </div>

        {mode === 'inline' && (
          <div className="props-row" style={{ width: '100%' }}>
            <Upload
              showUploadList={false}
              accept="image/*"
              customRequest={({ file }) => onUpload(file as File)}
            >
              <Button size="small" variant="dashed" block>
                选择图片（转 Base64 内联）
              </Button>
            </Upload>
          </div>
        )}
        {mode === 'url' && (
          <div className="props-row" style={{ width: '100%' }}>
            <Input
              size="small"
              value={control.value?.content ?? ''}
              placeholder="https://…"
              onChange={(e) => patchContent(e.target.value)}
            />
          </div>
        )}
        {mode === 'binding' && (
          <div className="props-row img-var-row" style={{ width: '100%' }}>
            <Input
              size="small"
              style={{ flex: '1 1 auto', minWidth: 0 }}
              value={control.value?.content ?? ''}
              placeholder="字段路径，如 order.photoUrl"
              onChange={(e) => patchContent(e.target.value)}
            />
            <Button size="small" onClick={() => setVarModalShow(true)}>
              选择字段
            </Button>
          </div>
        )}
      </div>

      <VariableModal
        show={varModalShow}
        binding={mode === 'binding' ? (control.value?.content ?? '') : ''}
        onCancel={() => setVarModalShow(false)}
        onConfirm={(path) => {
          patchContent(path)
          setVarModalShow(false)
        }}
      />

      <div className="props-section">
        <div className="props-title">显示</div>
        <div className="props-row">
          <span className="props-label">填充</span>
          <Select
            size="small"
            style={{ width: '100%' }}
            value={control.fit ?? 'contain'}
            options={FIT_OPTIONS}
            onChange={(v) => patch({ fit: v })}
          />
        </div>
        <div className="props-row">
          <span className="props-label">圆角</span>
          <InputNumber
            size="small"
            value={control.cornerRadius ?? 0}
            min={0}
            style={{ width: '100%' }}
            onChange={(v) => patch({ cornerRadius: v ?? 0 })}
          />
        </div>
      </div>
    </>
  )
}
