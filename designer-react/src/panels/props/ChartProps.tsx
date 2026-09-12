/**
 * ChartProps —— 图表控件属性面板（React 版，P4.2）
 *
 * 与 Vue 版交互一致：图表类型、标题、类目（多行文本同步对齐序列长度）、
 * 序列增删改（名称/颜色/数值）、外观开关（轴/网格/图例/数据标签/对齐/平滑/面积/环形）。
 * 数据编辑纯函数全部来自共享 chart-props-logic（两端同源）。
 */
import { Button, ColorPicker, Input, Select, Switch } from 'antd'
import { useDesignerStore } from '../../stores/designer'
import { selectSelectedControl } from '../../stores/selectors'
import type { ChartControl } from '@/types/control'
import {
  addSeriesAt,
  alignSeriesData,
  categoriesPatch,
  categoriesText,
  removeSeriesAt,
  seriesColorOf,
  seriesDataText,
  setSeriesColorAt,
  setSeriesNameAt,
  showLegendDefault,
} from '@/design/panels/props/shared/chart-props-logic'

export default function ChartProps() {
  const control = useDesignerStore(selectSelectedControl) as ChartControl | undefined
  if (!control || control.type !== 'chart') return null

  const patch = (p: Record<string, unknown>): void => {
    useDesignerStore.getState().updateControl(control.id, p)
  }
  const patchOption = (key: string, value: unknown): void => {
    patch({ options: { ...control.options, [key]: value } })
  }

  const kind = control.kind ?? 'bar'
  const isLine = kind === 'line'
  const isPie = kind === 'pie'
  const series = control.series ?? []
  const cats = control.categories ?? []
  const opts = control.options ?? {}

  return (
    <div className="props-section">
      <div className="props-title">图表类型</div>
      <div className="props-row">
        <span className="props-label">类型</span>
        <Select
          size="small"
          style={{ flex: 1 }}
          value={kind}
          options={[
            { label: '条形图', value: 'bar' },
            { label: '折线图', value: 'line' },
            { label: '饼图', value: 'pie' },
          ]}
          onChange={(v) => patch({ kind: v })}
        />
      </div>

      <div className="props-row">
        <span className="props-label">标题</span>
        <Input
          size="small"
          value={opts.title ?? ''}
          placeholder="图表标题"
          onChange={(e) => patchOption('title', e.target.value || undefined)}
        />
      </div>

      <div className="props-title">类目</div>
      <div className="props-row">
        <span className="props-label">类目</span>
        <Input.TextArea
          size="small"
          autoSize={{ minRows: 2, maxRows: 6 }}
          value={categoriesText(control)}
          placeholder="每行一个类目（x 轴标签 / 扇区名）"
          onChange={(e) => patch(categoriesPatch(control, e.target.value))}
        />
      </div>

      <div className="props-title chart-props-series-title">
        数据序列
        <Button size="small" type="primary" ghost onClick={() => patch({ series: addSeriesAt(series, cats) })}>
          + 序列
        </Button>
      </div>
      {series.map((s, i) => (
        <div key={i} className="chart-series">
          <div className="props-row">
            <span className="props-label">名称</span>
            <Input
              size="small"
              value={s.name ?? ''}
              onChange={(e) => patch({ series: setSeriesNameAt(series, i, e.target.value) })}
            />
            <ColorPicker
              size="small"
              disabledAlpha
              value={seriesColorOf(series, i)}
              onChange={(c) => patch({ series: setSeriesColorAt(series, i, c.toHexString()) })}
            />
            {series.length > 1 && (
              <Button size="small" type="text" danger onClick={() => patch({ series: removeSeriesAt(series, i) })}>
                删
              </Button>
            )}
          </div>
          <div className="props-row">
            <span className="props-label">数值</span>
            <Input.TextArea
              size="small"
              autoSize={{ minRows: 2, maxRows: 6 }}
              value={seriesDataText(series, i)}
              placeholder={isPie ? '每行一个扇区数值' : '每行一个数值（与类目对应）'}
              onChange={(e) => patch({ series: alignSeriesData(series, i, e.target.value, cats) })}
            />
          </div>
        </div>
      ))}

      <div className="props-title">外观</div>
      {!isPie && (
        <div className="props-row">
          <span className="props-label">坐标轴</span>
          <Switch size="small" checked={opts.showAxis ?? true} onChange={(v) => patchOption('showAxis', v)} />
        </div>
      )}
      {!isPie && (
        <div className="props-row">
          <span className="props-label">网格线</span>
          <Switch size="small" checked={opts.showGrid ?? true} onChange={(v) => patchOption('showGrid', v)} />
        </div>
      )}
      <div className="props-row">
        <span className="props-label">图例</span>
        <Switch
          size="small"
          checked={showLegendDefault(opts, series.length)}
          onChange={(v) => patchOption('showLegend', v)}
        />
      </div>
      <div className="props-row">
        <span className="props-label">数据标签</span>
        <Switch size="small" checked={opts.valueLabel ?? false} onChange={(v) => patchOption('valueLabel', v)} />
      </div>
      <div className="props-row">
        <span className="props-label">图例对齐</span>
        <Select
          size="small"
          style={{ flex: 1 }}
          value={opts.labelAlign ?? 'center'}
          options={[
            { label: '左对齐', value: 'left' },
            { label: '居中', value: 'center' },
            { label: '右对齐', value: 'right' },
          ]}
          onChange={(v) => patchOption('labelAlign', v)}
        />
      </div>
      {isLine && (
        <div className="props-row">
          <span className="props-label">平滑曲线</span>
          <Switch size="small" checked={opts.smooth ?? false} onChange={(v) => patchOption('smooth', v)} />
        </div>
      )}
      {isLine && (
        <div className="props-row">
          <span className="props-label">面积填充</span>
          <Switch size="small" checked={opts.area ?? false} onChange={(v) => patchOption('area', v)} />
        </div>
      )}
      {isPie && (
        <div className="props-row">
          <span className="props-label">环形</span>
          <Switch size="small" checked={opts.donut ?? false} onChange={(v) => patchOption('donut', v)} />
        </div>
      )}
    </div>
  )
}
