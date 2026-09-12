/**
 * MathProps —— 公式控件属性面板
 * 编辑：LaTeX 源码（多行文本）、显示模式（块级/行内）、字号、颜色、公式模板一键插入。
 * 所有改动经 store.updateControl 写入，触发画布重绘（与 Vue 版一致）。
 */
import { Button, ColorPicker, Input, InputNumber, Select } from 'antd'
import type { MathControl } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { useSelectedControl } from '../../stores/selectors'
import '../props.css'

/* ----------------------------- 公式模板 ----------------------------- */
interface FormulaTemplate {
  label: string
  latex: string
}

const TEMPLATES: FormulaTemplate[] = [
  { label: '二次公式', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
  { label: '勾股定理', latex: 'a^2 + b^2 = c^2' },
  { label: '求和', latex: '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}' },
  { label: '积分', latex: '\\int_{a}^{b} f(x)\\,dx' },
  { label: '极限', latex: '\\lim_{x \\to \\infty} \\frac{1}{x} = 0' },
  { label: '分数', latex: '\\frac{a}{b}' },
  { label: '矩阵', latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
  { label: '根号', latex: '\\sqrt[n]{x}' },
  { label: '向量', latex: '\\vec{a} + \\vec{b}' },
  { label: '上标下标', latex: 'x_i^2 + y_i^2' },
]

const TEMPLATE_OPTIONS = TEMPLATES.map((t) => ({ label: t.label, value: t.latex }))

export default function MathProps() {
  const control = useSelectedControl() as MathControl | null

  if (!control) return null

  const patch = (p: Record<string, unknown>): void =>
    useDesignerStore.getState().updateControl(control.id, p)

  const latex = control.latex ?? ''
  const displayMode = control.displayMode ?? true
  const fontSize = control.fontSize ?? 16
  const color = control.color ?? '#000000'

  const templateOptions = (
    <Select
      size="small"
      options={TEMPLATE_OPTIONS}
      placeholder="选择模板插入"
      style={{ width: 140, marginLeft: 'auto' }}
      value={null}
      onChange={(v: string) => {
        if (v) patch({ latex: v })
      }}
    />
  )

  return (
    <div className="props-section">
      <div className="props-title">公式设置</div>

      <div className="props-row">
        <span className="props-label">显示模式</span>
        <Select
          size="small"
          style={{ width: '100%' }}
          value={displayMode ? 'display' : 'inline'}
          options={[
            { label: '块级（居中独立行）', value: 'display' },
            { label: '行内', value: 'inline' },
          ]}
          onChange={(v: string) => patch({ displayMode: v === 'display' })}
        />
      </div>

      <div className="props-row">
        <span className="props-label" style={{ minWidth: 56 }}>
          字号(pt)
        </span>
        <InputNumber
          size="small"
          value={fontSize}
          min={6}
          step={1}
          style={{ width: 100 }}
          onChange={(v) => patch({ fontSize: v ?? 16 })}
        />
      </div>

      <div className="props-row">
        <span className="props-label" style={{ minWidth: 56 }}>
          颜色
        </span>
        <div style={{ width: 100 }}>
          <ColorPicker
            size="small"
            value={color}
            onChange={(c) => patch({ color: c.toHexString() })}
          />
        </div>
      </div>

      <div className="props-title">
        公式模板
        {templateOptions}
      </div>

      <div className="props-title">LaTeX 源码</div>
      <div className="props-row">
        <Input.TextArea
          size="small"
          autoSize={{ minRows: 3, maxRows: 12 }}
          value={latex}
          placeholder="输入 LaTeX 公式，如 c = \\pm\\sqrt{a^2 + b^2}"
          onChange={(e) => patch({ latex: e.target.value })}
        />
      </div>

      <div className="props-row" style={{ marginTop: 4 }}>
        <Button size="small" type="text" onClick={() => patch({ latex: TEMPLATES[0]!.latex })}>
          二次公式
        </Button>
        <Button size="small" type="text" onClick={() => patch({ latex: TEMPLATES[3]!.latex })}>
          积分
        </Button>
        <Button size="small" type="text" onClick={() => patch({ latex: TEMPLATES[6]!.latex })}>
          矩阵
        </Button>
      </div>
    </div>
  )
}
