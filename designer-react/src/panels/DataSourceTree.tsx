/**
 * DataSourceTree —— 数据源三选一 + 字段树
 * 对齐 Vue 版：顶部三选一切 provider（示例数据/ERP/数据库）、搜索过滤、字段拖拽绑定。
 * 数据库模式顶部接入 DatabaseExplorer（P5.1b）：选库 → 点表展开列 → 下方字段树绑定。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Radio, Select, Spin, Tooltip } from 'antd'
import { useDataSourceStore, selectFieldTree } from '../stores/dataSource'
import type { DataSourceKind } from '@/config/data-source'
import { fieldTreeEmptyHint } from '@/config/data-source'
import { isBackendConfigured } from '@/config/backend'
import { startFieldDrag } from '@/design/hooks/field-drag'
import DatabaseExplorer from './DatabaseExplorer'
import './data-source-tree.css'

const TYPE_LABEL: Record<string, string> = {
  number: 'N',
  date: 'D',
  boolean: 'B',
  image: 'I',
  string: 'S',
}

const TYPE_CLASS: Record<string, string> = {
  number: 'type-number',
  date: 'type-date',
  image: 'type-image',
}

export default function DataSourceTree() {
  const kind = useDataSourceStore((s) => s.kind)
  const sources = useDataSourceStore((s) => s.sources)
  const activeSourceId = useDataSourceStore((s) => s.activeSourceId)
  const loading = useDataSourceStore((s) => s.loading)
  // 空态文案需要知道「数据库模式下卡在哪一步」（未启用 / 未选表 / 表无字段）
  const dbEnabled = useDataSourceStore((s) => s.dbEnabled)
  const dbTable = useDataSourceStore((s) => s.dbSelection.table)
  // selectFieldTree 带指纹 memo（P3.3 坑），直接 selector 调用是稳定引用
  const fieldTree = useDataSourceStore(selectFieldTree)
  const [keyword, setKeyword] = useState('')

  // 对齐 Vue 版 DataSourceTree.vue 的 onMounted：挂载即按当前 provider 载入字段。
  // 数据库模式 + 已手动开启 + 客户端在线时，这里会触发载入库列表。
  useEffect(() => {
    void useDataSourceStore.getState().init()
  }, [])

  const filteredGroups = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return fieldTree
    return fieldTree
      .map((t) => ({
        table: t.table,
        fields: t.fields.filter(
          (f) => f.label.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw),
        ),
      }))
      .filter((t) => t.fields.length > 0)
  }, [fieldTree, keyword])

  const onSelectProvider = (v: DataSourceKind): void => {
    void useDataSourceStore.getState().selectProvider(v)
  }

  /**
   * 空态文案：把「为什么没有字段」说清楚（共享函数，与 Vue 端同一份措辞）。
   * 数据库模式最常见的一句抱怨是「不能拖字段到画布」——实际是卡在开关/选库/选表某一步，
   * 光显示「暂无字段」等于没说。
   */
  const emptyHint = fieldTreeEmptyHint({ kind, dbEnabled, dbTable, keyword })

  return (
    <div className="ds-tree">
      {/* 三选一（固定） */}
      <div className="ds-tree-provider">
        <div className="ds-tree-caption">数据源类型</div>
        <Radio.Group
          size="small"
          value={kind}
          onChange={(e) => onSelectProvider(e.target.value as DataSourceKind)}
        >
          <Radio.Button value="sample">示例数据</Radio.Button>
          <Radio.Button value="erp" disabled={!isBackendConfigured}>
            ERP
          </Radio.Button>
          <Radio.Button value="database">数据库</Radio.Button>
        </Radio.Group>
      </div>

      {/* 搜索 + 刷新（固定工具条） */}
      <div className="ds-tree-toolbar">
        <Input size="small" placeholder="搜索字段" allowClear value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <Tooltip title={kind === 'database' ? '重新取数' : '刷新字段'}>
          <Button size="small" type="text" onClick={() => void useDataSourceStore.getState().refreshFields()}>
            ⟳
          </Button>
        </Tooltip>
      </div>

      {/* 可滚动内容区 */}
      <div className="ds-tree-scroll">
        {/* 数据库：探索器（选库 → 点表展开列 → 字段流入下方字段树） */}
        {kind === 'database' && <DatabaseExplorer />}

        {/* 非数据库：数据源选择 */}
        {kind !== 'database' && (
          <div className="ds-tree-source">
            <div className="ds-tree-caption">数据源</div>
            <Select
              size="small"
              value={activeSourceId}
              options={sources.map((s) => ({ label: s.name, value: s.id }))}
              onChange={(v) => useDataSourceStore.getState().selectSource(v)}
            />
          </div>
        )}

        <Spin spinning={loading}>
          <div className="ds-tree-fields">
            {filteredGroups.map((group) => (
              <div key={group.table.id} className="ds-tree-group">
                <div className="ds-tree-group-name">
                  ▦ {group.table.name}
                  {group.table.isArray ? <span className='ds-tree-array'>[]</span> : null}
                </div>
                {group.fields.map((field) => (
                  <div
                    key={field.path}
                    className="field-item"
                    draggable
                    title={`拖到画布绑定：${field.path}`}
                    onDragStart={(e) => startFieldDrag(e.nativeEvent, field.path)}
                  >
                    <span className="field-label">
                      {field.label}
                      {field.custom ? <span className="field-custom">自定义</span> : null}
                    </span>
                    <span className={`field-type ${TYPE_CLASS[field.type] ?? ''}`}>
                      {TYPE_LABEL[field.type] ?? 'S'}
                    </span>
                    <span className="field-path">{field.path}</span>
                  </div>
                ))}
              </div>
            ))}
            {filteredGroups.length === 0 && <div className="ds-tree-empty">{emptyHint}</div>}
          </div>
        </Spin>
      </div>
    </div>
  )
}
