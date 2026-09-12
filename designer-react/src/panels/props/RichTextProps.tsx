/**
 * RichTextProps —— 富文本控件属性
 * tiptap 编辑器通过 React.lazy 懒加载，避免拖入/浏览时加载重型依赖（对齐 Vue 版）。
 */
import { lazy, Suspense } from 'react'
import { InputNumber } from 'antd'
import type { RichTextControl } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { selectSelectedControl } from '../../stores/selectors'

const RichTextEditor = lazy(() => import('./RichTextEditor'))

export default function RichTextProps() {
  const control = useDesignerStore(selectSelectedControl) as RichTextControl | undefined
  if (!control || control.type !== 'richtext') return null

  const patch = (p: Record<string, unknown>): void => {
    useDesignerStore.getState().updateControl(control.id, p)
  }

  return (
    <>
      <div className="props-section">
        <div className="props-title">内容</div>
        <div className="props-hint">在此输入富文本，画布实时预览</div>
        <Suspense fallback={<div className="props-hint">编辑器加载中…</div>}>
          <RichTextEditor value={control.value ?? ''} onChange={(html) => patch({ value: html })} />
        </Suspense>
      </div>

      <div className="props-section">
        <div className="props-title">尺寸</div>
        <div className="props-grid-2">
          <div className="props-row">
            <span className="props-label">宽</span>
            <InputNumber
              size="small"
              value={control.width}
              min={1}
              onChange={(v) => patch({ width: v ?? control.width })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">高</span>
            <InputNumber
              size="small"
              value={control.height}
              min={1}
              onChange={(v) => patch({ height: v ?? control.height })}
            />
          </div>
        </div>
      </div>
    </>
  )
}
