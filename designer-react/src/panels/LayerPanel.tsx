/**
 * LayerPanel —— 图层面板：展示画布控件列表（z-order），可选中 / 删除 / 上下移动。
 * 列表顺序以设计模型（store.controls）为真理源：末尾 = 最上层，zone（页眉/页脚）固定最底。
 * 对齐 Vue 版 LayerPanel.vue。
 */
import { useMemo } from 'react'
import { Button } from 'antd'
import { useDesignerStore } from '../stores/designer'
import { CONTROL_TYPE_LABEL } from '@/design/canvas/controls'
import './layer-panel.css'

export default function LayerPanel() {
  const controls = useDesignerStore((s) => s.controls)
  const zones = useDesignerStore((s) => s.zones)
  const selectedIds = useDesignerStore((s) => s.selectedIds)

  /** zone 固定最底，正文控件按模型顺序倒序（最上层在前）——指纹 memo 保稳定引用 */
  const layers = useMemo(() => {
    const list: Array<{ id: string; type: string; name: string; isZone: boolean; index: number }> = []
    for (const z of zones) {
      list.push({ id: z.id, type: 'zone', name: z.zone === 'header' ? '页眉区域' : '页脚区域', isZone: true, index: -1 })
    }
    for (let i = controls.length - 1; i >= 0; i--) {
      const c = controls[i]!
      list.push({
        id: c.id,
        type: c.type,
        name: c.name ?? CONTROL_TYPE_LABEL[c.type] ?? c.type,
        isZone: false,
        index: i,
      })
    }
    return list
  }, [controls, zones])

  return (
    <div className="layer-panel">
      <div className="layer-panel-caption">图层（{layers.length} 项）</div>
      <div className="layer-panel-scroll">
        <div className="layer-panel-list">
          {layers.map((layer) => (
            <div
              key={layer.id}
              className={`layer-item${selectedIds.includes(layer.id) ? ' selected' : ''}`}
              onClick={() => useDesignerStore.getState().selectControl(layer.id)}
            >
              <span className="layer-name">{layer.name}</span>
              <div className="layer-actions">
                {!layer.isZone && (
                  <>
                    <Button
                      type="text"
                      size="small"
                      className="layer-btn"
                      disabled={layer.index >= controls.length - 1}
                      onClick={(e) => {
                        e.stopPropagation()
                        useDesignerStore.getState().moveControl(layer.id, 'up')
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      className="layer-btn"
                      disabled={layer.index <= 0}
                      onClick={(e) => {
                        e.stopPropagation()
                        useDesignerStore.getState().moveControl(layer.id, 'down')
                      }}
                    >
                      ↓
                    </Button>
                  </>
                )}
                <Button
                  type="text"
                  size="small"
                  className="layer-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    useDesignerStore.getState().removeControl(layer.id)
                  }}
                >
                  ✕
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
