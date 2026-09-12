/**
 * LabelGridProps —— 标签网格属性面板（React 版，P4.2）
 *
 * 一张纸平铺 N 张标签卡的**纯布局控制台**：网格线开关与线型、数据源数组路径、
 * 列数/行数/卡片尺寸/间距（改后容器宽高跟随重算，所见即所得）、
 * 卡片贴合内容、首卡元素管理。
 * 几何计算全部来自共享 label-grid-props-logic（两端同源）。
 */
import { Button, Input, InputNumber, Select, Switch, Tooltip } from 'antd'
import type { LabelGridControl } from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { selectSelectedControl } from '../../stores/selectors'
import { CONTROL_TYPE_LABEL } from '@/design/canvas/controls'
import { resolveGridGeometry } from '@/core/layout-engine/label-grid'
import {
  contentWidthOf,
  fitCardPatch,
  geometryPatch,
  maxColumnsOf,
  rowsHeightPatch,
  visibleRowsOf,
} from '@/design/panels/props/shared/label-grid-props-logic'

export default function LabelGridProps() {
  const control = useDesignerStore(selectSelectedControl) as LabelGridControl | undefined
  const pageSetup = useDesignerStore((s) => s.pageSetup)
  if (!control || control.type !== 'labelgrid') return null

  const geo = resolveGridGeometry(control)
  const patch = (p: Partial<LabelGridControl>): void => {
    useDesignerStore.getState().updateControl(control.id, p)
  }

  const contentWidth = contentWidthOf(pageSetup)
  const maxColumns = maxColumnsOf(contentWidth, geo)
  const visibleRows = visibleRowsOf(control, geo)

  const patchGeometry = (p: Partial<LabelGridControl>): void => {
    patch(geometryPatch(control, p, visibleRows))
  }

  const childName = (ch: { type: string; name?: string }): string =>
    ch.name ?? CONTROL_TYPE_LABEL[ch.type] ?? ch.type

  return (
    <div className="props-section">
      <div className="props-title">标签网格</div>

      <div className="props-row">
        <span className="props-label">显示网格线</span>
        <Switch
          size="small"
          checked={control.showLines ?? true}
          onChange={(v) => patch({ showLines: v })}
        />
      </div>
      <div className="props-row">
        <span className="props-label">线型</span>
        <Select
          size="small"
          style={{ width: 96 }}
          disabled={!(control.showLines ?? true)}
          value={control.lineStyle ?? 'solid'}
          options={[
            { label: '实线', value: 'solid' },
            { label: '虚线', value: 'dashed' },
          ]}
          onChange={(v) => patch({ lineStyle: v })}
        />
      </div>
      <div className="props-row" style={{ marginTop: 4 }}>
        <span className="props-label">数据源</span>
        <Input
          size="small"
          style={{ width: 148 }}
          value={control.dataSource ?? ''}
          placeholder="数组路径，如 items"
          onChange={(e) => patch({ dataSource: e.target.value.trim() || undefined })}
        />
      </div>
      <div className="props-tip" style={{ lineHeight: 1.5 }}>
        留空：纯布局平铺（每卡相同）。填数组路径（如 <code>items</code>）：卡片数跟随数据条数，
        每卡注入 <code>row</code> / <code>rowIndex</code>，卡内控件绑定{' '}
        <code>{'{{row.字段}}'}</code> 逐卡不同（流水号 / 条码 / 二维码）。
      </div>

      <div className="props-row" style={{ marginTop: 6 }}>
        <span className="props-label">列数</span>
        <InputNumber
          size="small"
          style={{ width: 96 }}
          value={control.columns ?? 3}
          min={1}
          max={50}
          step={1}
          onChange={(v) => patchGeometry({ columns: v ?? 1 })}
        />
        <Tooltip title={`按卡片宽度把列数拉到内容区上限（${maxColumns} 列）`}>
          <Button size="small" type="text" style={{ marginLeft: 6 }} onClick={() => patchGeometry({ columns: maxColumns })}>
            铺满
          </Button>
        </Tooltip>
      </div>

      <div className="props-row">
        <span className="props-label">行数</span>
        <InputNumber
          size="small"
          style={{ width: 96 }}
          value={visibleRows}
          min={1}
          max={200}
          step={1}
          onChange={(v) => patch(rowsHeightPatch(geo, v ?? 1))}
        />
        <span className="props-tip" style={{ marginLeft: 6 }}>多行自动跨页平铺</span>
      </div>

      <div className="grid grid-cols-2 gap-2" style={{ marginTop: 4 }}>
        <div className="props-row">
          <span className="props-label">卡宽</span>
          <InputNumber
            size="small"
            value={geo.cardWidth}
            min={1}
            step={0.5}
            precision={1}
            onChange={(v) => patchGeometry({ cardWidth: v ?? 1 })}
          />
        </div>
        <div className="props-row">
          <span className="props-label">卡高</span>
          <InputNumber
            size="small"
            value={geo.cardHeight}
            min={1}
            step={0.5}
            precision={1}
            onChange={(v) => patchGeometry({ cardHeight: v ?? 1 })}
          />
        </div>
        <div className="props-row">
          <span className="props-label">横间距</span>
          <InputNumber
            size="small"
            value={geo.gapX}
            min={0}
            step={0.5}
            precision={1}
            onChange={(v) => patchGeometry({ gapX: v ?? 0 })}
          />
        </div>
        <div className="props-row">
          <span className="props-label">纵间距</span>
          <InputNumber
            size="small"
            value={geo.gapY}
            min={0}
            step={0.5}
            precision={1}
            onChange={(v) => patchGeometry({ gapY: v ?? 0 })}
          />
        </div>
      </div>

      <div className="props-row" style={{ marginTop: 8, gap: 6 }}>
        <Button size="small" onClick={() => patch(fitCardPatch(control, visibleRows))}>
          卡片贴合内容
        </Button>
      </div>

      <div className="props-tip">
        每页 {geo.columns * visibleRows} 张 · 卡片模板含 {control.children?.length ?? 0} 个元素
      </div>

      {(control.children?.length ?? 0) > 0 && (
        <div className="props-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4, marginTop: 8 }}>
          <div className="props-label">
            首卡元素（{control.children!.length}）· 拖入新组件即复制到每卡，画布上可直接选中/拖动
          </div>
          {control.children!.map((ch) => (
            <div key={ch.id} className="lg-child-item">
              <span className="truncate text-12px" style={{ flex: 1 }}>
                {childName(ch)}
              </span>
              <Button
                type="text"
                size="small"
                className="lg-child-del"
                onClick={(e) => {
                  e.stopPropagation()
                  useDesignerStore.getState().removeLabelGridChild(control.id, ch.id)
                }}
              >
                ✕
              </Button>
            </div>
          ))}
          <Button
            size="small"
            danger
            ghost
            style={{ alignSelf: 'flex-start' }}
            onClick={() => useDesignerStore.getState().clearLabelGridChildren(control.id)}
          >
            清空首卡
          </Button>
        </div>
      )}
    </div>
  )
}
