/**
 * AiAssistantModal —— 纯前端 AI 设计助手对话抽屉（React 版，对齐 Vue 版 AiAssistantPanel.vue）
 *
 * 一次性问答、零后端；配置来自本地（ai-settings，alias 直用）。
 * 三种模式：新建 / 基于当前模板改 / 选中部分改写（C 功能）。
 * 流式打字动画（渐进呈现缓冲）走共享 `ai-assistant-logic`；生成结果可「应用到画布」。
 * AI 核心（@/ai/generate：提示词组装 → streamChat → 解析 → 归一化 → 校验）零框架依赖，alias 直用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Drawer, Input } from 'antd'
import { generateTemplate } from '@/ai/generate'
import { isAiConfigured, readAiSettings } from '@/config/ai-settings'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import type { TemplateData } from '@/types/template'
import type { AnyControl } from '@/types/control'
import {
  REVEAL_TICK_MS,
  computeRevealStep,
  diffSelectedControls,
  droppedIds,
  droppedNotice,
  parseDatasourceFields,
  resolveMode,
  templateMeta,
  type AiMode,
  type DroppedLike,
} from '@/design/ai/shared/ai-assistant-logic'
import { useDesignerStore } from '../stores/designer'
import { antdMessage, confirmDialog } from '../ui-confirm'
import './ai-assistant-modal.css'

interface ChatMsg {
  id: number
  role: 'user' | 'assistant'
  text: string
  template?: TemplateData<AnyControl>
  /** 选区改写模式：AI 返回的替换控件集合 */
  controls?: AnyControl[]
  /** 归一化阶段被丢掉的东西（我们看不懂，不是用户要删）—— 必须显示，且不能当成删除 */
  dropped?: DroppedLike[]
  error?: string
  streaming?: boolean
}

const EXAMPLES = [
  '生成一个竖向快递面单，100×150mm，标题居中，含收件人信息和条码二维码',
  '做一个 A4 销售发票，顶部公司信息，中间客户与商品表格，底部合计',
  '做一个横向会员卡，90×54mm，左侧品牌、右侧会员姓名和卡号',
]

export function AiAssistantModal(props: { show: boolean; onClose: () => void; onOpenSettings: () => void }) {
  const { show, onClose, onOpenSettings } = props

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AiMode>('create')
  const [dsOpen, setDsOpen] = useState(false)
  const [dsFields, setDsFields] = useState('')
  const [streaming, setStreaming] = useState(false)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const revealTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const seq = useRef(0)
  const lastPrompt = useRef('')
  /** 选区改写模式：发起请求时锁定的选中控件 id，用于回包时定位替换目标 */
  const lockedSelectedIds = useRef<string[]>([])

  // 注意：selector 必须返回稳定引用（zustand v5 useSyncExternalStore 对每次 getSnapshot
  // 做引用比较，直接 map/filter 新数组会触发无限渲染），先订阅原值再 useMemo 派生
  const selectedIds = useDesignerStore((s) => s.selectedIds)
  const allControls = useDesignerStore((s) => s.controls)
  const selectedControls = useMemo(
    () =>
      selectedIds
        .map((id) => allControls.find((c) => c.id === id))
        .filter((c): c is AnyControl => !!c),
    [selectedIds, allControls],
  )
  const hasSelection = selectedControls.length > 0
  const configured = isAiConfigured()
  const canSend = configured && !!input.trim() && !streaming

  const scrollToBottom = useCallback((): void => {
    setTimeout(() => {
      const el = bodyRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, 0)
  }, [])

  /** 卸载/关闭时强制清理：中止请求 + 清打字定时器（防泄漏） */
  useEffect(() => {
    if (show) {
      scrollToBottom()
      return
    }
    abortRef.current?.abort()
    setStreaming(false)
    if (revealTimer.current) {
      clearInterval(revealTimer.current)
      revealTimer.current = undefined
    }
  }, [show, scrollToBottom])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      if (revealTimer.current) clearInterval(revealTimer.current)
    },
    [],
  )

  const run = useCallback(
    async (prompt: string): Promise<void> => {
      if (!prompt.trim() || !configured || streaming) return
      const s = useDesignerStore.getState()
      const hasSel = s.selectedIds.some((id) => s.controls.some((c) => c.id === id))
      // 选区丢失时回退到「新建」（共享逻辑）；同时同步 UI 态
      const effMode = resolveMode(mode, hasSel)
      if (effMode !== mode) setMode(effMode)
      lastPrompt.current = prompt.trim()
      const userId = ++seq.current
      const assistantId = ++seq.current
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', text: lastPrompt.current },
        { id: assistantId, role: 'assistant', text: '', streaming: true },
      ])
      setStreaming(true)
      scrollToBottom()

      const abort = new AbortController()
      abortRef.current = abort

      // 渐进式「打字」呈现：onToken 增量进缓冲，定时器按共享步长节奏刷出（至少 1.6s 动画）
      const revealBuf = { q: '' }
      const updateAssistant = (patch: Partial<ChatMsg>): void => {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)))
      }
      revealTimer.current = setInterval(() => {
        if (revealBuf.q.length) {
          const step = computeRevealStep(revealBuf.q.length)
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, text: m.text + revealBuf.q.slice(0, step) }
                : m,
            ),
          )
          revealBuf.q = revealBuf.q.slice(step)
          scrollToBottom()
        }
        if (!revealBuf.q.length) {
          // 缓冲排空：由调用方置 streaming=false 后清理定时器
        }
      }, REVEAL_TICK_MS)

      try {
        const res = await generateTemplate({
          prompt: lastPrompt.current,
          currentTemplate: effMode === 'modify' ? (s.buildTemplate() as TemplateData<AnyControl>) : undefined,
          selectedControls: effMode === 'selected' ? selectedControls : undefined,
          datasourceFields: dsOpen ? parseDatasourceFields(dsFields) : undefined,
          settings: readAiSettings(),
          signal: abort.signal,
          onToken: (d) => {
            revealBuf.q += d
          },
        })

        if (res.ok && res.data) {
          updateAssistant({ template: res.data, streaming: false })
        } else if (res.ok && res.controls) {
          lockedSelectedIds.current = effMode === 'selected' ? [...s.selectedIds] : []
          updateAssistant({ controls: res.controls, dropped: res.dropped, streaming: false })
        } else {
          updateAssistant({ error: res.error || '生成失败，请重试。', streaming: false })
        }
      } catch (e) {
        updateAssistant({
          error: e instanceof Error && e.name === 'AbortError' ? '已停止生成。' : '生成失败，请重试。',
          streaming: false,
        })
      } finally {
        setStreaming(false)
        abortRef.current = null
        // 残留缓冲交给 tick 收尾：再给一小段时间排空后停表
        setTimeout(() => {
          if (revealTimer.current) {
            clearInterval(revealTimer.current)
            revealTimer.current = undefined
          }
        }, 80)
        scrollToBottom()
      }
    },
    [configured, dsFields, dsOpen, mode, scrollToBottom, selectedControls, streaming],
  )

  function send(): void {
    if (!canSend) return
    void run(input)
    setInput('')
  }

  function sendWith(text: string): void {
    if (streaming || !configured) return
    void run(text)
  }

  function stop(): void {
    abortRef.current?.abort()
    setStreaming(false)
    if (revealTimer.current) {
      clearInterval(revealTimer.current)
      revealTimer.current = undefined
    }
  }

  function clearChat(): void {
    if (!messages.length) return
    void confirmDialog('确定要清空当前对话吗？此操作不可撤销，但已应用到画布的模板不会受影响。', '清空聊天记录').then(
      (ok) => {
        if (!ok) return
        abortRef.current?.abort()
        if (revealTimer.current) {
          clearInterval(revealTimer.current)
          revealTimer.current = undefined
        }
        setStreaming(false)
        setMessages([])
        lastPrompt.current = ''
      },
    )
  }

  function applyTemplate(tpl: TemplateData<AnyControl>): void {
    useDesignerStore.getState().loadTemplate({
      id: `ai-${Date.now()}`,
      name: 'AI 生成模板',
      data: tpl,
    })
    antdMessage.success('已应用到画布，可在编辑器中继续调整')
    onClose()
  }

  /**
   * C：把 AI 返回的控件集合替换掉原选中控件（diff 共享逻辑：原位改 / 新增 / 删除）。
   *
   * ⚠️ `dropped` 必须传进来：里面记着「我们看不懂所以丢掉的控件」。
   * 不传的话它们会被当成「用户要删」→ `removeControl` **真删掉用户的控件**，
   * 还弹绿色成功（这就是本函数之前的行为）。
   */
  function applySelected(controls: AnyControl[], dropped: DroppedLike[]): void {
    const s = useDesignerStore.getState()
    const diff = diffSelectedControls(controls, lockedSelectedIds.current, droppedIds(dropped))
    for (const ctrl of diff.inPlace) s.updateControl(ctrl.id, ctrl)
    for (const ctrl of diff.added) {
      s.addControlOfType(ctrl.type, { leftMm: ctrl.left, topMm: ctrl.top }, ctrl)
    }
    for (const id of diff.removedIds) s.removeControl(id)
    if (diff.preservedIds.length) {
      // 有东西没处理干净：用 warning 而不是 success，并且说清「保持原样、没动它们」
      antdMessage.warning(
        `已应用到选中控件（${diff.summary}）；其中 ${diff.preservedIds.length} 个控件 AI 处理不了（类型：${[
          ...new Set(dropped.map((d) => d.type)),
        ].join(' / ')}），已保持原样未改动。`,
      )
    } else {
      antdMessage.success(`已应用到选中控件（${diff.summary}），可在编辑器中继续微调`)
    }
    onClose()
  }

  function tryDemo(): void {
    useDesignerStore.getState().loadTemplate({
      id: 'ai-demo',
      name: 'AI 示例模板',
      data: createDemoTemplate(),
    })
    antdMessage.success('已载入示例模板（无需配置即可体验）')
    onClose()
  }

  function onInputKey(e: React.KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <Drawer
      title={
        <div className="ai-header">
          <div className="ai-header-icon">✦</div>
          <div className="ai-header-text">
            <div className="ai-header-title">AI 设计助手</div>
            <div className="ai-header-sub">用一句话生成精美打印模板</div>
          </div>
        </div>
      }
      extra={
        <Button size="small" type="text" disabled={!messages.length} onClick={clearChat}>
          清空
        </Button>
      }
      placement="right"
      size={440}
      open={show}
      onClose={onClose}
      mask={{ closable: true }}
      destroyOnHidden={false}
      styles={{ body: { padding: 0 } }}
      footer={
        <div className="ai-footer">
          {!configured ? (
            <div className="ai-notice">
              <div className="ai-notice-text">尚未配置 AI：在设置里填入模型地址 / Key / 模型 ID 后即可对话。</div>
              <div className="ai-notice-actions">
                <Button size="small" type="primary" onClick={onOpenSettings}>
                  去设置
                </Button>
                <Button size="small" onClick={tryDemo}>
                  试用示例
                </Button>
              </div>
            </div>
          ) : (
            <div className="ai-compose">
              <div className="ai-mode">
                <button
                  className={`ai-mode-btn ${mode === 'create' ? 'active' : ''}`}
                  onClick={() => setMode('create')}
                >
                  新建
                </button>
                <button
                  className={`ai-mode-btn ${mode === 'modify' ? 'active' : ''}`}
                  onClick={() => setMode('modify')}
                >
                  基于当前模板改
                </button>
                {hasSelection && (
                  <button
                    className={`ai-mode-btn ${mode === 'selected' ? 'active' : ''}`}
                    onClick={() => setMode('selected')}
                  >
                    选中部分<span className="ai-mode-count">{selectedControls.length}</span>
                  </button>
                )}
                <button className={`ai-ds-btn ${dsOpen ? 'active' : ''}`} onClick={() => setDsOpen(!dsOpen)}>
                  数据字段
                </button>
              </div>
              {mode === 'selected' && hasSelection && (
                <div className="ai-sel-hint">
                  将只改写画布上选中的 {selectedControls.length} 个控件（重排 / 对齐 / 换风格）。
                </div>
              )}
              {dsOpen && (
                <div className="ai-ds-box">
                  <Input.TextArea
                    size="small"
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    value={dsFields}
                    onChange={(e) => setDsFields(e.target.value)}
                    placeholder="可选：填数据字段名，用逗号分隔（如 customer.name, order.total），让绑定指向真实字段"
                  />
                </div>
              )}
              <div className="ai-input-row">
                <Input.TextArea
                  size="small"
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onInputKey}
                  placeholder="描述你想要的模板，例如：做一个 A4 收货单，顶部公司名，中间表格…"
                  data-testid="ai-input"
                />
                {!streaming ? (
                  <Button type="primary" disabled={!canSend} onClick={send} data-testid="ai-send">
                    发送
                  </Button>
                ) : (
                  <Button danger onClick={stop} data-testid="ai-stop">
                    停止
                  </Button>
                )}
              </div>
              <div className="ai-hint">Enter 发送 · ⌘/Ctrl + Enter 也可 · 生成内容建议在编辑器中二次微调</div>
            </div>
          )}
        </div>
      }
    >
      <div className="ai-body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-empty-icon">✦</div>
            <div className="ai-empty-title">想设计点什么？</div>
            <div className="ai-empty-desc">描述你想要的排版，我会直接画出模板布局。</div>
            <div className="ai-chips">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="ai-chip" disabled={!configured} onClick={() => sendWith(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`ai-row ${m.role}`}>
              {m.role === 'assistant' && <div className="ai-avatar">✦</div>}
              <div className={`ai-bubble ${m.role}`}>
                {m.role === 'user' ? (
                  m.text
                ) : (
                  <>
                    {m.streaming && !m.text ? (
                      <div className="ai-typing">
                        <span /><span /><span />
                      </div>
                    ) : (
                      <div className="ai-md">{m.text}</div>
                    )}

                    {m.template && (
                      <div className="ai-tpl-card" data-testid="ai-tpl-card">
                        <div className="ai-tpl-head">
                          <span>模板已生成</span>
                          <span className="ai-tpl-meta">{templateMeta(m.template)}</span>
                        </div>
                        <div className="ai-tpl-actions">
                          <Button size="small" type="primary" onClick={() => applyTemplate(m.template!)}>
                            应用到画布
                          </Button>
                          <Button size="small" onClick={() => void run(lastPrompt.current)}>
                            重新生成
                          </Button>
                        </div>
                      </div>
                    )}

                    {m.controls && (
                      <div className="ai-tpl-card" data-testid="ai-controls-card">
                        <div className="ai-tpl-head">
                          <span>已生成选中部分</span>
                          <span className="ai-tpl-meta">{m.controls.length} 个控件</span>
                        </div>
                        <div className="ai-tpl-actions">
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => applySelected(m.controls!, m.dropped ?? [])}
                          >
                            替换选中控件
                          </Button>
                          <Button size="small" onClick={() => void run(lastPrompt.current)}>
                            重新生成
                          </Button>
                        </div>
                      </div>
                    )}

                    {!!m.dropped?.length && (
                      <div className="ai-error" data-testid="ai-dropped">
                        {droppedNotice(m.dropped)}
                      </div>
                    )}

                    {m.error && (
                      <div className="ai-error" data-testid="ai-error">
                        {m.error}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </Drawer>
  )
}
