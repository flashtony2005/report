/**
 * TableStylePickerModal —— 表格「样式库」预览弹窗（React 版，P4.2）
 *
 * 与 Vue 版交互一致：网格卡片展示每种预设的**真实渲染效果**（与设计画布 / 预览 / PDF
 * 同一份 `.op-table` CSS，来自共享 tableCss()），点击卡片即应用并关闭。
 */
import { Button, Modal } from 'antd'
import { useEffect } from 'react'
import type { TableStylePreset } from '@/types/control'
import { tableCss } from '@/core/renderer-html/css-generator'
import { TABLE_STYLE_PRESETS } from '@/design/canvas/table-style-presets'
import './table-style-picker.css'

interface Props {
  show: boolean
  /** 当前已选预设（用于高亮） */
  current?: TableStylePreset
  onCancel: () => void
  onSelect: (key: TableStylePreset) => void
}

/** 预览样例行（与渲染端同构：is-header / is-data / is-summary 类驱动预设视觉效果） */
const SAMPLE_ROWS = `
  <tr class="is-header"><td>产品</td><td>数量</td><td>金额</td></tr>
  <tr class="is-data"><td>商品 A</td><td>12</td><td>240.00</td></tr>
  <tr class="is-data"><td>商品 B</td><td>8</td><td>160.00</td></tr>
  <tr class="is-data"><td>商品 C</td><td>5</td><td>90.00</td></tr>
  <tr class="is-summary"><td>合计</td><td>25</td><td>490.00</td></tr>`

/** 为某个预设生成一张可点击的预览表 HTML（静态模板 + 共享 CSS，无用户输入） */
function previewHtml(key: TableStylePreset): string {
  const borders = TABLE_STYLE_PRESETS.find((p) => p.key === key)?.borders ?? 'all'
  return (
    `<table class="op-table b-${borders} va-middle ts-${key}">` +
    `<colgroup><col style="width:42%"><col style="width:20%"><col style="width:38%"></colgroup>` +
    `<tbody>${SAMPLE_ROWS}</tbody></table>`
  )
}

/** 全局注入 .op-table 规则，使弹窗内的预览表（不在 .op-table-overlay 内）正确着色 */
const STYLE_ID = 'op-style-gallery-css'

export default function TableStylePickerModal({ show, current, onCancel, onSelect }: Props) {
  useEffect(() => {
    if (!show) return
    if (!document.getElementById(STYLE_ID)) {
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = tableCss()
      document.head.appendChild(el)
    }
    return () => {
      document.getElementById(STYLE_ID)?.remove()
    }
  }, [show])

  return (
    <Modal
      open={show}
      title="表格样式库"
      width={720}
      mask={{ closable: false }}
      onCancel={onCancel}
      footer={
        <div className="flex justify-end">
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
        </div>
      }
    >
      <div className="text-12px" style={{ color: '#8a8f99' }}>
        点击任意样式即可套用，画布 / 预览 / 导出效果与此预览完全一致（类似 Excel 表格样式快速切换）。
      </div>

      <div className="ts-gallery">
        {TABLE_STYLE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`style-card${p.key === current ? ' is-selected' : ''}`}
            onClick={() => onSelect(p.key)}
          >
            <div className="style-preview" dangerouslySetInnerHTML={{ __html: previewHtml(p.key) }} />
            <div className="style-meta">
              <span className="style-label">{p.label}</span>
              <span className="style-check">✓</span>
            </div>
            <div className="style-desc">{p.desc}</div>
          </button>
        ))}
      </div>
    </Modal>
  )
}
