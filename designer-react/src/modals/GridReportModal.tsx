/**
 * 网格报表预览（Univer）
 *
 * 分工：
 * - 展开/分组/汇总等算法在 print-server（Rust，127.0.0.1:18888）完成
 * - 前端只负责描述模板 + 把展开结果铺进 Univer 做展示与编辑
 *
 * 四种模板来源：
 * 1. 内置样例：服务端自带的销售分组汇总（无需连库）
 * 2. 分组汇总：挑数据库表 → 选分组字段 + 数值字段 + 聚合方式 → 多级分组小计/合计/总计
 * 3. 交叉表：行字段纵向 × 列字段横向（可多级）→ 自动带指标子表头 + 行/列合计 + 总计
 * 4. 画布表格：把设计器里选中的表格控件转成明细表模板
 *
 * 三类通用能力：
 * - **筛选条件**：WHERE 子句 + 参数（JSON 数组）下推给服务端，走参数化查询
 * - **字段中文别名**：给已选字段填显示名（留空回落内置别名表，region → 地区）
 * - **合并美化**：标题铺满整行、多级列头下表头格纵向合并、双指标显示「金额/数量」子表头
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Segmented, Select, Space, Spin, Typography } from 'antd'
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import '@univerjs/preset-sheets-core/lib/index.css'

import {
  buildCrossTemplate,
  buildDetailTemplate,
  buildGroupTemplate,
  DEFAULT_FIELD_LABELS,
  headerRowCount,
  parseParams,
  toWorkbookData,
  type AggType,
  type RenderRequest,
  type RenderResponse,
  type ReportTemplate,
} from '../report/grid-report'
import { useDataSourceStore } from '../stores/dataSource'
import { useDesignerStore } from '../stores/designer'

export const REPORT_SERVER = 'http://127.0.0.1:18888'

type TemplateMode = 'sample' | 'group' | 'cross' | 'canvas'

/** 模板构建的三种结果：内置样例 / 可提交请求 / 校验错误 */
type BuildResult =
  | { kind: 'sample' }
  | { kind: 'request'; req: RenderRequest; headerRows: number }
  | { kind: 'error'; message: string }

interface CanvasTableLike {
  type: string
  columns?: Array<{ title?: string; field?: string }>
}

/**
 * 字段别名编辑器：只给已选中的字段提供输入框。
 * 留空 → 回落到内置中文别名表（如 region → 地区）。
 */
function AliasFields({
  fields,
  aliases,
  onChange,
  testid,
}: {
  fields: string[]
  aliases: Record<string, string>
  onChange: (next: Record<string, string>) => void
  testid?: string
}) {
  const shown = fields.filter(Boolean)
  if (!shown.length) return null
  return (
    <Space wrap size="small">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        字段别名
      </Typography.Text>
      {shown.map((f) => (
        <Space key={f} size={4}>
          <Typography.Text style={{ fontSize: 12 }}>{f} →</Typography.Text>
          <Input
            size="small"
            style={{ width: 96 }}
            value={aliases[f] ?? ''}
            placeholder={DEFAULT_FIELD_LABELS[f] ?? f}
            onChange={(e) => onChange({ ...aliases, [f]: e.target.value })}
            data-testid={testid ? `${testid}-${f}` : undefined}
          />
        </Space>
      ))}
    </Space>
  )
}

export default function GridReportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<{ dispose: () => void } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fallbackHtml, setFallbackHtml] = useState('')
  const [mode, setMode] = useState<TemplateMode>('sample')
  const [groupFields, setGroupFields] = useState<string[]>([])
  const [valueField, setValueField] = useState<string>('')
  /** 分组汇总：每个分组内数值字段的聚合方式 */
  const [groupAgg, setGroupAgg] = useState<AggType>('sum')
  // 交叉表：行字段（纵向）× 列字段（横向）× 数值字段
  const [rowFields, setRowFields] = useState<string[]>([])
  const [colFields, setColFields] = useState<string[]>([])
  const [crossValueFields, setCrossValueFields] = useState<string[]>([])
  const [crossAgg, setCrossAgg] = useState<AggType>('sum')
  /** 字段 → 中文别名（行/列/数值/分组字段通用） */
  const [aliases, setAliases] = useState<Record<string, string>>({})
  /** 服务端筛选：WHERE 子句（占位符 ?）+ 参数（JSON 数组） */
  const [where, setWhere] = useState('')
  const [paramText, setParamText] = useState('')

  const dbDatabases = useDataSourceStore((s) => s.dbDatabases)
  const dbTables = useDataSourceStore((s) => s.dbTables)
  const dbColumns = useDataSourceStore((s) => s.dbColumns)
  const dbSelection = useDataSourceStore((s) => s.dbSelection)
  const loadDatabases = useDataSourceStore((s) => s.loadDatabases)
  const loadTables = useDataSourceStore((s) => s.loadTables)
  const selectDatabase = useDataSourceStore((s) => s.selectDatabase)
  const selectTable = useDataSourceStore((s) => s.selectTable)

  const controls = useDesignerStore((s) => s.controls)
  const selectedIds = useDesignerStore((s) => s.selectedIds)

  const canvasTable = useMemo(() => {
    if (!selectedIds.length) return undefined
    return controls.find((c) => selectedIds.includes(c.id) && c.type === 'table') as
      | CanvasTableLike
      | undefined
  }, [controls, selectedIds])

  // 打开时若还没列过库/表，拉一次
  useEffect(() => {
    if (!open) return
    if (dbDatabases.length === 0) void loadDatabases()
    else if (dbTables.length === 0 && dbSelection.database) void loadTables()
  }, [open, dbDatabases.length, dbTables.length, dbSelection.database, loadDatabases, loadTables])

  const columnNames = useMemo(() => dbColumns.map((c) => c.name).filter(Boolean), [dbColumns])

  /**
   * 组装渲染请求：模板 + 数据源声明
   * - sample：用服务端内置样例
   * - error：校验不通过，带错误信息
   * - request：可提交给 /api/report/render 的完整请求
   */
  const buildRequest = useCallback((): BuildResult => {
    if (mode === 'sample') return { kind: 'sample' }

    const dsName = 'ds1'
    let template: ReportTemplate
    if (mode === 'canvas') {
      if (!canvasTable?.columns?.length) {
        return { kind: 'error', message: '请先在画布里选中一个带字段列的表格控件' }
      }
      template = buildDetailTemplate({
        sheetName: '画布明细表',
        ds: dsName,
        columns: canvasTable.columns,
        aliases,
        title: '画布表格明细',
      })
    } else if (mode === 'cross') {
      if (rowFields.length === 0 || colFields.length === 0 || crossValueFields.length === 0) {
        return { kind: 'error', message: '交叉表需要至少一个行字段、一个列字段和一个数值字段' }
      }
      template = buildCrossTemplate({
        sheetName: '交叉表',
        ds: dsName,
        rowFields,
        colFields,
        valueFields: crossValueFields,
        agg: crossAgg,
        aliases,
        title: `${rowFields.join('/')} × ${colFields.join('/')}`,
      })
    } else {
      if (groupFields.length === 0 || !valueField) {
        return { kind: 'error', message: '请选择至少一个分组字段和一个数值字段' }
      }
      template = buildGroupTemplate({
        sheetName: '分组汇总',
        ds: dsName,
        groupFields,
        valueField,
        agg: groupAgg,
        aliases,
        title: `${groupFields.join(' / ')} · ${valueField} 汇总`,
      })
    }

    const { database, table, engine } = dbSelection
    if (!database || !table) return { kind: 'error', message: '请先在数据源里选择库和表' }

    // 参数框是 JSON 数组；空串按「无参数」处理
    const parsed = parseParams(paramText)
    if (!parsed.ok) return { kind: 'error', message: parsed.message ?? '参数不合法' }
    const params = parsed.params?.length ? parsed.params : undefined
    const whereClause = where.trim() ? where.trim() : undefined

    return {
      kind: 'request',
      req: {
        template,
        sources: [{ name: dsName, database, engine, table, where: whereClause, params }],
      },
      headerRows: headerRowCount(template),
    }
  }, [
    mode,
    canvasTable,
    groupFields,
    valueField,
    groupAgg,
    rowFields,
    colFields,
    crossValueFields,
    crossAgg,
    aliases,
    where,
    paramText,
    dbSelection,
  ])

  /**
   * 渲染。`silent` 用于「参数变化触发的自动刷新」：
   * 表单还没填完时不该弹警告条（用户正在输入），但**服务端/网络错误必须暴露**，
   * 否则会留着上一次的结果，用户以为新参数生效了。
   */
  const doRender = useCallback(async (silent = false) => {
    setLoading(true)
    if (!silent) setError('')
    setFallbackHtml('')
    const built = buildRequest()
    if (built.kind === 'error') {
      // 表单未填完：静默跳过（输入过程中的中间态）
      if (!silent) setError(built.message)
      setLoading(false)
      return null
    }
    try {
      let data: RenderResponse
      if (built.kind === 'sample') {
        const res = await fetch(`${REPORT_SERVER}/api/report/sample`)
        if (!res.ok) throw new Error(`服务端返回 ${res.status}`)
        data = (await res.json()) as RenderResponse
      } else {
        const res = await fetch(`${REPORT_SERVER}/api/report/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(built.req),
        })
        const text = await res.text()
        let payload: { message?: string } | RenderResponse = {}
        try {
          payload = JSON.parse(text)
        } catch {
          /* 非 JSON（如 400 纯文本） */
        }
        if (!res.ok) {
          throw new Error((payload as { message?: string }).message || `服务端返回 ${res.status}`)
        }
        data = payload as RenderResponse
      }
      return { data, headerRows: built.kind === 'sample' ? 2 : built.headerRows }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setLoading(false)
    }
  }, [buildRequest])

  /** 导出 xlsx：与渲染同一份请求体，服务端直接返回文件流 */
  const doExport = useCallback(async () => {
    try {
      const built = buildRequest()
      if (built.kind === 'error') throw new Error(built.message)
      let res: Response
      if (built.kind === 'sample') {
        res = await fetch(`${REPORT_SERVER}/api/report/sample.xlsx`)
      } else {
        res = await fetch(`${REPORT_SERVER}/api/report/xlsx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(built.req),
        })
      }
      if (!res.ok) throw new Error(`导出失败：${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download =
        built.kind === 'sample'
          ? 'sample-report.xlsx'
          : `${built.req.template.sheets[0]?.name ?? 'report'}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [buildRequest])

  /**
   * 渲染 + 重建 Univer。
   *
   * 去抖 400ms：筛选条件 / 字段别名是文本框，逐字符触发会把 Univer 反复拆了重建。
   */
  useEffect(() => {
    if (!open) return
    let disposed = false
    const timer = setTimeout(() => {
      void (async () => {
        const out = await doRender(true)
        if (!out || disposed || !containerRef.current) return
        const { data, headerRows } = out
        setFallbackHtml(data.html || '')
        try {
          // 重建前先销毁上一个实例，否则多份 Univer 会叠在同一容器里
          univerRef.current?.dispose()
          univerRef.current = null
          const { univerAPI } = createUniver({
            locale: LocaleType.ZH_CN,
            locales: { [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN) },
            presets: [UniverSheetsCorePreset({ container: containerRef.current })],
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(univerAPI as any).createWorkbook(toWorkbookData(data.sheets[0], { headerRows }))
          univerRef.current = univerAPI as unknown as { dispose: () => void }
        } catch (e) {
          if (!disposed) setError(`Univer 初始化失败：${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    }, 400)

    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [open, doRender])

  /** 关闭时才销毁实例（弹窗 destroyOnHidden，容器随之卸载） */
  useEffect(() => {
    if (open) return
    try {
      univerRef.current?.dispose()
    } catch {
      /* 忽略销毁异常 */
    }
    univerRef.current = null
  }, [open])

  const showQuery = mode !== 'sample'

  return (
    <Modal
      title="网格报表（Univer · 服务端展开）"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Button size="small" onClick={() => void doRender()} data-testid="grid-report-refresh">
            重新渲染
          </Button>
          <Button size="small" onClick={() => void doExport()} data-testid="grid-report-export">
            导出 xlsx
          </Button>
          <Button size="small" onClick={onClose} data-testid="grid-report-close">
            关闭
          </Button>
        </Space>
      }
      width="90vw"
      style={{ top: 24 }}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }} size="small">
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as TemplateMode)}
          options={[
            { label: '内置样例', value: 'sample' },
            { label: '分组汇总', value: 'group' },
            { label: '交叉表', value: 'cross' },
            { label: '画布表格', value: 'canvas' },
          ]}
        />

        {showQuery && (
          <>
            <Space wrap size="small">
              <Select
                size="small"
                style={{ minWidth: 180 }}
                data-testid="grid-report-database"
                placeholder="选择数据库"
                value={dbSelection.database}
                options={dbDatabases.map((d) => ({ label: d.label || d.name, value: d.name }))}
                onChange={(v) => void selectDatabase(v, dbDatabases.find((d) => d.name === v)?.engine)}
              />
              <Select
                size="small"
                style={{ minWidth: 180 }}
                data-testid="grid-report-table"
                placeholder="选择表"
                value={dbSelection.table}
                options={dbTables.map((t) => ({ label: t.name, value: t.name }))}
                onChange={(v) => void selectTable(v)}
              />
              <Input
                size="small"
                style={{ width: 320 }}
                placeholder="筛选条件（不含 WHERE，占位符用 ?），如 region = ?"
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                data-testid="grid-report-where"
              />
              <Input
                size="small"
                style={{ width: 200 }}
                placeholder='参数 JSON 数组，如 ["华东", 1000]'
                value={paramText}
                onChange={(e) => setParamText(e.target.value)}
                data-testid="grid-report-params"
              />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              筛选条件与参数留空即全表（引擎分支不同占位符不同：sqlite 用 ?，postgres 用 ? 或 $1）
            </Typography.Text>
          </>
        )}

        {mode === 'group' && (
          <>
            <Space wrap size="small">
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 260 }}
                placeholder="分组字段（从粗到细）"
                value={groupFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setGroupFields}
                data-testid="grid-report-group-fields"
              />
              <Select
                size="small"
                style={{ minWidth: 160 }}
                placeholder="数值字段"
                value={valueField || undefined}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setValueField}
                data-testid="grid-report-value-field"
              />
              <Select
                size="small"
                style={{ minWidth: 110 }}
                data-testid="grid-report-group-agg"
                value={groupAgg}
                options={[
                  { label: '求和', value: 'sum' },
                  { label: '计数', value: 'count' },
                  { label: '平均', value: 'avg' },
                  { label: '最大', value: 'max' },
                  { label: '最小', value: 'min' },
                ]}
                onChange={(v) => setGroupAgg(v as AggType)}
              />
            </Space>
            <AliasFields
              fields={[...groupFields, valueField]}
              aliases={aliases}
              onChange={setAliases}
              testid="grid-report-alias"
            />
          </>
        )}

        {mode === 'cross' && (
          <>
            <Space wrap size="small">
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 200 }}
                data-testid="grid-report-row-fields"
                placeholder="行字段（纵向）"
                value={rowFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setRowFields}
              />
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 200 }}
                data-testid="grid-report-col-fields"
                placeholder="列字段（横向）"
                value={colFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setColFields}
              />
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 200 }}
                data-testid="grid-report-value-fields"
                placeholder="数值字段"
                value={crossValueFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setCrossValueFields}
              />
              <Select
                size="small"
                style={{ minWidth: 110 }}
                data-testid="grid-report-agg"
                value={crossAgg}
                options={[
                  { label: '求和', value: 'sum' },
                  { label: '计数', value: 'count' },
                  { label: '平均', value: 'avg' },
                  { label: '最大', value: 'max' },
                  { label: '最小', value: 'min' },
                ]}
                onChange={(v) => setCrossAgg(v as AggType)}
              />
            </Space>
            <AliasFields
              fields={[...rowFields, ...colFields, ...crossValueFields]}
              aliases={aliases}
              onChange={setAliases}
              testid="grid-report-cross-alias"
            />
          </>
        )}

        {mode === 'canvas' && (
          <Typography.Text type={canvasTable ? 'secondary' : 'warning'} style={{ fontSize: 12 }}>
            {canvasTable
              ? `已取到画布表格：${canvasTable.columns?.length ?? 0} 列`
              : '请先在画布里选中一个表格控件'}
          </Typography.Text>
        )}
      </Space>

      {error && (
        <Alert
          type="warning"
          showIcon
          title="渲染失败，下面为服务端生成的 HTML 兜底"
          description={error}
          style={{ marginBottom: 12 }}
        />
      )}

      <div style={{ position: 'relative', height: '52vh' }} data-testid="grid-report-container">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(255,255,255,0.6)',
            }}
          >
            <Spin tip="正在从 18888 拉取展开结果…" />
          </div>
        )}
        {error && fallbackHtml && (
          <div style={{ maxHeight: '52vh', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: fallbackHtml }} />
        )}
      </div>
    </Modal>
  )
}
