/**
 * ExportDialog —— 四格式导出（PDF / JPG / SVG / HTML）
 *
 * 与预览共用同一份数据合成逻辑（buildTemplate + selectPreviewData），
 * 导出引擎统一以 render() 的 HTML 产物为真相来源，保证「预览 = 导出 = 打印」。
 * 导出引擎 `@/core/export-engine` 经 alias 直用 Vue 端实现（零复制）。
 *
 * 导出语义：
 * - PDF：单文件多页
 * - JPG：每页一个文件（多页时 name-1.jpg / name-2.jpg ...）
 * - SVG：单文件多页纵向堆叠（矢量）
 * - HTML：单文件自包含（矢量，默认内联字体）
 */
import { useState } from 'react'
import { Button, Input, InputNumber, Modal, Radio, Space, message } from 'antd'
import { exportDocument, downloadBlob, type ExportFormat } from '@/core/export-engine'
import { useDesignerStore } from '../stores/designer'
import { useDataSourceStore, selectPreviewData } from '../stores/dataSource'
import { useUiStore } from '../stores/ui'
import './export-dialog.css'

const FORMAT_OPTIONS: Array<{ label: string; value: ExportFormat }> = [
  { label: 'PDF（单文件 · 多页）', value: 'pdf' },
  { label: 'JPG（每页一张）', value: 'jpg' },
  { label: 'SVG（矢量 · 单文件多页）', value: 'svg' },
  { label: 'HTML（矢量 · 自包含单文件）', value: 'html' },
]

export function ExportDialog(): React.JSX.Element {
  const open = useUiStore((s) => s.exportOpen)
  const [format, setFormat] = useState<ExportFormat>('pdf')
  const [rowCount, setRowCount] = useState(30)
  const [filename, setFilename] = useState('销售出库单')
  const [exporting, setExporting] = useState(false)

  function close(): void {
    useUiStore.getState().setExportOpen(false)
  }

  async function onExport(): Promise<void> {
    if (exporting) return
    setExporting(true)
    try {
      const s = useDesignerStore.getState()
      const template = s.buildTemplate()
      // 与预览共用同一份数据：数据库模式用真实行，sample/ERP 用明细行数合成
      useDataSourceStore.getState().setPreviewRowCount(rowCount)
      const data = selectPreviewData(useDataSourceStore.getState()) as Record<string, unknown>
      const res = await exportDocument(
        {
          template,
          data,
          output: {
            pageDecoration: {
              backgroundColor: s.pageSetup.backgroundColor ?? '#ffffff',
              watermark: s.pageSetup.watermark,
            },
          },
        },
        format,
        { filename: filename.trim() || 'openprint-document' },
      )
      res.blobs.forEach((b, i) => downloadBlob(b, res.filenames[i]!))
      void message.success(`已导出 ${res.blobs.length} 个文件（${res.filenames[0]} 等）`)
      close()
    } catch (e) {
      void message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Modal
      title="导出文档"
      open={open}
      onCancel={close}
      mask={{ closable: !exporting }}
      width={460}
      footer={
        <Space>
          <Button size="small" disabled={exporting} onClick={close}>
            取消
          </Button>
          <Button size="small" type="primary" loading={exporting} onClick={() => void onExport()}>
            导出
          </Button>
        </Space>
      }
    >
      <div className="export-dialog-body">
        <div className="export-row">
          <span className="export-row-label">格式</span>
          <Radio.Group
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
            data-testid="export-format-group"
          >
            <Space direction="vertical">
              {FORMAT_OPTIONS.map((o) => (
                <Radio key={o.value} value={o.value}>
                  {o.label}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </div>

        <div className="export-row">
          <span className="export-row-label">明细行数</span>
          <InputNumber
            size="small"
            min={0}
            max={500}
            step={10}
            value={rowCount}
            onChange={(v) => setRowCount(typeof v === 'number' ? v : 0)}
            style={{ width: 160 }}
            data-testid="export-row-count"
          />
          <span className="export-hint">调大可验证跨页导出</span>
        </div>

        <div className="export-row">
          <span className="export-row-label">文件名</span>
          <Input
            size="small"
            value={filename}
            placeholder="openprint-document"
            onChange={(e) => setFilename(e.target.value)}
            data-testid="export-filename"
          />
        </div>

        <p className="export-hint-block">
          JPG 多页时每页导出为独立文件（<code>name-1.jpg</code> …）；PDF / SVG / HTML
          为单文件多页。HTML 为矢量、字体已内联，用浏览器打开即可查看/打印。
        </p>
      </div>
    </Modal>
  )
}
