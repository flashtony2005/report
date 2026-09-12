/**
 * VariableModal —— 变量（字段绑定）选择弹窗（React 版）
 * 行为与 Vue 版一致：按表分组展示字段（名称/路径/类型标签/示例值），搜索过滤，
 * 点击选中 → 底部预览绑定路径 → 确定回写。
 * 示例值提取与类型元信息来自共享 sample-value（两端同源）。
 */
import { Button, Empty, Input, Modal } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { FieldDef } from '@/types/datasource'
import { sampleOfField, typeMeta } from '@/design/panels/props/shared/sample-value'
import { selectFieldTree, selectPreviewData, useDataSourceStore } from '../../stores/dataSource'
import './variable-modal.css'

interface Props {
  show: boolean
  /** 当前绑定路径（用于弹窗内高亮） */
  binding?: string
  onCancel: () => void
  onConfirm: (value: string) => void
}

export default function VariableModal({ show, binding, onCancel, onConfirm }: Props) {
  const [search, setSearch] = useState('')
  const [selectedPath, setSelectedPath] = useState('')

  const groups = useDataSourceStore(selectFieldTree)
  const totalCount = useDataSourceStore((s) =>
    selectFieldTree(s).reduce((n, g) => n + g.fields.length, 0),
  )
  const loading = useDataSourceStore((s) => s.loading)
  const previewData = useDataSourceStore(selectPreviewData)

  /* 打开时复位搜索、回显当前绑定，并确保数据源已初始化（弹窗独立可用） */
  useEffect(() => {
    if (show) {
      setSearch('')
      setSelectedPath(binding ?? '')
      void useDataSourceStore.getState().init()
    }
  }, [show, binding])

  const filteredGroups = useMemo(() => {
    const kw = search.trim().toLowerCase()
    if (!kw) return groups
    return groups
      .map((g) => ({
        ...g,
        fields: g.fields.filter(
          (f: FieldDef) =>
            f.label.toLowerCase().includes(kw) ||
            f.path.toLowerCase().includes(kw) ||
            typeMeta(f).label.includes(kw) ||
            String(sampleOfField(f, previewData)).toLowerCase().includes(kw),
        ),
      }))
      .filter((g) => g.fields.length > 0)
  }, [groups, search, previewData])

  return (
    <Modal
      open={show}
      title="选择字段"
      width={640}
      // 同 ExpressionModal：antd v6 默认内边距在 container 上，先清零
      styles={{ body: { padding: '12px 0 0' }, container: { padding: 0 } }}
      onCancel={onCancel}
      footer={
        <div className="var-footer">
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="small"
            type="primary"
            disabled={!selectedPath}
            onClick={() => onConfirm(selectedPath)}
          >
            确定
          </Button>
        </div>
      }
    >
      <div className="var-modal">
        <div className="var-top">
          <Input
            size="small"
            value={search}
            placeholder="搜索字段名 / 路径 / 类型 / 示例值"
            allowClear
            style={{ flex: '1 1 auto' }}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="var-count">共 {totalCount} 个字段</span>
        </div>

        <div className="var-list">
          {filteredGroups.map((g) => (
            <div key={g.table.id} className="var-group">
              <div className="var-group-label">{g.table.name}</div>
              {g.fields.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`var-fn${selectedPath === f.path ? ' var-fn--active' : ''}`}
                  onClick={() => setSelectedPath(f.path)}
                >
                  <div className="var-fn-head">
                    <span className="var-fn-name">{f.label}</span>
                    <span className="var-fn-type" style={{ color: typeMeta(f).color }}>
                      {typeMeta(f).label}
                    </span>
                    <code className="var-fn-path">{f.path}</code>
                  </div>
                  <div className="var-fn-sample">
                    示例：{sampleOfField(f, previewData)}
                  </div>
                </button>
              ))}
            </div>
          ))}
          {filteredGroups.length === 0 && (
            <Empty
              className="var-empty"
              description={loading ? '字段加载中…' : search ? '无匹配字段' : '暂无数据源字段'}
            />
          )}
        </div>

        <div className="var-foot">
          <span className="var-foot-label">已选</span>
          <code className="var-foot-path">{selectedPath ? `{{${selectedPath}}}` : '（未选择）'}</code>
        </div>
      </div>
    </Modal>
  )
}
