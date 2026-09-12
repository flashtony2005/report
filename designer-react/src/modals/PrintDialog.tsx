/**
 * PrintDialog —— 打印配置弹窗（React 版）
 *
 * 本机客户端模式对接本地打印服务（默认 http://127.0.0.1:18888，地址可在设置里覆盖）：
 *   GET /health · GET /printers · POST /print
 * 推送格式：统一推 PDF（base64）/ 自包含 HTML（矢量，推荐默认）/ 净化画布 JSON（esc/tsc/zpl）。
 * 载荷由 buildPrintPayload() 统一构建，与预览/导出共用同一条 render 链路。
 *
 * 主任铁律：无后端全链路可用 —— 客户端不可达时只是不能出纸，设计器功能不受影响。
 * print-client / preview-data / print-settings 全部 @ alias 直用 Vue 端实现。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, InputNumber, Modal, Progress, Radio, Select, Spin, Switch, Tag, Tooltip } from 'antd'
import { useDesignerStore } from '../stores/designer'
import { useDataSourceStore, selectActiveFields } from '../stores/dataSource'
import { buildPreviewData } from '@/design/preview/preview-data'
import { usePrinterProbeStore } from '../stores/printerProbe'
import {
  buildPrintPayload,
  describePrintError,
  formatPayloadSize,
  generateJobId,
  isRawPayloadMode,
  RAW_PAYLOAD_MODE_LABELS,
  resolvePrintDpi,
  resolvePrintOrientation,
  submitPrintJob,
  type OrientationPref,
  type PrintPayloadMode,
  type PrinterInfo,
} from '@/core/print-client'
import { antdMessage } from '../ui-confirm'
import './print-dialog.css'

type PrintTarget = 'local' | 'cloud'
type PrinterStatus = 'checking' | 'connected' | 'disconnected'
type Duplex = 'single' | 'double'
type ColorMode = 'color' | 'grayscale'

const KIND_LABEL: Record<PrinterInfo['kind'], string> = {
  virtual: '虚拟',
  common: '普通',
  ticket: '票据',
}

/** 从 localStorage 读云打印配置（复用 config/print-settings.ts 结构） */
function readCloudSettings(): { host: string; port: number } {
  try {
    const raw = localStorage.getItem('openprint:print-settings')
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        host: parsed?.remote?.host || 'http://localhost',
        port: parsed?.remote?.port || 9100,
      }
    }
  } catch {
    // ignore
  }
  return { host: 'http://localhost', port: 9100 }
}

export function PrintDialog(props: { show: boolean; onClose: () => void }): React.ReactElement {
  const templateName = useDesignerStore((s) => s.templateName)

  /* ------------------------------ 打印模式 ------------------------------ */
  const [target, setTarget] = useState<PrintTarget>('local')
  const [payloadMode, setPayloadMode] = useState<PrintPayloadMode>('html')
  /** 是否内联文本字体（仅 html 模式，默认 false = 不内联、体积最小化） */
  const [embedFonts, setEmbedFonts] = useState(false)

  /* ------------------------------ 本机客户端探测（共享单例） ------------------------------ */
  const probeState = usePrinterProbeStore((s) => s.state)
  const probeHealth = usePrinterProbeStore((s) => s.health)
  const localPrinters = usePrinterProbeStore((s) => s.printers)
  const probeError = usePrinterProbeStore((s) => s.errorText)
  const printerBase = usePrinterProbeStore((s) => s.baseUrl)

  /* ------------------------------ 云打印探测 ------------------------------ */
  const [cloudStatus, setCloudStatus] = useState<PrinterStatus>('checking')
  const [cloudPrinters, setCloudPrinters] = useState<Array<{ label: string; value: string }>>([])
  const [cloudError, setCloudError] = useState('')

  /* ------------------------------ 统一状态 ------------------------------ */
  const printerStatus: PrinterStatus = useMemo(() => {
    if (target === 'cloud') return cloudStatus
    switch (probeState) {
      case 'connected':
        return localPrinters.length > 0 ? 'connected' : 'disconnected'
      case 'disconnected':
        return 'disconnected'
      default:
        return 'checking'
    }
  }, [target, cloudStatus, probeState, localPrinters.length])

  const isConnected = printerStatus === 'connected'
  /** 未连接时禁用下方所有配置选项（参考可看但不可选） */
  const formDisabled = !isConnected

  const statusTagText = (() => {
    switch (printerStatus) {
      case 'checking':
        return '检测中…'
      case 'connected':
        return target === 'local'
          ? `已连接 · ${localPrinters.length} 台打印机`
          : '已连接云打印服务'
      case 'disconnected':
        return target === 'local' ? '客户端不可达' : '无法连接云打印服务'
    }
  })()

  const statusTagColor =
    printerStatus === 'checking' ? 'warning' : printerStatus === 'connected' ? 'success' : 'error'

  /** 未连接时的详细原因 */
  const disconnectedTip = (() => {
    if (target === 'cloud') {
      return cloudError || '无法连接云打印服务。请检查服务地址和端口配置（设置 → 远程云打印）。'
    }
    if (probeState === 'connected' && localPrinters.length === 0) {
      return `已连上客户端（${printerBase}），但未枚举到任何打印机，请检查系统打印机安装情况。`
    }
    return `${probeError || '无法连接本机打印客户端'}。当前地址 ${printerBase}，可在「设置 → 本地打印」修改 IP / 端口。`
  })()

  /* ------------------------------ 打印机列表 ------------------------------ */
  const [selectedPrinter, setSelectedPrinter] = useState<string>('')

  const printerOptions = useMemo(() => {
    if (target === 'cloud') return cloudPrinters
    return localPrinters.map((p) => ({
      label: `${p.name}${p.isDefault ? ' · 默认' : ''}${p.isOnline ? '' : '（离线）'}`,
      value: p.name,
      disabled: !p.isOnline,
    }))
  }, [target, cloudPrinters, localPrinters])

  /** 当前选中的本机打印机详情 */
  const currentPrinter = useMemo<PrinterInfo | null>(() => {
    if (target !== 'local') return null
    return localPrinters.find((p) => p.name === selectedPrinter) ?? null
  }, [target, localPrinters, selectedPrinter])

  /* ------------------------------ 打印参数 ------------------------------ */
  const [copies, setCopies] = useState(1)
  const [duplex, setDuplex] = useState<Duplex>('single')
  const [color, setColor] = useState<ColorMode>('grayscale')
  const [orientation, setOrientation] = useState<OrientationPref>('auto')
  const [dpi, setDpi] = useState<number | null>(null)

  /** 分辨率输入上限（打印机未上报 maxDpi 时放开到 2400 常见上限） */
  const reportedMaxDpi = currentPrinter?.maxDpi ?? 0
  const dpiMax = reportedMaxDpi > 0 ? reportedMaxDpi : 2400

  /** 本次打印实际生效的 DPI（手动值优先 → 打印机 defaultDpi → 300，maxDpi 钳制） */
  const effectiveDpi = resolvePrintDpi(dpi, currentPrinter)

  /** 选中打印机后自动收敛不支持的能力，并默认填入该机 defaultDpi（等价 Vue watch currentPrinter） */
  useEffect(() => {
    if (!currentPrinter) return
    if (!currentPrinter.supportsDuplex) setDuplex('single')
    if (!currentPrinter.supportsColor) setColor('grayscale')
    setDpi(resolvePrintDpi(null, currentPrinter))
  }, [currentPrinter?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 手动输入越界时立即钳回（等价 Vue watch dpi） */
  useEffect(() => {
    if (dpi === null) return
    const clamped = resolvePrintDpi(dpi, currentPrinter)
    if (clamped !== dpi) setDpi(clamped)
  }, [dpi]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------ 探测 ------------------------------ */

  /** 本机：走共享探测单例（force=false 复用 15s 内结果，force=true 强制重探） */
  async function detectLocalPrinters(force = false): Promise<void> {
    const store = usePrinterProbeStore.getState()
    if (force) await store.probe()
    else await store.probeIfStale()
    const { printers } = usePrinterProbeStore.getState()
    const def = printers.find((p) => p.isDefault) ?? printers.filter((p) => p.isOnline)[0] ?? null
    if (def && !printers.some((p) => p.name === selectedPrinter)) {
      setSelectedPrinter(def.name)
    }
  }

  /** 云打印探测：从 print-settings 读配置，尝试连接远程打印服务获取打印机列表 */
  async function detectCloudPrinters(): Promise<void> {
    setCloudStatus('checking')
    setCloudPrinters([])
    setCloudError('')

    const settings = readCloudSettings()
    if (!settings.host) {
      setCloudStatus('disconnected')
      return
    }

    const url = `${settings.host.replace(/\/+$/, '')}:${settings.port}/api/printers`
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as Array<{ id: string; name: string }>
      if (data && data.length > 0) {
        setCloudPrinters(data.map((p) => ({ label: p.name, value: p.id })))
        setSelectedPrinter(data[0]?.id || '')
        setCloudStatus('connected')
      } else {
        setCloudError('云打印服务未返回任何打印机')
        setCloudStatus('disconnected')
      }
    } catch (e) {
      setCloudError(`无法连接 ${url}（${e instanceof Error ? e.message : String(e)}）`)
      setCloudStatus('disconnected')
    }
  }

  /** 重置为默认值 */
  function resetDefaults(): void {
    setCopies(1)
    setDuplex('single')
    setColor('grayscale')
    setOrientation('auto')
    setEmbedFonts(false)
    setDpi(currentPrinter ? resolvePrintDpi(null, currentPrinter) : null)
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  // 切换目标：本机走共享探测，云走远程探测（等价 Vue watch target）
  useEffect(() => {
    if (!props.show) return
    if (target === 'local') void detectLocalPrinters()
    else void detectCloudPrinters()
  }, [target]) // eslint-disable-line react-hooks/exhaustive-deps

  // 打开弹窗：重置参数 + 探测（等价 Vue watch show）
  useEffect(() => {
    if (!props.show) return
    resetDefaults()
    setProgress(0)
    setProgressStage('')
    setProgressStatus('info')
    if (target === 'local') void detectLocalPrinters()
    else void detectCloudPrinters()
  }, [props.show]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 刷新打印机列表（手动）→ 强制重探拿最新状态 */
  function refreshPrinters(): void {
    if (target === 'local') void detectLocalPrinters(true)
    else void detectCloudPrinters()
  }

  /* ------------------------------ 推送打印 ------------------------------ */

  const [printing, setPrinting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressStage, setProgressStage] = useState('')
  const [progressStatus, setProgressStatus] = useState<'info' | 'success' | 'error'>('info')

  async function doPrint(): Promise<void> {
    if (!isConnected) {
      antdMessage.warning('打印机未连接，无法打印')
      return
    }
    if (target === 'cloud') {
      antdMessage.info('云打印推送尚未接入，请切换到「本机客户端」')
      return
    }
    if (printing) return

    setPrinting(true)
    setProgress(0)
    setProgressStatus('info')
    setProgressStage('正在排版渲染…')
    try {
      const ds = useDesignerStore.getState()
      const template = ds.buildTemplate()
      const data = buildPreviewData(selectActiveFields(useDataSourceStore.getState()))
      const payload = await buildPrintPayload(
        {
          template,
          data,
          output: {
            pageDecoration: {
              backgroundColor: ds.pageSetup.backgroundColor ?? '#ffffff',
              watermark: ds.pageSetup.watermark,
            },
          },
        },
        {
          mode: payloadMode,
          embedFonts,
          ...(payloadMode === 'pdf' ? { dpi: effectiveDpi, imageType: 'png' as const } : {}),
          onProgress: (p) => {
            setProgress(p)
            if (p < 30) setProgressStage('正在排版渲染…')
            else if (p < 85)
              setProgressStage(
                isRawPayloadMode(payloadMode)
                  ? `正在序列化画布 JSON（${RAW_PAYLOAD_MODE_LABELS[payloadMode] ?? payloadMode}）…`
                  : payloadMode === 'html'
                    ? embedFonts
                      ? '正在生成矢量 HTML（内联字体）…'
                      : '正在生成矢量 HTML…'
                    : `正在生成 PDF（${effectiveDpi} DPI）…`,
              )
            else setProgressStage('准备推送…')
          },
        },
      )

      setProgressStage(
        isRawPayloadMode(payloadMode)
          ? `正在推送画布 JSON（${RAW_PAYLOAD_MODE_LABELS[payloadMode] ?? payloadMode}）到打印机…`
          : payloadMode === 'html'
            ? '正在推送 HTML 到打印机…'
            : '正在推送 PDF 到打印机…',
      )
      setProgressStatus('info')
      const res = await submitPrintJob(
        {
          jobId: generateJobId(),
          taskName: templateName || '未命名模板',
          printer: selectedPrinter,
          format: payload.format,
          encoding: payload.encoding,
          content: payload.content,
          pages: payload.pages,
          width: payload.width,
          height: payload.height,
          copies,
          orientation: resolvePrintOrientation(orientation, ds.pageSetup.orientation),
          duplex: duplex === 'double',
          color: color === 'color',
          dpi: effectiveDpi,
        },
        printerBase,
        undefined,
        (p) => setProgress(p),
      )

      setProgress(100)
      setProgressStatus('success')
      setProgressStage('打印任务已提交')
      const job = res.jobId ? ` · 任务号 ${res.jobId}` : ''
      antdMessage.success(
        `已推送到「${selectedPrinter}」：${payload.pages} 页 · ${payload.format.toUpperCase()} · ${formatPayloadSize(payload.bytes)} · ${copies} 份${job}`,
      )
      // 停留 700ms 让用户看清 100%，再关闭
      setTimeout(() => props.onClose(), 700)
    } catch (e) {
      setProgressStatus('error')
      setProgressStage('打印失败')
      antdMessage.error(`推送失败：${describePrintError(e)}`)
    } finally {
      setPrinting(false)
    }
  }

  function close(): void {
    props.onClose()
  }

  const taskName = templateName || '未命名模板'

  return (
    <Modal
      title="打印"
      open={props.show}
      onCancel={close}
      mask={{ closable: false }}
      width={560}
      style={{ maxWidth: '94vw' }}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <Button size="small" disabled={printing} onClick={close}>
            取消
          </Button>
          <Button
            size="small"
            type="primary"
            loading={printing}
            disabled={!isConnected || printing}
            onClick={() => void doPrint()}
          >
            打印
          </Button>
        </div>
      }
    >
      {/* 打印目标切换 */}
      <div className="print-target-bar">
        <Radio.Group
          value={target}
          onChange={(e) => setTarget(e.target.value as PrintTarget)}
          optionType="button"
          buttonStyle="solid"
          size="small"
          options={[
            { label: '本机客户端', value: 'local' },
            { label: '云打印', value: 'cloud' },
          ]}
        />
        <div className="config-row">
          {printerStatus === 'checking' ? <Spin size="small" /> : null}
          <Tag color={statusTagColor} style={{ borderRadius: 999 }}>
            {statusTagText}
          </Tag>
          <Tooltip title="重新检测打印机">
            <Button type="text" size="small" onClick={refreshPrinters}>
              ↻
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* 服务地址（本机模式） */}
      {target === 'local' ? (
        <div className="print-base-line">
          <span>
            服务地址 {printerBase}
            {probeHealth ? ` · ${probeHealth.app} v${probeHealth.version}` : ''}
          </span>
        </div>
      ) : null}

      {/* 未连接提示 */}
      {!isConnected && printerStatus !== 'checking' ? (
        <div className="print-disconnected-tip">
          <span className="config-hint">{disconnectedTip}</span>
        </div>
      ) : null}

      {/* 打印配置区域 */}
      <div className={`print-form${formDisabled ? ' is-disabled' : ''}`}>
        {/* 打印机选择 */}
        <div className="print-field">
          <div className="print-field-label">打印机</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Select
              value={selectedPrinter || undefined}
              options={printerOptions}
              size="small"
              disabled={formDisabled}
              placeholder={isConnected ? '选择打印机' : '未连接'}
              style={{ width: '100%' }}
              onChange={(v) => setSelectedPrinter(v)}
            />
            {currentPrinter ? (
              <div className="printer-meta">
                <Tag color={currentPrinter.status === 'idle' ? 'success' : 'error'}>
                  {currentPrinter.status === 'idle' ? '空闲' : '异常'}
                </Tag>
                <Tag>{KIND_LABEL[currentPrinter.kind]}</Tag>
                <Tag>
                  默认 {currentPrinter.defaultDpi} / 最高 {currentPrinter.maxDpi} DPI
                </Tag>
                <Tag color={currentPrinter.supportsColor ? 'blue' : 'default'}>
                  {currentPrinter.supportsColor ? '支持彩色' : '仅黑白'}
                </Tag>
                <Tag color={currentPrinter.supportsDuplex ? 'blue' : 'default'}>
                  {currentPrinter.supportsDuplex ? '支持双面' : '仅单面'}
                </Tag>
                {currentPrinter.trays.length ? (
                  <Tag>纸盒：{currentPrinter.trays.join(' / ')}</Tag>
                ) : null}
              </div>
            ) : null}
            {currentPrinter?.driver ? (
              <div className="printer-driver">驱动：{currentPrinter.driver}</div>
            ) : null}
          </div>
        </div>

        {/* 打印任务名（固定模板名，无随机） */}
        <div className="print-field">
          <div className="print-field-label">任务名称</div>
          <div className="print-name-preview">{taskName}</div>
        </div>

        {/* 打印份数 */}
        <div className="print-field">
          <div className="print-field-label">打印份数</div>
          <InputNumber
            size="small"
            min={1}
            max={99}
            disabled={formDisabled}
            style={{ width: 100 }}
            value={copies}
            onChange={(v) => setCopies(v ?? 1)}
          />
        </div>

        {/* 载荷格式（仅本机模式） */}
        {target === 'local' ? (
          <div className="print-field">
            <div className="print-field-label">载荷格式</div>
            <Radio.Group
              value={payloadMode}
              size="small"
              disabled={formDisabled}
              optionType="button"
              onChange={(e) => setPayloadMode(e.target.value as PrintPayloadMode)}
              options={[
                { label: 'HTML', value: 'html' },
                { label: 'PDF', value: 'pdf' },
                { label: 'ESC/POS', value: 'esc' },
                { label: 'TSC', value: 'tsc' },
                { label: 'ZPL', value: 'zpl' },
              ]}
            />
          </div>
        ) : null}

        {/* 字体内联（仅矢量 HTML 模式） */}
        {target === 'local' && payloadMode === 'html' ? (
          <div className="print-field">
            <div className="print-field-label">字体嵌入</div>
            <div className="config-row" style={{ flex: 1 }}>
              <Switch
                size="small"
                disabled={formDisabled}
                checked={embedFonts}
                onChange={setEmbedFonts}
              />
              <span className="config-hint">
                {embedFonts ? '内联模板字体（约 700KB/页）' : '不内联 · 客户端回退系统字体（约 17KB/页）'}
              </span>
            </div>
          </div>
        ) : null}

        {/* 打印分辨率（仅位图 PDF 模式生效） */}
        {target === 'local' && payloadMode === 'pdf' ? (
          <div className="print-field">
            <div className="print-field-label">分辨率</div>
            <div className="config-row" style={{ flex: 1, gap: 12 }}>
              <InputNumber
                size="small"
                min={72}
                max={dpiMax}
                disabled={formDisabled}
                style={{ width: 132 }}
                value={dpi}
                onChange={(v) => setDpi(v)}
                suffix="DPI"
              />
              <span className="config-hint">
                PDF 按此分辨率渲染
                {currentPrinter ? ` · 该机默认 ${currentPrinter.defaultDpi} · 上限 ${dpiMax}` : ''}
              </span>
            </div>
          </div>
        ) : null}

        {/* 单面/双面 */}
        <div className="print-field">
          <div className="print-field-label">双面打印</div>
          <Radio.Group
            value={duplex}
            size="small"
            disabled={formDisabled || currentPrinter?.supportsDuplex === false}
            optionType="button"
            onChange={(e) => setDuplex(e.target.value as Duplex)}
            options={[
              { label: '单面', value: 'single' },
              { label: '双面', value: 'double' },
            ]}
          />
        </div>

        {/* 颜色 */}
        <div className="print-field">
          <div className="print-field-label">颜色</div>
          <Radio.Group
            value={color}
            size="small"
            disabled={formDisabled || currentPrinter?.supportsColor === false}
            optionType="button"
            onChange={(e) => setColor(e.target.value as ColorMode)}
            options={[
              { label: '黑白', value: 'grayscale' },
              { label: '彩色', value: 'color' },
            ]}
          />
        </div>

        {/* 方向 */}
        <div className="print-field">
          <div className="print-field-label">方向</div>
          <Radio.Group
            value={orientation}
            size="small"
            disabled={formDisabled}
            optionType="button"
            onChange={(e) => setOrientation(e.target.value as OrientationPref)}
            options={[
              { label: '跟随模板', value: 'auto' },
              { label: '纵向', value: 'portrait' },
              { label: '横向', value: 'landscape' },
            ]}
          />
        </div>
      </div>

      {/* 推送格式说明 */}
      <div className="print-format-note">
        <span>
          {payloadMode === 'html' ? (
            <>
              推送规则：渲染为<b>自包含 HTML（utf8）</b>推送，本地客户端用 Qt WebEngine 输出
              <b>矢量 PDF</b>——含文本层、清晰度与分辨率无关、体积约为位图模式的 7%。
              {embedFonts ? '字体已内联、零外部引用。' : '默认不内联字体（约 17KB/页），客户端按系统字体渲染，CJK 版式基本一致。'}
            </>
          ) : isRawPayloadMode(payloadMode) ? (
            <>
              推送规则：把<b>净化后的画布 JSON（{'{ version, document, data }'}，utf8）</b>推送给客户端，由客户端解析并翻译为
              <b>{RAW_PAYLOAD_MODE_LABELS[payloadMode] ?? payloadMode}</b> 指令——Web 端零渲染。
            </>
          ) : (
            <>
              推送规则：文档按所选分辨率（{effectiveDpi} DPI）栅格化为<b>PDF（base64）</b>
              推送，与打印机分辨率一致，本地客户端直接打印无需重采样。
            </>
          )}
        </span>
      </div>

      {/* 打印进度 */}
      {printing || progressStatus === 'success' || progressStatus === 'error' ? (
        <div className="print-progress">
          <Progress
            type="line"
            percent={progress}
            status={progressStatus === 'info' ? 'active' : progressStatus === 'success' ? 'success' : 'exception'}
            size={['100%', 12]}
          />
          <div className="config-row-between" style={{ marginTop: 6 }}>
            <span className="config-hint">{progressStage || '处理中…'}</span>
            <span className="config-hint">{progress}%</span>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
