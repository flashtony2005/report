/**
 * ZoomBar —— 画布右下角缩放工具栏（P6.1 主流程打磨）
 *
 * Vue 版只有 zoom.ts 纯函数 + 滚轮/空格平移，没有工具栏 UI；React 版补上：
 * − / 百分比下拉（ZOOM_PRESETS 档位 + 适应页面） / ＋ / 100% 重置。
 * 缩放档位与文案直接 alias 复用 Vue 端 `@/design/canvas/zoom`（两端同源）。
 * 实际缩放经模块级 canvasHost 调 CanvasDesigner 原生方法；
 * 显示值来自 designer store 的 viewport（onViewportChange 事件回写，滚轮缩放同步）。
 */
import { Button, Dropdown } from 'antd'
import { ZOOM_PRESETS, zoomLabel } from '@/design/canvas/zoom'
import { getCanvasHost, useDesignerStore } from '../stores/designer'
import './zoom-bar.css'

export default function ZoomBar() {
  const zoom = useDesignerStore((s) => s.viewport.zoom)

  const fitToPage = (): void => {
    getCanvasHost()?.fitToHost?.()
  }

  const resetZoom = (): void => {
    // 100%：缩放归一并清掉「用户已手动缩放」语义无法直达内核，这里直接 setZoom(1)
    getCanvasHost()?.setZoom?.(1)
  }

  return (
    <div className="zoom-bar" data-testid="zoom-bar">
      <Button
        size="small"
        type="text"
        aria-label="缩小"
        className="zoom-bar-btn"
        onClick={() => getCanvasHost()?.zoomOut?.()}
      >
        −
      </Button>

      <Dropdown
        trigger={['click']}
        placement="topRight"
        menu={{
          items: [
            ...ZOOM_PRESETS.map((z) => ({
              key: `z${z}`,
              label: zoomLabel(z),
              // 当前档位打点
              ...(Math.abs(z - zoom) < 0.001 ? { icon: <span className="zoom-bar-dot">●</span> } : {}),
            })),
            { type: 'divider' as const },
            { key: 'fit', label: '适应页面' },
          ],
          onClick: ({ key }) => {
            if (key === 'fit') {
              fitToPage()
              return
            }
            const z = Number(key.slice(1))
            if (!Number.isNaN(z)) getCanvasHost()?.setZoom?.(z)
          },
        }}
      >
        <button type="button" className="zoom-bar-label" title="缩放档位" data-testid="zoom-label">
          {zoomLabel(zoom)}
        </button>
      </Dropdown>

      <Button
        size="small"
        type="text"
        aria-label="放大"
        className="zoom-bar-btn"
        onClick={() => getCanvasHost()?.zoomIn?.()}
      >
        ＋
      </Button>

      <Button size="small" type="text" className="zoom-bar-reset" onClick={resetZoom}>
        100%
      </Button>
    </div>
  )
}
