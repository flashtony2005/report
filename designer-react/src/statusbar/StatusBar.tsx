/**
 * StatusBar —— 底部状态栏（P6.1 主流程打磨）
 *
 * Vue 版没有状态栏，React 版补齐（信息密度优先、不打扰）：
 * 左：模板名 + 未保存标记 · 选中控件数
 * 右：网格开关 · 边距线开关 · 缩放百分比（与 ZoomBar/滚轮同源）
 * 所有开关只改运行时视图状态（不标 dirty、不持久化），与 Vue 版 setGrid 语义一致。
 */
import { useDesignerStore } from '../stores/designer'
import { useUiStore } from '../stores/ui'
import { zoomLabel } from '@/design/canvas/zoom'
import './status-bar.css'

export default function StatusBar() {
  const templateName = useDesignerStore((s) => s.templateName)
  const dirty = useDesignerStore((s) => s.dirty)
  const selectedCount = useDesignerStore((s) => s.selectedIds.length)
  const pageCount = useDesignerStore((s) => s.pageCount)
  const gridVisible = useDesignerStore((s) => s.gridConfig.visible)
  const setGrid = useDesignerStore((s) => s.setGrid)
  const zoom = useDesignerStore((s) => s.viewport.zoom)
  const showMarginGuides = useUiStore((s) => s.showMarginGuides)
  const toggleMarginGuides = useUiStore((s) => s.toggleMarginGuides)

  return (
    <footer className="status-bar" data-testid="status-bar">
      <div className="status-left">
        <span className="status-name" title={templateName || '未命名模板'}>
          {templateName || '未命名模板'}
        </span>
        {dirty && (
          <span className="status-dirty" title="有未保存的修改" data-testid="status-dirty">
            ●
          </span>
        )}
        {selectedCount > 0 && (
          <span className="status-item" data-testid="status-selection">
            已选 {selectedCount} 项
          </span>
        )}
      </div>

      <div className="status-right">
        <span className="status-item" data-testid="status-page">
          {pageCount} 页
        </span>
        <button
          type="button"
          className={`status-toggle ${gridVisible ? 'is-on' : ''}`}
          onClick={() => setGrid({ visible: !gridVisible })}
          data-testid="status-grid"
        >
          网格{gridVisible ? '开' : '关'}
        </button>
        <button
          type="button"
          className={`status-toggle ${showMarginGuides ? 'is-on' : ''}`}
          onClick={toggleMarginGuides}
          data-testid="status-margin"
        >
          边距线{showMarginGuides ? '开' : '关'}
        </button>
        <span className="status-zoom" data-testid="status-zoom">
          {zoomLabel(zoom)}
        </span>
      </div>
    </footer>
  )
}
