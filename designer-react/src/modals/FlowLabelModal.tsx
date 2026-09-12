/**
 * FlowLabelModal —— 流水标签批量打印工作台（React 版，对齐 Vue 版 FlowLabelModal.vue）
 *
 * 场景：设计好一张标签模板（页面=标签尺寸，字段绑 {{no}} 等），上传 Excel/CSV/JSON
 * （每行一条数据），逐行渲染单页 → 推送打印 → 下一行。内存恒定（永远只有 1 页），
 * 不做"100 页大 PDF"，避免内存溢出。
 *
 * 数据流：文件 → parseDataFile → 行数组 → 字段映射（{{no}} ↔ 列名）→
 * 逐行 render(模板, 单行data) 预览 + buildPrintPayload(1页) → submitPrintJob → 间隔 → 下一行
 *
 * 纯逻辑（映射合并 / 进度统计 / 间隔判定 / 打印机选项）全部走共享模块
 * `flow-label-logic`（Vue 端同源），本组件只管状态与渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Collapse,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Select,
  Spin,
  Tag,
  Tooltip,
} from 'antd'
import { render } from '@/core/sdk'
import { scanTemplatePlaceholders } from '@/core/layout-engine/placeholder-scan'
import {
  buildPrintPayload,
  describePrintError,
  generateJobId,
  resolvePrintDpi,
  resolvePrintOrientation,
  submitPrintJob,
  type OrientationPref,
} from '@/core/print-client'
import { parseDataFile, type ParsedData } from '@/design/utils/data-import'
import {
  FLOW_PREVIEW_ROWS,
  buildMappedRowData,
  buildPrinterOptions,
  canStartBatch,
  clampPreviewIndex,
  columnOptions,
  computeFlowStats,
  computePrintTotal,
  connHint,
  filterRows,
  formatDuration,
  mergeMapping,
  pickDefaultPrinter,
  rowSummary,
  shouldWaitInterval,
  type FlowRowResult,
} from '@/design/flow-label/shared/flow-label-logic'
import { useDesignerStore } from '../stores/designer'
import { useUiStore } from '../stores/ui'
import { usePrinterProbeStore, selectDefaultPrinter } from '../stores/printerProbe'
import { antdMessage } from '../ui-confirm'
import './flow-label-modal.css'

type ColorMode = 'color' | 'grayscale'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function FlowLabelModal(): React.JSX.Element {
  const open = useUiStore((s) => s.flowLabelOpen)
  const templateName = useDesignerStore((s) => s.templateName)

  /* ------------------------------ 数据上传 + 解析 ------------------------------ */
  const [parsed, setParsed] = useState<ParsedData | null>(null)
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set())
  const [parseError, setParseError] = useState('')
  const [parsing, setParsing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const rows = useMemo(() => (parsed ? filterRows(parsed.rows, deletedRows) : []), [parsed, deletedRows])
  const total = rows.length

  /* ------------------------------ 占位符 + 字段映射 ------------------------------ */
  const [placeholders, setPlaceholders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string | null>>({})

  const refreshPlaceholders = useCallback((): string[] => {
    const list = scanTemplatePlaceholders(useDesignerStore.getState().buildTemplate())
    setPlaceholders(list)
    return list
  }, [])

  const refreshMapping = useCallback((phs: string[]): void => {
    if (!parsed) {
      setMapping({})
      return
    }
    setMapping((prev) => mergeMapping(phs, parsed.columns, prev))
  }, [parsed])

  /* ------------------------------ 单页预览 ------------------------------ */
  const [previewRowIndex, setPreviewRowIndex] = useState(0)
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const refreshPreview = useCallback(async (): Promise<void> => {
    if (!parsed || rows.length === 0) {
      setPreviewHtml('')
      return
    }
    const idx = clampPreviewIndex(previewRowIndex, rows.length)
    const row = rows[idx]
    if (!row) return
    setPreviewLoading(true)
    try {
      const s = useDesignerStore.getState()
      const res = await render({
        template: s.buildTemplate(),
        data: buildMappedRowData(mapping, row),
        output: {
          screen: true,
          scale: 2,
          pageDecoration: {
            backgroundColor: s.pageSetup.backgroundColor ?? '#ffffff',
            watermark: s.pageSetup.watermark,
          },
        },
      })
      setPreviewHtml(res.html)
    } catch {
      setPreviewHtml('')
    } finally {
      setPreviewLoading(false)
    }
  }, [parsed, rows, mapping, previewRowIndex])

  const debouncedPreview = useCallback((): void => {
    if (previewTimer.current) clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => void refreshPreview(), 180)
  }, [refreshPreview])

  /* ------------------------------ 打印机 ------------------------------ */
  const probeState = usePrinterProbeStore((s) => s.state)
  const printers = usePrinterProbeStore((s) => s.printers)
  const probeError = usePrinterProbeStore((s) => s.errorText)
  const printerBase = usePrinterProbeStore((s) => s.baseUrl)
  const defaultPrinter = usePrinterProbeStore(selectDefaultPrinter)

  const [selectedPrinter, setSelectedPrinter] = useState('')
  const [dpi, setDpi] = useState<number | null>(null)
  const [color, setColor] = useState<ColorMode>('grayscale')
  const [orientation, setOrientation] = useState<OrientationPref>('auto')

  const isConnected = probeState === 'connected' && printers.length > 0
  const printerOptions = useMemo(() => buildPrinterOptions(printers), [printers])
  const currentPrinter = useMemo(
    () => printers.find((p) => p.name === selectedPrinter) ?? null,
    [printers, selectedPrinter],
  )

  // 打印机能力变化时同步 DPI / 颜色（与 Vue 版 watch(currentPrinter) 一致）
  useEffect(() => {
    if (currentPrinter) {
      setDpi(resolvePrintDpi(null, currentPrinter))
      if (!currentPrinter.supportsColor) setColor('grayscale')
    }
  }, [currentPrinter])

  // 列表就绪时自动选中默认机（与 Vue 版 ensureDefaultPrinter 一致）
  useEffect(() => {
    if (!isConnected) return
    setSelectedPrinter((cur) => pickDefaultPrinter(cur, printers, defaultPrinter))
  }, [isConnected, printers, defaultPrinter])

  /* ------------------------------ 打印参数 ------------------------------ */
  /** 推送间隔 ms（注意：不要命名为 setInterval，会遮蔽全局定时器） */
  const [intervalMs, setIntervalMs] = useState(300)
  const [copies, setCopies] = useState(1)
  /** 0 = 全部行 */
  const [limitRows, setLimitRows] = useState(0)

  const taskName = templateName || '流水标签'
  const printTotal = computePrintTotal(total, limitRows)

  /* ------------------------------ 批量打印循环 ------------------------------ */
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [results, setResults] = useState<FlowRowResult[]>([])
  const [startTime, setStartTime] = useState(0)
  const [tickNow, setTickNow] = useState(() => Date.now())
  const stoppedRef = useRef(false)
  const pausedRef = useRef(false)
  const tickTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const elapsedMs = running || results.length > 0 ? tickNow - startTime : 0
  const stats = computeFlowStats({ results, printTotal, elapsedMs })
  const failedRows = useMemo(() => results.filter((r) => !r.success), [results])
  const canStart = canStartBatch({
    connected: isConnected,
    rowCount: rows.length,
    placeholderCount: placeholders.length,
    hasPrinter: !!selectedPrinter,
    running,
  })

  /** 打开时：扫占位符 → 重算映射 → 预览；打印机用 probeIfStale（15s TTL，零打扰） */
  useEffect(() => {
    if (!open) return
    const phs = refreshPlaceholders()
    refreshMapping(phs)
    void usePrinterProbeStore.getState().probeIfStale()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 行号/映射变化 → 防抖重渲染预览
  useEffect(() => {
    if (!open) return
    debouncedPreview()
  }, [open, previewRowIndex, mapping, debouncedPreview])

  useEffect(
    () => () => {
      if (tickTimer.current) clearInterval(tickTimer.current)
      if (previewTimer.current) clearTimeout(previewTimer.current)
    },
    [],
  )

  /** 推送单行（开始批量与重试共用） */
  const printOneRow = useCallback(
    async (idx: number, isRetry: boolean): Promise<void> => {
      const s = useDesignerStore.getState()
      const deco = {
        backgroundColor: s.pageSetup.backgroundColor ?? '#ffffff',
        watermark: s.pageSetup.watermark,
      }
      const effectiveDpi = resolvePrintDpi(dpi, currentPrinter)
      const t0 = performance.now()
      try {
        const payload = await buildPrintPayload(
          {
            template: s.buildTemplate(),
            data: buildMappedRowData(mapping, rows[idx] ?? {}),
            output: { pageDecoration: deco },
          },
          // 矢量 HTML 载荷（客户端 QWebEngine 矢量打印）；热敏标签与 DPI 无关
          { mode: 'html' },
        )
        await submitPrintJob(
          {
            jobId: generateJobId(),
            taskName: `${taskName} #${idx + 1}${isRetry ? '（重试）' : ''}`,
            printer: selectedPrinter,
            format: payload.format,
            encoding: payload.encoding,
            content: payload.content,
            pages: payload.pages,
            width: payload.width,
            height: payload.height,
            copies,
            orientation: resolvePrintOrientation(orientation, s.pageSetup.orientation),
            duplex: false,
            color: color === 'color',
            dpi: effectiveDpi,
          },
          printerBase,
        )
        if (isRetry) {
          setResults((prev) =>
            prev.map((r) =>
              r.index === idx
                ? { ...r, success: true, error: undefined, durationMs: performance.now() - t0 }
                : r,
            ),
          )
          antdMessage.success(`第 ${idx + 1} 行重试成功`)
        } else {
          setResults((prev) => [...prev, { index: idx, success: true, durationMs: performance.now() - t0 }])
        }
      } catch (e) {
        const errText = describePrintError(e)
        if (isRetry) {
          setResults((prev) =>
            prev.map((r) =>
              r.index === idx
                ? { ...r, success: false, error: errText, durationMs: performance.now() - t0 }
                : r,
            ),
          )
          antdMessage.error(`第 ${idx + 1} 行重试失败：${errText}`)
        } else {
          setResults((prev) => [
            ...prev,
            { index: idx, success: false, error: errText, durationMs: performance.now() - t0 },
          ])
        }
      }
    },
    [copies, color, currentPrinter, dpi, mapping, orientation, printerBase, rows, selectedPrinter, taskName],
  )

  const startBatch = useCallback(async (): Promise<void> => {
    if (!isConnected) {
      antdMessage.warning('打印机未连接')
      return
    }
    if (rows.length === 0) {
      antdMessage.warning('请先上传数据')
      return
    }
    if (placeholders.length === 0) {
      antdMessage.warning('模板里没有 {{字段}} 占位符，请在设计器里绑定数据')
      return
    }
    if (!selectedPrinter) {
      antdMessage.warning('请选择打印机')
      return
    }

    setRunning(true)
    pausedRef.current = false
    setPaused(false)
    stoppedRef.current = false
    setResults([])
    setStartTime(Date.now())
    setTickNow(Date.now())
    if (tickTimer.current) clearInterval(tickTimer.current)
    tickTimer.current = setInterval(() => setTickNow(Date.now()), 200)

    const limit = computePrintTotal(rows.length, limitRows)
    for (let i = 0; i < limit; i++) {
      while (pausedRef.current && !stoppedRef.current) await sleep(100)
      if (stoppedRef.current) break
      await printOneRow(i, false)
      if (shouldWaitInterval(i, rows.length, intervalMs, stoppedRef.current)) await sleep(intervalMs)
    }

    setRunning(false)
    if (tickTimer.current) {
      clearInterval(tickTimer.current)
      tickTimer.current = undefined
    }
    const finalStats = computeFlowStats({
      results,
      printTotal: limit,
      elapsedMs: Date.now() - startTime,
    })
    if (finalStats.failCount === 0) {
      antdMessage.success(`全部完成：${finalStats.successCount} 张标签已打印`)
    } else {
      antdMessage.warning(
        `完成：成功 ${finalStats.successCount} 张，失败 ${finalStats.failCount} 张（可在失败列表重试）`,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, isConnected, limitRows, placeholders.length, printOneRow, rows, selectedPrinter])

  function pauseBatch(): void {
    pausedRef.current = true
    setPaused(true)
  }

  function resumeBatch(): void {
    pausedRef.current = false
    setPaused(false)
  }

  function stopBatch(): void {
    stoppedRef.current = true
    pausedRef.current = false
    setPaused(false)
  }

  function retryAllFailed(): void {
    for (const r of failedRows) void printOneRow(r.index, true)
  }

  function close(): void {
    if (running && !stoppedRef.current) {
      antdMessage.warning('正在打印中，请先停止')
      return
    }
    useUiStore.getState().setFlowLabelOpen(false)
  }

  /* ------------------------------ 文件选择 ------------------------------ */

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const target = e.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = ''
    if (!file) return
    setParsing(true)
    setParseError('')
    try {
      const data = await parseDataFile(file)
      setParsed(data)
      setDeletedRows(new Set())
      setPreviewRowIndex(0)
      // 换文件后重算映射：自动映射 + 保留"列仍存在"的手动映射（对齐 Vue 版 watch(parsed)）
      setMapping((prev) => mergeMapping(placeholders, data.columns, prev))
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
      setParsed(null)
    } finally {
      setParsing(false)
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  const previewIdxShown = Math.min(previewRowIndex + 1, total || 1)

  return (
    <Modal
      title="流水标签批量打印"
      open={open}
      onCancel={close}
      mask={{ closable: false }}
      width={1100}
      styles={{ body: { padding: 16 }, container: { padding: 0 } }}
      footer={
        <div className="flow-footer">
          <span className="flow-foot-hint">流式渲染：每行单独渲染 1 页 → 推送打印，内存恒定</span>
          <Button size="small" disabled={running && !stoppedRef.current} onClick={close} data-testid="flow-close">
            关闭
          </Button>
        </div>
      }
      data-testid="flow-label-modal"
    >
      <div className="flow-body">
        {/* ===================== 左：数据源 ===================== */}
        <div className="flow-left">
          {!parsed && (
            <div className="flow-upload">
              <Spin spinning={parsing} />
              <div className="flow-upload-icon">⇪</div>
              <div className="flow-upload-title">上传 Excel / CSV / JSON</div>
              <div className="flow-upload-sub">每行一条数据，第一行作为列标题</div>
              <Button size="small" type="primary" onClick={() => fileInputRef.current?.click()}>
                选择文件
              </Button>
              {parseError && <div className="flow-upload-err">{parseError}</div>}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json,.xlsx,.xls"
                className="flow-file-input"
                onChange={(e) => void onFileChange(e)}
              />
            </div>
          )}

          {parsed && (
            <>
              <div className="flow-file-bar">
                <span className="flow-file-name">{parsed.sourceName}</span>
                <Tag>{parsed.columns.length} 列 · {total} 行</Tag>
                <Button size="small" type="link" className="flow-ml-auto" onClick={() => fileInputRef.current?.click()}>
                  重新上传
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.json,.xlsx,.xls"
                  className="flow-file-input"
                  onChange={(e) => void onFileChange(e)}
                />
              </div>

              <div className="flow-section-title">字段映射</div>
              {placeholders.length === 0 ? (
                <div className="flow-empty-hint">
                  模板里没有检测到 <code>{'{{字段}}'}</code> 占位符。<br />
                  请在设计器里给标签控件绑定数据（如 <code>{'{{no}}'}</code>），再回来。
                </div>
              ) : (
                <div className="flow-mapping-list">
                  {placeholders.map((ph) => (
                    <div key={ph} className="flow-mapping-row">
                      <code className="flow-ph-tag">{`{{${ph}}}`}</code>
                      <span className="flow-mapping-arrow">→</span>
                      <Select
                        size="small"
                        value={mapping[ph] || ''}
                        options={columnOptions(parsed.columns)}
                        style={{ flex: 1 }}
                        onChange={(v: string) => setMapping((m) => ({ ...m, [ph]: v || null }))}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="flow-section-title">
                数据预览
                <span className="flow-title-sub">（前 {Math.min(FLOW_PREVIEW_ROWS, total)} 行）</span>
              </div>
              <div className="flow-data-scroll">
                <table className="flow-data-table">
                  <thead>
                    <tr>
                      <th className="flow-idx-col">#</th>
                      {parsed.columns.map((c) => (
                        <th key={c.key} title={c.key}>
                          {c.title || c.key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, FLOW_PREVIEW_ROWS).map((row, i) => (
                      <tr
                        key={i}
                        className={i === previewRowIndex ? 'is-current' : ''}
                        onClick={() => setPreviewRowIndex(i)}
                      >
                        <td className="flow-idx-col">{i + 1}</td>
                        {parsed.columns.map((c) => (
                          <td key={c.key} title={String(row[c.key] ?? '')}>
                            {String(row[c.key] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* ===================== 右：预览 + 控制 + 统计 ===================== */}
        <div className="flow-right">
          <div className="flow-preview-header">
            <span className="flow-section-title-inline">标签预览</span>
            <div className="flow-preview-nav">
              <Button size="small" type="text" disabled={previewRowIndex <= 0} onClick={() => setPreviewRowIndex((i) => i - 1)}>
                ‹
              </Button>
              <span className="flow-preview-indicator" data-testid="flow-preview-indicator">
                第 {previewIdxShown} / {total || 0} 行
              </span>
              <Button
                size="small"
                type="text"
                disabled={previewRowIndex >= total - 1}
                onClick={() => setPreviewRowIndex((i) => i + 1)}
              >
                ›
              </Button>
            </div>
          </div>
          <div className="flow-preview-wrap">
            <Spin spinning={previewLoading}>
              {previewHtml ? (
                <iframe className="flow-preview-iframe" title="标签预览" srcDoc={previewHtml} />
              ) : (
                <div className="flow-preview-empty">上传数据后显示标签预览</div>
              )}
            </Spin>
          </div>

          <div className="flow-config-row">
            <div className="flow-config-field">
              <span className="flow-config-label">打印机</span>
              <Select
                size="small"
                value={selectedPrinter || undefined}
                options={printerOptions}
                placeholder={isConnected ? '选择打印机' : '未连接'}
                disabled={!isConnected}
                style={{ flex: 1 }}
                onChange={setSelectedPrinter}
              />
            </div>
            <Tooltip title="重新检测打印机">
              <Button size="small" type="text" onClick={() => void usePrinterProbeStore.getState().probe()}>
                ⟳
              </Button>
            </Tooltip>
          </div>
          {!isConnected && <div className="flow-conn-hint">{connHint(probeState, probeError)}</div>}

          <div className="flow-config-row">
            <div className="flow-config-field">
              <span className="flow-config-label">间隔</span>
              <InputNumber size="small" min={0} max={10000} step={50} value={intervalMs} onChange={(v) => setIntervalMs(v ?? 0)} style={{ width: 110 }} suffix="ms" />
            </div>
            <div className="flow-config-field">
              <span className="flow-config-label">每张份数</span>
              <InputNumber size="small" min={1} max={99} value={copies} onChange={(v) => setCopies(v ?? 1)} style={{ width: 80 }} />
            </div>
            <div className="flow-config-field">
              <span className="flow-config-label">打印行数</span>
              <InputNumber size="small" min={0} max={total} value={limitRows} onChange={(v) => setLimitRows(v ?? 0)} style={{ width: 90 }} />
              <span className="flow-config-hint">{limitRows > 0 ? `共 ${printTotal} 行` : '全部行'}</span>
            </div>
            {currentPrinter && (
              <div className="flow-config-field">
                <span className="flow-config-label">DPI</span>
                <InputNumber
                  size="small"
                  min={72}
                  max={currentPrinter.maxDpi || 2400}
                  value={dpi ?? undefined}
                  onChange={(v) => setDpi(v ?? null)}
                  style={{ width: 90 }}
                />
              </div>
            )}
          </div>

          <div className="flow-config-row">
            <div className="flow-config-field">
              <span className="flow-config-label">颜色</span>
              <Radio.Group
                size="small"
                value={color}
                disabled={!isConnected || currentPrinter?.supportsColor === false}
                onChange={(e) => setColor(e.target.value as ColorMode)}
              >
                <Radio.Button value="grayscale">黑白</Radio.Button>
                <Radio.Button value="color">彩色</Radio.Button>
              </Radio.Group>
            </div>
            <div className="flow-config-field">
              <span className="flow-config-label">方向</span>
              <Radio.Group size="small" value={orientation} disabled={!isConnected} onChange={(e) => setOrientation(e.target.value as OrientationPref)}>
                <Radio.Button value="auto">跟随模板</Radio.Button>
                <Radio.Button value="portrait">纵向</Radio.Button>
                <Radio.Button value="landscape">横向</Radio.Button>
              </Radio.Group>
              <Tooltip title="默认跟随模板页面设置的方向；若打印机纸张方向与预期相反，可在此手动覆盖为纵向 / 横向。">
                <span className="flow-info">ⓘ</span>
              </Tooltip>
            </div>
          </div>

          <div className="flow-controls">
            {!running ? (
              <Button size="small" type="primary" disabled={!canStart} onClick={() => void startBatch()} data-testid="flow-start">
                ▶ 开始批量打印
              </Button>
            ) : (
              <>
                {!paused ? (
                  <Button size="small" onClick={pauseBatch}>⏸ 暂停</Button>
                ) : (
                  <Button size="small" type="primary" onClick={resumeBatch}>▶ 继续</Button>
                )}
                <Button size="small" danger onClick={stopBatch} data-testid="flow-stop">⏹ 停止</Button>
              </>
            )}
            {paused && <span className="flow-paused">已暂停</span>}
          </div>

          {(running || results.length > 0) && (
            <div className="flow-stats" data-testid="flow-stats">
              <Progress
                percent={stats.progressPct}
                status={stats.failCount > 0 ? 'exception' : 'success'}
                size={{ height: 14 }}
              />
              <div className="flow-stats-grid">
                <div className="flow-stat-item">
                  <span className="flow-stat-num" data-testid="flow-done">{stats.done} / {printTotal}</span>
                  <span className="flow-stat-label">已打印</span>
                </div>
                <div className="flow-stat-item flow-stat-ok">
                  <span className="flow-stat-num">{stats.successCount}</span>
                  <span className="flow-stat-label">成功</span>
                </div>
                <div className="flow-stat-item flow-stat-fail">
                  <span className="flow-stat-num">{stats.failCount}</span>
                  <span className="flow-stat-label">失败</span>
                </div>
                <div className="flow-stat-item">
                  <span className="flow-stat-num">{formatDuration(elapsedMs)}</span>
                  <span className="flow-stat-label">总时长</span>
                </div>
                <div className="flow-stat-item">
                  <span className="flow-stat-num">{stats.avgMs > 0 ? `${(stats.avgMs / 1000).toFixed(2)}s` : '—'}</span>
                  <span className="flow-stat-label">均/张</span>
                </div>
                <div className="flow-stat-item">
                  <span className="flow-stat-num">{running && stats.etaMs > 0 ? formatDuration(stats.etaMs) : '—'}</span>
                  <span className="flow-stat-label">预计剩余</span>
                </div>
              </div>
            </div>
          )}

          {failedRows.length > 0 && (
            <Collapse
              className="flow-failed"
              items={[
                {
                  key: 'failed',
                  label: `失败行（${failedRows.length}）`,
                  children: (
                    <>
                      <div className="flow-failed-toolbar">
                        <Button size="small" type="primary" onClick={retryAllFailed} data-testid="flow-retry-all">
                          全部重试
                        </Button>
                      </div>
                      {failedRows.map((r) => (
                        <div key={r.index} className="flow-failed-row">
                          <div className="flow-failed-info">
                            <Tag color="error">第 {r.index + 1} 行</Tag>
                            <span className="flow-failed-summary">{rowSummary(mapping, rows[r.index])}</span>
                            <span className="flow-failed-err">{r.error}</span>
                          </div>
                          <Button size="small" type="link" onClick={() => void printOneRow(r.index, true)}>
                            重试
                          </Button>
                        </div>
                      ))}
                    </>
                  ),
                },
              ]}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}
