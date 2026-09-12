/**
 * LeftPanel —— 左栏容器：组件库 / 数据源树 / 图层 三 tab（antd Segmented 风格 Tabs）
 * 对齐 Vue 版 LeftPanel.vue（NTabs type=segment）。
 */
import { Tabs } from 'antd'
import ControlLibrary from './ControlLibrary'
import DataSourceTree from './DataSourceTree'
import LayerPanel from './LayerPanel'
import { useUiStore } from '../stores/ui'
import './left-panel.css'

export default function LeftPanel() {
  const leftTab = useUiStore((s) => s.leftTab)
  const items = [
    { key: 'components', label: '组件', children: <ControlLibrary /> },
    { key: 'datasource', label: '数据源', children: <DataSourceTree /> },
    { key: 'layers', label: '图层', children: <LayerPanel /> },
  ]

  return (
    <div className="left-panel">
      <Tabs
        size="small"
        className="left-panel-tabs"
        activeKey={leftTab}
        onChange={(k) => useUiStore.getState().setLeftTab(k as typeof leftTab)}
        items={items}
      />
    </div>
  )
}
