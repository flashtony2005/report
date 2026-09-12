/**
 * SettingsModal —— 全局设置弹窗（React 版）
 *
 * 左侧功能栏 + 右侧配置区。配置存 localStorage：
 * - 打印设置 readPrintSettings / writePrintSettings（@ alias 直用 Vue 端 config）
 * - AI 设置 readAiSettings / writeAiSettings（同上）
 * 对齐 Vue 版 SettingsModal.vue 的六个页签与全部交互。
 */
import { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Modal, Select, Switch, Tag } from 'antd'
import {
  DEFAULT_PRINT_SETTINGS,
  readPrintSettings,
  writePrintSettings,
  type PrintSettings,
} from '@/config/print-settings'
import { buildPrinterBase, FACTORY_PRINTER_BASE_URL } from '@/config/printer'
import { checkHealth, listPrinters, describePrintError } from '@/core/print-client'
import {
  readAiSettings,
  writeAiSettings,
  AI_PROVIDER_PRESETS,
  type AiSettings,
} from '@/config/ai-settings'
import { antdMessage } from '../ui-confirm'
import './settings-modal.css'

type NavKey = 'local' | 'remote' | 'ai' | 'feedback' | 'group' | 'tutorial'

const NAV_ITEMS: Array<{ key: NavKey; label: string; desc: string }> = [
  { key: 'local', label: '本地打印', desc: '浏览器直接打印 / 静默后台打印' },
  { key: 'remote', label: '远程云打印', desc: '通过远程打印服务出纸' },
  { key: 'ai', label: 'AI 助手', desc: '用自然语言生成打印模板' },
  { key: 'tutorial', label: '在线教程', desc: 'Bilibili 视频教程，点击跳转学习' },
  { key: 'feedback', label: '功能反馈', desc: '改进建议 / 新功能需求' },
  { key: 'group', label: '交流群', desc: '扫码加入 QQ 交流群' },
]

/** Bilibili 教程视频列表（点击在新标签打开） */
const TUTORIAL_VIDEOS: Array<{ title: string; url: string; desc: string }> = [
  {
    title: 'OpenPrint 快速上手（示例）',
    url: 'https://www.bilibili.com/video/BV1Hpby6TEJd/?vd_source=b6609163a4dfc54e5a72aa82dc425198#reply311269612161',
    desc: '从打开设计器到打印出第一张单据的完整流程。',
  },
  {
    title: '模板设计与表格排版（示例）',
    url: 'https://www.bilibili.com/video/BV1Hpby6TEJd/?vd_source=b6609163a4dfc54e5a72aa82dc425198#reply311269612161',
    desc: '讲解表格、数据源绑定与表达式的进阶用法。',
  },
  {
    title: '本地打印客户端配置（示例）',
    url: 'https://www.bilibili.com/video/BV1Hpby6TEJd/?vd_source=b6609163a4dfc54e5a72aa82dc425198#reply311269612161',
    desc: '安装 Qprint 客户端并开启静默打印。',
  },
]

const FEEDBACK_EMAIL = 'haiming236@outlook.com'
const FEEDBACK_WECHAT = 'wmcxsj'

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener')
}

function openQrLarge(): void {
  window.open('/qqgroup.jpg', '_blank', 'noopener')
}

export function SettingsModal(props: { show: boolean; onClose: () => void }): React.ReactElement {
  const [activeKey, setActiveKey] = useState<NavKey>('local')
  const [settings, setSettings] = useState<PrintSettings>(() => readPrintSettings())
  const [ai, setAi] = useState<AiSettings>(() => readAiSettings())

  // 深度 watch 等价：任何 setSettings/setAi 后写回 localStorage
  useEffect(() => {
    if (props.show) writePrintSettings(settings)
  }, [settings, props.show])
  useEffect(() => {
    if (props.show) writeAiSettings(ai)
  }, [ai, props.show])

  /* --------------------------- 本地打印客户端连接测试 --------------------------- */

  const localBase = buildPrinterBase(settings.local.silent.host, settings.local.silent.port)
  const [testingLocal, setTestingLocal] = useState(false)
  const [localTestResult, setLocalTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  /** 自测本地打印客户端：/health 拿版本 → /printers 拿数量 */
  async function testLocalClient(): Promise<void> {
    const base = localBase || FACTORY_PRINTER_BASE_URL
    setTestingLocal(true)
    setLocalTestResult(null)
    try {
      const health = await checkHealth(base)
      let count = health.printers
      try {
        count = (await listPrinters(base)).length
      } catch {
        /* 打印机枚举失败不影响健康判定，沿用 health.printers */
      }
      setLocalTestResult({
        ok: true,
        text: `连接正常 · ${health.app} v${health.version} · ${count} 台打印机`,
      })
      antdMessage.success(`打印客户端已连接（${count} 台打印机）`)
    } catch (e) {
      const reason = describePrintError(e)
      setLocalTestResult({ ok: false, text: `${reason}（${base}）` })
      antdMessage.warning(reason)
    } finally {
      setTestingLocal(false)
    }
  }

  /** 恢复出厂地址 127.0.0.1:18888 */
  function resetLocalEndpoint(): void {
    setSettings((s) => ({
      ...s,
      local: { ...s.local, silent: { ...s.local.silent, host: '127.0.0.1', port: 18888 } },
    }))
    setLocalTestResult(null)
    antdMessage.success('已恢复出厂地址 127.0.0.1:18888')
  }

  /* --------------------------- 远程连接测试 --------------------------- */

  const [testing, setTesting] = useState(false)
  async function testRemote(): Promise<void> {
    const { host, port, enabled } = settings.remote
    if (!enabled) {
      antdMessage.warning('请先开启「启用远程云打印」')
      return
    }
    const url = `${host.replace(/\/+$/, '')}:${port}/`
    setTesting(true)
    try {
      // 主动连接探测：用户手动触发，不受"零网络依赖"约束
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) })
      antdMessage.success(`服务可达（HTTP ${res.status}）`)
    } catch (e) {
      const reason = e instanceof Error && e.name === 'TimeoutError' ? '连接超时' : '无法连接'
      antdMessage.warning(`${reason}：${url}（请确认服务已启动，或存在 CORS 限制）`)
    } finally {
      setTesting(false)
    }
  }

  /* ------------------------------ AI 预设 / 恢复默认 ------------------------------ */

  function applyPreset(p: { baseURL: string; model: string }): void {
    setAi((s) => ({ ...s, baseURL: p.baseURL, model: p.model }))
  }

  function resetAll(): void {
    setSettings(structuredClone(DEFAULT_PRINT_SETTINGS))
    antdMessage.success('已恢复默认设置')
  }

  /* ------------------------------ 客户端下载 / 反馈 ------------------------------ */

  async function onDownloadClient(): Promise<void> {
    const url = '/Qprint.exe'
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (!res.ok) throw new Error('not found')
    } catch {
      antdMessage.warning('未找到客户端安装包，请确认已将 Qprint.exe 放到 public/ 目录')
      return
    }
    const a = document.createElement('a')
    a.href = url
    a.download = 'Qprint.exe'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackContact, setFeedbackContact] = useState('')

  /** 通过邮件提交反馈（纯前端 mailto，无需后端） */
  function sendFeedbackMail(): void {
    const text = feedbackText.trim()
    if (!text) {
      antdMessage.warning('请先填写反馈内容')
      return
    }
    const contact = feedbackContact.trim()
    const body = `${text}${contact ? `\n\n—— 联系方式：${contact}` : ''}`
    const subject = encodeURIComponent('OpenPrint 功能反馈')
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${encodeURIComponent(body)}`
    setFeedbackText('')
    setFeedbackContact('')
    antdMessage.success('已打开邮件客户端，请发送反馈（收件人已预填）')
  }

  function copyToClipboard(value: string, label: string): void {
    navigator.clipboard?.writeText(value).then(
      () => antdMessage.success(`已复制${label}：${value}`),
      () => antdMessage.error('复制失败，请手动复制'),
    )
  }

  function close(): void {
    props.onClose()
  }

  return (
    <Modal
      title="设置"
      open={props.show}
      onCancel={close}
      mask={{ closable: false }}
      width={640}
      style={{ maxWidth: '94vw' }}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button size="small" type="text" onClick={resetAll}>
            恢复默认
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="small" onClick={close}>
              取消
            </Button>
            <Button size="small" type="primary" onClick={close}>
              完成
            </Button>
          </div>
        </div>
      }
    >
      <div className="settings-body">
        {/* 左侧功能栏 */}
        <div className="settings-nav">
          {NAV_ITEMS.map((item) => (
            <div
              key={item.key}
              className={`settings-nav-item${activeKey === item.key ? ' is-active' : ''}`}
              onClick={() => setActiveKey(item.key)}
            >
              <span className="text-13px">{item.label}</span>
            </div>
          ))}
        </div>

        {/* 右侧配置区 */}
        <div className="settings-content">
          {/* 本地打印 */}
          {activeKey === 'local' ? (
            <div className="settings-pane">
              <div>
                <div className="config-title">打印方式</div>
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={settings.local.method}
                  onChange={(v) =>
                    setSettings((s) => ({ ...s, local: { ...s.local, method: v } }))
                  }
                  options={[
                    { label: '浏览器直接打印（弹出打印对话框）', value: 'browser' },
                    { label: '客户端打印（静默打印，自动出纸）', value: 'silent' },
                  ]}
                />
                <div className="config-hint">
                  直接打印使用浏览器内置打印对话框；客户端打印自动出纸，无需手动确认。
                </div>
              </div>

              {/* 打印客户端服务地址 */}
              <div className="config-card">
                <div className="config-card-head">
                  <div className="config-title" style={{ marginBottom: 0 }}>
                    打印客户端服务地址
                  </div>
                  <Button type="text" size="small" onClick={resetLocalEndpoint}>
                    恢复出厂 18888
                  </Button>
                </div>
                <div className="config-grid-2">
                  <div>
                    <div className="config-label">客户端 IP 地址</div>
                    <Input
                      size="small"
                      placeholder="127.0.0.1"
                      value={settings.local.silent.host}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          local: {
                            ...s.local,
                            silent: { ...s.local.silent, host: e.target.value },
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <div className="config-label">端口</div>
                    <InputNumber
                      size="small"
                      min={1}
                      max={65535}
                      placeholder="18888"
                      style={{ width: '100%' }}
                      value={settings.local.silent.port}
                      onChange={(v) =>
                        setSettings((s) => ({
                          ...s,
                          local: { ...s.local, silent: { ...s.local.silent, port: v ?? 18888 } },
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="config-row" style={{ marginTop: 8 }}>
                  <Button
                    size="small"
                    loading={testingLocal}
                    onClick={() => void testLocalClient()}
                  >
                    测试连接
                  </Button>
                  {localTestResult ? (
                    <Tag color={localTestResult.ok ? 'success' : 'error'}>
                      {localTestResult.text}
                    </Tag>
                  ) : null}
                </div>

                <div className="config-hint" style={{ marginTop: 8 }}>
                  当前生效：<b>{localBase || FACTORY_PRINTER_BASE_URL}</b>
                  —— 打印机探测（/health、/printers）与任务推送（/print）都走这个地址。
                </div>
                <div className="config-hint" style={{ marginTop: 4 }}>
                  出厂默认 {FACTORY_PRINTER_BASE_URL}；可手动改为局域网地址（客户端已支持局域网打印），
                  手动填写的地址优先级最高。
                </div>
              </div>

              {/* 客户端下载 */}
              <div className="config-card">
                <div className="config-title">本地打印客户端</div>
                <div className="config-hint" style={{ marginBottom: 8 }}>
                  下载并安装 Qprint 客户端后即可开启「客户端静默打印」。安装包随站点发布于
                  public/Qprint.exe。
                </div>
                <Button size="small" type="primary" ghost onClick={() => void onDownloadClient()}>
                  下载客户端（Qprint.exe）
                </Button>
              </div>

              <div className="config-row-between">
                <span className="config-label">副本数</span>
                <InputNumber
                  size="small"
                  min={1}
                  max={99}
                  style={{ width: 120 }}
                  value={settings.local.copies}
                  onChange={(v) =>
                    setSettings((s) => ({ ...s, local: { ...s.local, copies: v ?? 1 } }))
                  }
                />
              </div>

              <div className="config-row-between">
                <div>
                  <div className="config-label">打印后关闭预览窗口</div>
                  <div className="config-hint">打印完成后自动关闭预览面板</div>
                </div>
                <Switch
                  size="small"
                  checked={settings.local.closeAfterPrint}
                  onChange={(v) =>
                    setSettings((s) => ({ ...s, local: { ...s.local, closeAfterPrint: v } }))
                  }
                />
              </div>
            </div>
          ) : null}

          {/* 远程云打印 */}
          {activeKey === 'remote' ? (
            <div className="settings-pane">
              <div className="config-row-between">
                <div>
                  <div className="config-label">启用远程云打印</div>
                  <div className="config-hint">
                    通过远程打印服务把文档发送到指定打印机
                  </div>
                </div>
                <Switch
                  size="small"
                  checked={settings.remote.enabled}
                  onChange={(v) =>
                    setSettings((s) => ({ ...s, remote: { ...s.remote, enabled: v } }))
                  }
                />
              </div>

              <div>
                <div className="config-label">服务地址</div>
                <Input
                  size="small"
                  placeholder="http://127.0.0.1"
                  disabled={!settings.remote.enabled}
                  value={settings.remote.host}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, remote: { ...s.remote, host: e.target.value } }))
                  }
                />
              </div>
              <div className="config-row" style={{ gap: 12 }}>
                <div style={{ width: 130 }}>
                  <div className="config-label">端口</div>
                  <InputNumber
                    size="small"
                    min={1}
                    max={65535}
                    style={{ width: '100%' }}
                    disabled={!settings.remote.enabled}
                    value={settings.remote.port}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, remote: { ...s.remote, port: v ?? 9100 } }))
                    }
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="config-label">打印机名（可选）</div>
                  <Input
                    size="small"
                    placeholder="留空使用服务默认打印机"
                    disabled={!settings.remote.enabled}
                    value={settings.remote.printer}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        remote: { ...s.remote, printer: e.target.value },
                      }))
                    }
                  />
                </div>
              </div>

              <div>
                <Button
                  size="small"
                  loading={testing}
                  disabled={!settings.remote.enabled}
                  onClick={() => void testRemote()}
                >
                  测试连接
                </Button>
              </div>
            </div>
          ) : null}

          {/* AI 助手 */}
          {activeKey === 'ai' ? (
            <div className="settings-pane">
              <div className="config-card">
                <div className="config-title">AI 助手（纯前端直连，零后端）</div>
                <div className="config-hint">
                  配置你自己的大模型服务（OpenAI 兼容格式）。Key 仅保存在本机浏览器，不会上传服务器。
                </div>
                <div className="config-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  {AI_PROVIDER_PRESETS.map((p) => (
                    <Button key={p.label} size="small" onClick={() => applyPreset(p)}>
                      {p.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="config-row-between">
                <div>
                  <div className="config-label">启用 AI 助手</div>
                  <div className="config-hint">关闭后顶部 AI 入口与对话将不可用</div>
                </div>
                <Switch
                  size="small"
                  checked={ai.enabled}
                  onChange={(v) => setAi((s) => ({ ...s, enabled: v }))}
                />
              </div>

              <div>
                <div className="config-label">接口地址（baseURL）</div>
                <Input
                  size="small"
                  placeholder="https://api.openai.com/v1"
                  value={ai.baseURL}
                  onChange={(e) => setAi((s) => ({ ...s, baseURL: e.target.value }))}
                />
                <div className="config-hint" style={{ marginTop: 4 }}>
                  需含 /v1；若浏览器提示跨域(CORS)，请改为你自己的代理地址。
                </div>
              </div>

              <div>
                <div className="config-label">API Key</div>
                <Input.Password
                  size="small"
                  placeholder="sk-..."
                  value={ai.apiKey}
                  onChange={(e) => setAi((s) => ({ ...s, apiKey: e.target.value }))}
                />
              </div>

              <div>
                <div className="config-label">模型 ID</div>
                <Input
                  size="small"
                  placeholder="gpt-4o-mini"
                  value={ai.model}
                  onChange={(e) => setAi((s) => ({ ...s, model: e.target.value }))}
                />
              </div>
            </div>
          ) : null}

          {/* 在线教程 */}
          {activeKey === 'tutorial' ? (
            <div className="settings-pane">
              <div className="config-card" style={{ padding: 16 }}>
                <div className="config-title">Bilibili 视频教程</div>
                <div className="config-hint" style={{ marginBottom: 12 }}>
                  点击任意教程卡片，将在新标签页打开 Bilibili 视频学习如何使用 OpenPrint。
                </div>
                <div className="settings-pane" style={{ gap: 8 }}>
                  {TUTORIAL_VIDEOS.map((item) => (
                    <div
                      key={item.title}
                      className="tutorial-card"
                      onClick={() => openExternal(item.url)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="tutorial-card-title">{item.title}</div>
                        <div className="tutorial-card-desc">{item.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {/* 功能反馈 */}
          {activeKey === 'feedback' ? (
            <div className="settings-pane">
              <div className="config-card">
                <div className="config-title">功能反馈 / 需求建议</div>
                <div className="config-hint">
                  欢迎对本系统的设计或功能提出改进意见，或告诉我们你需要的全新功能。提交后会通过你的邮件客户端发送，
                  也可直接通过下方联系方式联系我。
                </div>
              </div>

              <div>
                <div className="config-label">反馈内容 / 新功能需求</div>
                <Input.TextArea
                  size="small"
                  rows={5}
                  placeholder="例如：希望表格支持跨页重复标题、或增加某类单据模板……"
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                />
              </div>

              <div>
                <div className="config-label">联系方式（可选，邮箱 / 微信皆可）</div>
                <Input
                  size="small"
                  placeholder="方便我们回复你，如微信 wmcxsj"
                  value={feedbackContact}
                  onChange={(e) => setFeedbackContact(e.target.value)}
                />
              </div>

              <div className="config-row">
                <Button size="small" type="primary" onClick={sendFeedbackMail}>
                  发送邮件反馈
                </Button>
                <Button size="small" onClick={() => copyToClipboard(FEEDBACK_EMAIL, '邮箱')}>
                  复制邮箱
                </Button>
                <Button size="small" onClick={() => copyToClipboard(FEEDBACK_WECHAT, '微信号')}>
                  复制微信
                </Button>
              </div>

              <div className="config-card">
                <div className="config-label" style={{ marginBottom: 4 }}>
                  直接联系
                </div>
                <div className="config-contact-line">
                  邮箱：<b>{FEEDBACK_EMAIL}</b>
                  <Button
                    type="text"
                    size="small"
                    onClick={() => copyToClipboard(FEEDBACK_EMAIL, '邮箱')}
                  >
                    复制
                  </Button>
                </div>
                <div className="config-contact-line">
                  微信：<b>{FEEDBACK_WECHAT}</b>
                  <Button
                    type="text"
                    size="small"
                    onClick={() => copyToClipboard(FEEDBACK_WECHAT, '微信号')}
                  >
                    复制
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {/* 交流群 */}
          {activeKey === 'group' ? (
            <div className="settings-pane">
              <div className="config-card" style={{ padding: 16, textAlign: 'center' }}>
                <div className="config-title">QQ 交流群</div>
                <div className="config-hint" style={{ marginBottom: 12 }}>
                  扫码加入 OpenPrint 用户交流群，第一时间获取更新、模板与答疑。
                </div>
                <img
                  src="/qqgroup.jpg"
                  alt="QQ 交流群二维码"
                  className="qq-group-qr"
                  onClick={openQrLarge}
                />
                <div className="config-row" style={{ justifyContent: 'center', marginTop: 12 }}>
                  <Button size="small" onClick={openQrLarge}>
                    查看大图
                  </Button>
                </div>
                <div className="config-hint" style={{ marginTop: 12 }}>
                  若二维码失效，请联系微信 <b>{FEEDBACK_WECHAT}</b> 邀您入群。
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
