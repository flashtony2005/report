/**
 * TemplateModal —— 模板管理器（与 Vue 版 TemplateModal.vue 行为对齐）
 *
 * 列表 / 打开 / 复制 / 删除 / 新建。直接走 designer store 的 repository（本地或云端同接口）。
 * 权限（editable/deletable）由 repository 决定：本地恒 true，云端来自后端 permissions。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Empty, Modal, Popconfirm, Spin, Tag, message } from 'antd'
import type { TemplateSummary } from '@/repository/types'
import { useDesignerStore, getTemplateRepository } from '../stores/designer'
import { confirmDialog } from '../ui-confirm'
import './template-modal.css'

export function TemplateModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [items, setItems] = useState<TemplateSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setItems(await getTemplateRepository().list())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  /** 按 updatedAt 倒序（最近更新在前） */
  const sortedItems = [...items].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

  async function openTemplate(rec: TemplateSummary): Promise<void> {
    setBusyId(rec.id)
    try {
      const full = await getTemplateRepository().get(rec.id)
      if (!full) {
        void message.error('模板不存在或已删除')
        void refresh()
        return
      }
      useDesignerStore.getState().loadTemplate(full)
      void message.success(`已打开：${full.name}`)
      onClose()
    } catch (e) {
      void message.error(`打开失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  async function copyTemplate(rec: TemplateSummary): Promise<void> {
    setBusyId(rec.id)
    try {
      const full = await getTemplateRepository().get(rec.id)
      if (!full) {
        void message.error('模板不存在或已删除')
        void refresh()
        return
      }
      // 加载为当前画布，再另存为（清空 id → create 新记录）
      useDesignerStore.getState().loadTemplate(full)
      await useDesignerStore.getState().saveTemplateAs(`${full.name} 副本`)
      void message.success(`已复制为：${full.name} 副本`)
      void refresh()
    } catch (e) {
      void message.error(`复制失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  async function deleteTemplate(rec: TemplateSummary): Promise<void> {
    setBusyId(rec.id)
    try {
      await getTemplateRepository().remove(rec.id)
      const s = useDesignerStore.getState()
      if (s.currentTemplateId === rec.id) s.newBlankTemplate()
      void message.success(`已删除：${rec.name}`)
      void refresh()
    } catch (e) {
      void message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  async function createNew(): Promise<void> {
    const s = useDesignerStore.getState()
    if (s.dirty && !(await confirmDialog('当前模板有未保存改动，新建将清空画布。确定继续？'))) return
    useDesignerStore.getState().newBlankTemplate()
    void message.success('已新建空白模板')
    onClose()
  }

  return (
    <Modal
      title="模板管理"
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      data-testid="template-modal"
    >
      <div className="template-modal-head">
        <Button size="small" type="primary" onClick={() => void createNew()}>
          新建空白模板
        </Button>
      </div>

      <Spin spinning={loading}>
        {error && <div className="template-modal-error">加载失败：{error}</div>}

        {!loading && sortedItems.length === 0 ? (
          <Empty description="暂无模板" className="template-modal-empty">
            <Button size="small" onClick={() => void createNew()}>
              新建空白模板
            </Button>
          </Empty>
        ) : (
          <div className="template-modal-list">
            {sortedItems.map((rec) => (
              <div key={rec.id} className="template-row">
                <div className="template-row-info">
                  <div className="template-row-name">
                    <span className="template-name-text">{rec.name}</span>
                    {!rec.editable && <Tag color="warning">只读</Tag>}
                  </div>
                  <div className="template-row-meta">
                    {rec.id}
                    {rec.updatedAt && <span className="template-row-updated">更新于 {rec.updatedAt}</span>}
                  </div>
                </div>

                <div className="template-row-actions">
                  <Button size="small" disabled={busyId !== null} onClick={() => void openTemplate(rec)}>
                    打开
                  </Button>
                  <Button
                    size="small"
                    disabled={busyId !== null || !rec.editable}
                    onClick={() => void copyTemplate(rec)}
                  >
                    复制
                  </Button>
                  <Popconfirm
                    title={`确定删除「${rec.name}」？此操作不可恢复。`}
                    okText="删除"
                    cancelText="取消"
                    disabled={!rec.deletable}
                    onConfirm={() => void deleteTemplate(rec)}
                  >
                    <Button size="small" danger disabled={busyId !== null || !rec.deletable}>
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
        )}
      </Spin>
    </Modal>
  )
}
