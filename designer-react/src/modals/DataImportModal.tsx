/**
 * DataImportModal —— 顶部「导入数据」入口弹窗（React 版）
 *
 * 流程：选文件（CSV / JSON / Excel）→ 解析 → 预览（首行为标题、表头悬浮 × 直接删列、行可删）
 * → 确认后由 designer.importTable 在画布生成「内嵌数据表格」（自动居中、自动分页）。
 * 数据直接长进表格控件（control.data），与 dataSource 字段绑定解耦。
 *
 * parseDataFile / ParsedData / ImportColumn 经 @ alias 直用 Vue 端零框架实现。
 */
import { useState } from 'react'
import { Button, Checkbox, Modal, Spin } from 'antd'
import type { ImportColumn } from '@/types/data-import'
import { parseDataFile, type ParsedData } from '@/design/utils/data-import'
import { useDesignerStore } from '../stores/designer'
import { antdMessage } from '../ui-confirm'
import './data-import-modal.css'

/** 预览最多渲染的行数（其余行仍会完整导入，只是不全部渲染到 DOM） */
const PREVIEW_ROWS = 200

interface PreviewRow {
  index: number
  cells: string[]
}

/** 预览行推导：剔除已删行，最多 PREVIEW_ROWS 条（保留原始下标用于删行映射） */
function buildPreviewRows(
  parsed: ParsedData,
  columns: ImportColumn[],
  deletedRows: Set<number>,
): PreviewRow[] {
  const out: PreviewRow[] = []
  parsed.rows.forEach((row, i) => {
    if (deletedRows.has(i)) return
    if (out.length >= PREVIEW_ROWS) return
    out.push({ index: i, cells: columns.map((c) => String(row[c.key] ?? '')) })
  })
  return out
}

export function DataImportModalInner(props: {
  show: boolean
  onClose: () => void
}): React.ReactElement {
  const [parsed, setParsed] = useState<ParsedData | null>(null)
  const [columns, setColumns] = useState<ImportColumn[]>([])
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null)

  const sourceName = parsed?.sourceName ?? ''
  const previewRows = parsed ? buildPreviewRows(parsed, columns, deletedRows) : []
  const stats = parsed
    ? `${columns.length} 列 · ${parsed.rows.length - deletedRows.size} 行${
        deletedRows.size ? `（已删 ${deletedRows.size} 行）` : ''
      }`
    : ''
  const modalTitle = parsed ? `导入数据 · ${sourceName}` : '导入数据'

  function triggerFile(): void {
    fileInput?.click()
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const target = e.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = '' // 允许重复选同一文件
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const data = await parseDataFile(file)
      setParsed(data)
      setColumns(data.columns.map((c) => ({ ...c })))
      setDeletedRows(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setParsed(null)
    } finally {
      setLoading(false)
    }
  }

  /** 表头 × ：直接删除该列（不可恢复；要找回需重新选文件） */
  function removeColumn(key: string): void {
    setColumns((prev) => prev.filter((c) => c.key !== key))
  }

  function toggleRow(index: number, keep: boolean): void {
    setDeletedRows((prev) => {
      const next = new Set(prev)
      if (keep) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function setAllRows(keep: boolean): void {
    setDeletedRows(keep ? new Set() : new Set(parsed ? parsed.rows.map((_, i) => i) : []))
  }

  function confirmImport(): void {
    if (!parsed) return
    const cols = columns
    if (cols.length === 0) {
      antdMessage.error('至少保留一列')
      return
    }
    const records = parsed.rows
      .map((row, i) => ({ row, i }))
      .filter(({ i }) => !deletedRows.has(i))
      .map(({ row }) => {
        const o: Record<string, unknown> = {}
        for (const c of cols) o[c.key] = row[c.key] ?? ''
        return o
      })
    useDesignerStore.getState().importTable({
      columns: cols.map((c) => ({ key: c.key, title: c.title })),
      records,
      sourceName,
    })
    antdMessage.success(`已导入 ${records.length} 行 / ${cols.length} 列，自动生成居中的分页表格`)
    close()
  }

  function close(): void {
    props.onClose()
    setParsed(null)
    setColumns([])
    setDeletedRows(new Set())
    setError('')
  }

  return (
    <Modal
      title={modalTitle}
      open={props.show}
      onCancel={close}
      mask={{ closable: false }}
      width={880}
      style={{ maxWidth: '94vw' }}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button size="small" onClick={close}>
            取消
          </Button>
          {parsed ? (
            <Button size="small" type="primary" onClick={confirmImport}>
              确认导入
            </Button>
          ) : null}
        </div>
      }
    >
      {!parsed ? (
        <div className="dim-select">
          <Button type="primary" size="large" onClick={triggerFile}>
            选择文件（CSV / JSON / Excel）
          </Button>
          <div className="dim-hint">支持 .csv / .json / .xlsx / .xls，第一行作为列标题，表名取自文件名</div>
          {loading ? <Spin /> : null}
          {error ? <div className="dim-error">{error}</div> : null}
          <input
            ref={setFileInput}
            type="file"
            accept=".csv,.json,.xlsx,.xls"
            style={{ display: 'none' }}
            onChange={(e) => void onFileChange(e)}
          />
        </div>
      ) : (
        <div className="dim-body">
          {/* 顶部信息条 */}
          <div className="dim-info-bar">
            <div className="dim-info-left">
              <span className="dim-source-name">{sourceName}</span>
              <span className="dim-stats">{stats}</span>
            </div>
            <Button size="small" onClick={triggerFile}>
              重新选择
            </Button>
          </div>

          {/* 数据预览：固定显示区，上下左右滚动；表头悬浮 × 直接删列 */}
          <div className="dim-preview-block">
            <div className="dim-preview-head">
              <span className="dim-hint">
                数据预览（表头悬浮显示 × 可删除该列；勾选行可删除；仅渲染前 {PREVIEW_ROWS} 行，其余行仍会完整导入）
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="small" onClick={() => setAllRows(true)}>
                  保留全部行
                </Button>
                <Button size="small" onClick={() => setAllRows(false)}>
                  删除全部行
                </Button>
              </div>
            </div>
            <div className="preview-scroll">
              <table className="import-preview-table">
                <thead>
                  <tr>
                    <th className="row-check-col" />
                    {columns.map((c) => (
                      <th key={c.key} className="col-th">
                        <input
                          className="th-title-input"
                          value={c.title}
                          title={c.title}
                          onChange={(e) =>
                            setColumns((prev) =>
                              prev.map((p) =>
                                p.key === c.key ? { ...p, title: e.target.value } : p,
                              ),
                            )
                          }
                        />
                        <button
                          type="button"
                          className="th-del"
                          title="删除该列"
                          onClick={() => removeColumn(c.key)}
                        >
                          ×
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => (
                    <tr key={row.index}>
                      <td className="row-check-col">
                        <Checkbox
                          checked={!deletedRows.has(row.index)}
                          onChange={(e) => toggleRow(row.index, e.target.checked)}
                        />
                      </td>
                      {row.cells.map((cell, ci) => (
                        <td key={ci} title={cell}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {previewRows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length + 1} className="dim-empty">
                        没有可显示的行（可能已全部删除）
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {/* 隐藏文件入口在预览态也保留（「重新选择」用） */}
            <input
              ref={setFileInput}
              type="file"
              accept=".csv,.json,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={(e) => void onFileChange(e)}
            />
          </div>
        </div>
      )}
    </Modal>
  )
}
