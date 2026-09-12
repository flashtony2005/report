/**
 * TemplateMarket —— 模板市场弹窗（与 Vue 版 TemplateMarket.vue 行为对齐）
 * 左侧分类 + 右侧模板卡片网格；点击「使用」直接加载到画布（dirty 时确认）。
 * 模板数据 `@/repository/mock/data/market-templates` 为框架无关模块，alias 直用。
 */
import { useMemo, useState } from 'react'
import { Button, Empty, Input, Modal, message } from 'antd'
import { useDesignerStore } from '../stores/designer'
import { confirmDialog } from '../ui-confirm'
import {
  MARKET_CATEGORY_LABEL,
  MARKET_TEMPLATES,
  type MarketCategory,
  type MarketTemplate,
} from '@/repository/mock/data/market-templates'
import './template-market.css'

type Filter = 'all' | MarketCategory

/** 按纸张宽高比生成迷你缩略矩形（fit 52×64 盒） */
function aspect(wMm: number, hMm: number, maxW = 52, maxH = 64): { w: number; h: number } {
  const scale = Math.min(maxW / wMm, maxH / hMm)
  return { w: Math.max(24, Math.round(wMm * scale)), h: Math.max(16, Math.round(hMm * scale)) }
}

export function TemplateMarket({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [activeFilter, setActiveFilter] = useState<Filter>('all')
  const [keyword, setKeyword] = useState('')

  const filtered = useMemo(() => {
    const kw = keyword.trim()
    return MARKET_TEMPLATES.filter((t) => {
      if (activeFilter !== 'all' && t.category !== activeFilter) return false
      if (kw && !`${t.name}${t.desc}`.toLowerCase().includes(kw.toLowerCase())) return false
      return true
    })
  }, [activeFilter, keyword])

  async function useTemplate(tpl: MarketTemplate): Promise<void> {
    const dirty = useDesignerStore.getState().dirty
    if (dirty && !(await confirmDialog(`使用「${tpl.name}」将覆盖当前未保存的改动。确定继续？`))) return
    useDesignerStore.getState().loadTemplate({ id: tpl.id, name: tpl.name, data: tpl.build() })
    onClose()
    void message.success(`已载入模板：${tpl.name}`)
  }

  return (
    <Modal
      title="模板市场"
      open={open}
      onCancel={onClose}
      width={780}
      footer={
        <div className="market-footer">
          <span className="market-footer-hint">
            共 {MARKET_TEMPLATES.length} 个预设模板，点击「使用」直接载入画布
          </span>
          <Button size="small" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="market-layout">
        {/* 左侧分类 */}
        <div className="market-cats">
          <button
            type="button"
            className={`market-cat-item${activeFilter === 'all' ? ' is-active' : ''}`}
            data-testid="market-cat-all"
            onClick={() => setActiveFilter('all')}
          >
            <span className="text-13px">全部</span>
            <span className="market-count">{MARKET_TEMPLATES.length}</span>
          </button>
          {(Object.keys(MARKET_CATEGORY_LABEL) as MarketCategory[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`market-cat-item${activeFilter === key ? ' is-active' : ''}`}
              onClick={() => setActiveFilter(key)}
            >
              <span className="text-13px">{MARKET_CATEGORY_LABEL[key]}</span>
              <span className="market-count">
                {MARKET_TEMPLATES.filter((t) => t.category === key).length}
              </span>
            </button>
          ))}
        </div>

        {/* 右侧模板卡片 */}
        <div className="market-main">
          <div className="market-search">
            <Input
              size="small"
              value={keyword}
              placeholder="搜索模板名称 / 描述"
              allowClear
              onChange={(e) => setKeyword(e.target.value)}
              data-testid="market-search"
            />
          </div>
          <div className="market-grid-wrap">
            {filtered.length === 0 ? (
              <Empty description="没有匹配的模板" className="market-empty" />
            ) : (
              <div className="market-grid">
                {filtered.map((tpl) => {
                  const size = aspect(tpl.pageW, tpl.pageH)
                  return (
                    <div key={tpl.id} className="market-card" data-testid="market-card">
                      <div className="market-card-top">
                        <div
                          className="mini-paper"
                          style={{ width: `${size.w}px`, height: `${size.h}px` }}
                        >
                          <div className="mini-line" style={{ width: '70%' }} />
                          <div className="mini-line" style={{ width: '55%' }} />
                          <div className="mini-line" style={{ width: '80%' }} />
                        </div>
                        <div className="market-card-title">
                          <span className="market-card-name">{tpl.name}</span>
                          <span className="market-card-size">{tpl.sizeLabel}</span>
                        </div>
                      </div>
                      <div className="market-card-desc">{tpl.desc}</div>
                      <div className="market-card-actions">
                        <Button size="small" type="primary" ghost onClick={() => void useTemplate(tpl)}>
                          使用
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
