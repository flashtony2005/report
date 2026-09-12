/**
 * DatabaseExplorer —— 数据库数据源探索器（P5.1b 接入）
 *
 * 对齐 Vue 版 `src/design/panels/DatabaseExplorer.vue`：
 *   1. 顶部下拉「单选」一个数据库（只能选其中一个）；
 *   2. 下方列出该库的表，点表展开其「列（字段）」；
 *   3. 展开某表即将其设为当前绑定表（仓库被构造，字段流入下方字段树）。
 *
 * 列节点**本身可拖**（与下方字段树同一口径 `items[].列名`）：提示语写着「点击表展开字段」，
 * 用户看到列名就会直接往画布拖 —— 早先树节点没实现 dragstart，拖了毫无反应（写不进
 * dataTransfer → 画布收不到 drop）。现在列节点自带 draggable，两条入口都能绑定。
 *
 * 主任铁律：连上本地打印客户端**不默认请求**，必须手动打开开关（dbEnabled）才开始拉取。
 * 文字色统一用语义化 CSS 变量（--brand-text-*），保证亮/暗主题下都清晰。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Empty, Select, Spin, Switch, Tree } from 'antd'
import type { TreeDataNode } from 'antd'
import { useDataSourceStore } from '../stores/dataSource'
import { usePrinterProbeStore } from '../stores/printerProbe'
import { ROWS_DEFAULT_LIMIT } from '@/core/print-client'
import { startFieldDrag } from '@/design/hooks/field-drag'
import { DB_ARRAY_PREFIX } from '@/repository/client-database-source'

const TEXT_1 = 'var(--brand-text-1, rgba(20, 20, 20, 0.92))'
const TEXT_2 = 'var(--brand-text-2, rgba(20, 20, 20, 0.65))'

/** 树节点 key 前缀：表 / 列（用于区分层级与取回表名） */
const TBL = 'tbl::'
const COL = 'col::'

/** 列节点额外携带字段路径（`items[].列名`），供 titleRender 直接写 dataTransfer */
interface DbTreeDataNode extends TreeDataNode {
  fieldPath?: string
}

/** 列标签：附主键 / 唯一键标记（兼容后端 key 原文 PRI|UNI 与旧版 primary 布尔） */
function columnLabel(c: { name: string; primary?: boolean; key?: string }): string {
  if (c.primary || c.key === 'PRI') return `${c.name} ·PK`
  if (c.key === 'UNI') return `${c.name} ·UNIQUE`
  return c.name
}

/** 把某表节点替换为「已加载子列」的副本（antd 异步子树要求整树引用变化） */
function withChildren(
  nodes: DbTreeDataNode[],
  parentKey: string,
  children: DbTreeDataNode[],
): DbTreeDataNode[] {
  return nodes.map((n) => (n.key === parentKey ? { ...n, children } : n))
}

export default function DatabaseExplorer() {
  const dbAvailable = useDataSourceStore((s) => s.dbAvailable)
  const dbEnabled = useDataSourceStore((s) => s.dbEnabled)
  const databases = useDataSourceStore((s) => s.dbDatabases)
  const tables = useDataSourceStore((s) => s.dbTables)
  const columns = useDataSourceStore((s) => s.dbColumns)
  const rows = useDataSourceStore((s) => s.dbRows)
  const database = useDataSourceStore((s) => s.dbSelection.database)
  const table = useDataSourceStore((s) => s.dbSelection.table)
  const loading = useDataSourceStore((s) => s.dbLoading)
  const error = useDataSourceStore((s) => s.dbError)

  const [treeData, setTreeData] = useState<DbTreeDataNode[]>([])

  // 进入数据库面板：若尚未探测到客户端，主动探活一次（仅连接检查，不取数据），
  // 以便「手动开启」开关在客户端实际在线时自动可用。
  useEffect(() => {
    if (!useDataSourceStore.getState().dbAvailable) {
      void usePrinterProbeStore.getState().probeIfStale()
    }
  }, [])

  // 表列表变化 → 重建树（切库时 dbTables 先清空再载入，子列随之清干净）
  useEffect(() => {
    setTreeData(tables.map((t) => ({ key: `${TBL}${t.name}`, title: t.name, isLeaf: false })))
  }, [tables])

  // 列到达 → 回填到当前表节点（antd Tree 的异步子树）
  useEffect(() => {
    if (!table || columns.length === 0) return
    const parentKey = `${TBL}${table}`
    setTreeData((prev) =>
      withChildren(
        prev,
        parentKey,
        columns.map((c) => ({
          key: `${COL}${table}::${c.name}`,
          title: columnLabel(c),
          isLeaf: true,
          // 与下方字段树同口径：明细数组前缀，表格里逐行取值
          fieldPath: `${DB_ARRAY_PREFIX}[].${c.name}`,
        })),
      ),
    )
  }, [columns, table])

  const dbOptions = useMemo(
    () => databases.map((d) => ({ label: d.label || d.name, value: d.name })),
    [databases],
  )

  /** 展开表 → 拉列并绑定为当前表 */
  const onLoadData = useCallback(async (node: TreeDataNode): Promise<void> => {
    const key = String(node.key)
    if (!key.startsWith(TBL)) return
    await useDataSourceStore.getState().selectTable(key.slice(TBL.length))
  }, [])

  /**
   * 显式着色：表名用主文字色、列名用次级文字色，亮/暗下都清晰（对齐 Vue render-label）。
   * 列节点额外挂 draggable —— 拖到画布即绑定 `items[].列名`，与下方字段树行为一致。
   */
  const titleRender = useCallback((node: TreeDataNode) => {
    const n = node as DbTreeDataNode
    const isCol = String(n.key).startsWith(COL)
    const text = String(n.title ?? '')
    if (isCol && n.fieldPath) {
      const path = n.fieldPath
      return (
        <span
          className="db-explorer-col"
          style={{ color: TEXT_2, fontSize: 12, cursor: 'grab' }}
          draggable
          title={`拖到画布绑定：${path}`}
          onDragStart={(e) => startFieldDrag(e.nativeEvent, path)}
        >
          {text}
        </span>
      )
    }
    return (
      <span style={{ color: TEXT_1, fontSize: 12 }}>{text}</span>
    )
  }, [])

  return (
    <div className="db-explorer">
      {/* 未连接客户端：提示（开关同时禁用） */}
      {!dbAvailable && (
        <Alert
          type="warning"
          showIcon={false}
          title={
            <div className="db-explorer-hint">
              未连接本地打印客户端，无法启用数据库数据源。
              <br />
              请在「设置 → 本地打印」连接本机/局域网客户端。
            </div>
          }
        />
      )}

      {/* 手动开启开关：始终显示（未连接时禁用并提示） */}
      <div className="db-explorer-switch">
        <div className="db-explorer-switch-label">
          启用数据库数据源
          <small className="db-explorer-dim">（需手动开启）</small>
        </div>
        <Switch
          size="small"
          checked={dbEnabled}
          disabled={!dbAvailable}
          onChange={(v) => void useDataSourceStore.getState().setDbEnabled(v)}
        />
      </div>

      {dbAvailable && dbEnabled && (
        <>
          <Spin spinning={loading && databases.length === 0}>
            {databases.length === 0 && !error ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据库" />
            ) : error ? (
              <Alert
                type="error"
                showIcon={false}
                title={<div className="db-explorer-hint">{error}</div>}
              />
            ) : (
              <>
                {/* Step1：单选一个数据库 */}
                <div className="db-explorer-field">
                  <div className="db-explorer-field-label">选择数据库</div>
                  <Select
                    size="small"
                    className="db-explorer-select"
                    value={database}
                    options={dbOptions}
                    placeholder="选择数据库"
                    disabled={databases.length === 0}
                    onChange={(v) => {
                      // 选库时把 engine 一并带下去（postgres 丢引擎会退回 sqlite 分支）
                      const picked = databases.find((d) => d.name === v)
                      void useDataSourceStore.getState().selectDatabase(v, picked?.engine)
                    }}
                  />
                </div>

                {/* Step2：表 → 展开列 */}
                {database && (
                  <div className="db-explorer-field">
                    <div className="db-explorer-field-label">数据表（点击表展开字段）</div>
                    <Spin spinning={loading && databases.length > 0}>
                      {tables.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该库暂无数据表" />
                      ) : (
                        <div className="db-explorer-tree-box">
                          <Tree
                            treeData={treeData}
                            loadData={onLoadData}
                            titleRender={titleRender}
                            blockNode
                            selectable={false}
                            expandAction="click"
                          />
                        </div>
                      )}
                    </Spin>
                  </div>
                )}
              </>
            )}
          </Spin>

          {/* 已绑定表的信息与操作 */}
          {database && table && (
            <div className="db-explorer-bound">
              <div className="db-explorer-bound-line">
                {columns.length} 个字段 · 已载入 {rows.length} 行（预览取前 {ROWS_DEFAULT_LIMIT} 行）
              </div>
              <div className="db-explorer-bound-actions">
                <Button
                  size="small"
                  type="link"
                  className="db-explorer-reload"
                  onClick={() => void useDataSourceStore.getState().reloadRows()}
                >
                  重新取数
                </Button>
                <span className="db-explorer-dim">拖字段到画布即可绑定</span>
              </div>
              <div className="db-explorer-dim">
                拖到表格列上 → <code>items[].字段名</code>（逐行取值）；拖到正文/页眉页脚的单值控件上 →
                自动用 <code>items[0].字段名</code>（取首条记录）；拖到空白处 → 新建绑定该字段的文本控件。
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
