/**
 * ExpressionModal —— 表达式编辑器弹窗（React 版，P4.1）
 *
 * 与 Vue 版交互一致：左侧函数目录 / 字段列表（点击插入片段），右侧表达式输入 +
 * 颜色插入 + 实时预览求值。核心逻辑（过滤 / 求值 / 插入 / 颜色规范化）
 * 全部来自共享 expression-logic（两端同源防漂移）。
 *
 * 排障注：本组件首个订阅 selectFlatFields，暴露了该 selector 缺 memo 的
 * 无限重渲染问题（zustand v5 按引用比较），已在 stores/dataSource.ts 修复。
 */
import { Button, ColorPicker, Empty, Input, Modal, Segmented, Tag } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExprCategory } from '@/design/expression-catalog'
import {
  PRESET_COLORS,
  buildSampleCtx,
  evalExpressionPreview,
  filterCatalog,
  insertSnippetAtCursor,
  normalizePickedHex,
} from '@/design/panels/props/shared/expression-logic'
import { selectFlatFields, selectPreviewData, useDataSourceStore } from '../../stores/dataSource'
import './expression-modal.css'

interface Props {
  show: boolean
  /** 初始表达式（来自文本控件的 expression 字段） */
  expression?: string
  onCancel: () => void
  onConfirm: (value: string) => void
}

type ActiveTab = 'func' | 'field'

/** antd ColorPicker → hex（无 alpha） */
type PickedColor = { toHexString: () => string } | null | undefined

function colorToHex(c: PickedColor): string {
  if (!c || typeof c.toHexString !== 'function') return ''
  try {
    return c.toHexString()
  } catch {
    return ''
  }
}

export default function ExpressionModal({ show, expression = '', onCancel, onConfirm }: Props) {
  const [innerExpr, setInnerExpr] = useState(expression)
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('func')
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const flatFields = useDataSourceStore(selectFlatFields)
  const previewData = useDataSourceStore(selectPreviewData)

  /* 打开时复位：回显表达式、清搜索、聚焦输入框 */
  useEffect(() => {
    if (show) {
      setInnerExpr(expression)
      setSearch('')
      setActiveTab('func')
      // antd Modal portal 挂载后聚焦
      const t = setTimeout(() => taRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [show, expression])

  /* 样例求值上下文（共享 buildSampleCtx，两端同源） */
  const sampleCtx = useMemo(() => buildSampleCtx(previewData), [previewData])

  const filteredCatalog = useMemo(() => filterCatalog(search), [search])

  /* 实时预览（共享 evalExpressionPreview） */
  const preview = useMemo(() => evalExpressionPreview(innerExpr, sampleCtx), [innerExpr, sampleCtx])

  /** 字符串计算在共享 insertSnippetAtCursor，这里只做 DOM 光标/焦点 */
  const insertSnippet = (snippet: string): void => {
    const ta = taRef.current
    const r = ta
      ? insertSnippetAtCursor(innerExpr, snippet, ta.selectionStart ?? undefined, ta.selectionEnd ?? undefined)
      : insertSnippetAtCursor(innerExpr, snippet)
    setInnerExpr(r.next)
    if (ta) {
      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(r.caret, r.caret)
      })
    }
  }

  /** 自选色确认（onChangeComplete 避免拖动过程实时插入；hex 规范化走共享逻辑） */
  const onColorPicked = (c: PickedColor): void => {
    const norm = normalizePickedHex(colorToHex(c))
    if (!norm) return
    insertSnippet(`'${norm}'`)
  }

  return (
    <Modal
      open={show}
      title="表达式编辑器"
      width={760}
      // antd v6 内边距在 container 上（默认 20px 24px），先清掉再用 body 自定义内边距
      styles={{ body: { padding: '12px 4px 0' }, container: { padding: 0 } }}
      onCancel={onCancel}
      footer={
        <div className="expr-footer">
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
          <Button size="small" type="primary" onClick={() => onConfirm(innerExpr)}>
            确定
          </Button>
        </div>
      }
    >
      <div className="expr-modal">
        {/* 左：函数 / 字段 */}
        <div className="expr-left">
          <Segmented
            block
            size="small"
            value={activeTab}
            onChange={(v) => setActiveTab(v as ActiveTab)}
            options={[
              { label: '函数', value: 'func' },
              { label: '字段', value: 'field' },
            ]}
          />

          {activeTab === 'func' && (
            <Input
              size="small"
              value={search}
              placeholder="搜索函数 / 说明"
              allowClear
              className="expr-search"
              onChange={(e) => setSearch(e.target.value)}
            />
          )}

          <div className={`expr-list${activeTab === 'func' ? ' expr-list--tabs' : ''}`}>
            {activeTab === 'func' ? (
              <>
                {(filteredCatalog as ExprCategory[]).map((cat) => (
                  <div key={cat.key} className="expr-cat">
                    <div className="expr-cat-label">{cat.label}</div>
                    {cat.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="expr-fn"
                        onClick={() => insertSnippet(item.snippet)}
                      >
                        <div className="expr-fn-head">
                          <span className="expr-fn-name">{item.label}</span>
                          <code className="expr-fn-snip">{item.snippet}</code>
                        </div>
                        <div className="expr-fn-desc">{item.description}</div>
                        {item.note && <div className="expr-fn-note">注：{item.note}</div>}
                      </button>
                    ))}
                  </div>
                ))}
                {filteredCatalog.length === 0 && (
                  <Empty description="无匹配函数" className="expr-empty" />
                )}
              </>
            ) : (
              <>
                {flatFields.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className="expr-fn"
                    onClick={() => insertSnippet(`{{${f.path}}}`)}
                  >
                    <div className="expr-fn-head">
                      <span className="expr-fn-name">{f.label}</span>
                      <code className="expr-fn-snip">{f.path}</code>
                    </div>
                    <div className="expr-fn-desc">点击插入字段绑定：{'{{' + f.path + '}}'}</div>
                  </button>
                ))}
                {flatFields.length === 0 && (
                  <Empty description="暂无数据源字段" className="expr-empty" />
                )}
              </>
            )}
          </div>
        </div>

        {/* 右：编辑 + 预览 */}
        <div className="expr-right">
          <div className="expr-right-label">表达式</div>
          <div className="expr-color-row">
            {PRESET_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                className="expr-color-chip"
                style={{ background: c.hex }}
                title={`${c.name}（点击插入 ${c.hex}）`}
                onClick={() => insertSnippet(`'${c.hex}'`)}
              />
            ))}
            <ColorPicker
              disabledAlpha
              size="small"
              onChangeComplete={onColorPicked}
              classNames={{ root: 'expr-color-picker' }}
            >
              <Button size="small" type="text" title="自选颜色（确认后插入）">
                🎨
              </Button>
            </ColorPicker>
          </div>
          <textarea
            ref={taRef}
            value={innerExpr}
            spellCheck={false}
            className="expr-input"
            placeholder={'例如 {{order.total | currency:\'CNY\'}} 或 {{sum(\'items[].amount\')}}'}
            onChange={(e) => setInnerExpr(e.target.value)}
          />

          <div className="expr-right-label">实时预览</div>
          <div className="expr-preview">
            {preview.errors.length ? (
              <span className="expr-err">
                <Tag color="error">错误</Tag>
                {preview.errors.join('；')}
              </span>
            ) : (
              <span className="expr-preview-text">{preview.text || '（空）'}</span>
            )}
          </div>
          <div className="expr-tip">
            提示：用双花括号包裹变量，如 <code>{'{{order.total | currency:\'CNY\'}}'}</code>；函数可点击左侧插入；聚合路径需加引号，如{' '}
            <code>'items[].amount'</code>。
          </div>
        </div>
      </div>
    </Modal>
  )
}
