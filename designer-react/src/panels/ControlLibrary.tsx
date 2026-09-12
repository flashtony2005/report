/**
 * ControlLibrary —— 可拖拽控件源（控件库面板）
 * 卡片可拖拽入画布；页眉/页脚为点击插入（单例）；未开放的类型置灰。
 * 对齐 Vue 版 ControlLibrary.vue（分类目录与点击/拖拽行为逐行等价）。
 */
import { useMemo, useState } from 'react'
import { Input } from 'antd'
import type { AnyControl, ControlType } from '@/types/control'
import { startControlDrag } from '@/design/hooks/control-drag'
import { useDesignerStore } from '../stores/designer'
import './control-library.css'

interface ControlItem {
  type: ControlType | 'zone-header' | 'zone-footer' | 'pageno' | 'pagebreak' | 'condblock' | 'datablock' | 'circle' | 'labelgrid'
  label: string
  icon: string
  disabled?: boolean
  /** 拖入/插入时的初始属性补丁（如圆形 shape） */
  init?: Partial<AnyControl>
}

interface Category {
  name: string
  items: ControlItem[]
}

const CATEGORIES: Category[] = [
  {
    name: '常用组件',
    items: [
      { type: 'text', label: '文本', icon: 'T' },
      { type: 'image', label: '图片', icon: '🖼' },
      { type: 'barcode', label: '条码', icon: '|||' },
      { type: 'qrcode', label: '二维码', icon: '▣' },
      { type: 'rect', label: '矩形', icon: '□' },
      { type: 'circle', label: '圆形', icon: '○', init: { shape: 'circle' } as never },
      { type: 'line', label: '线条', icon: '—' },
      { type: 'table', label: '表格', icon: '▦' },
    ],
  },
  {
    name: '布局组件',
    items: [
      { type: 'zone-header', label: '页眉', icon: '⌐' },
      { type: 'zone-footer', label: '页脚', icon: '⌐' },
      { type: 'pageno', label: '页码', icon: '№' },
      { type: 'labelgrid', label: '标签网格', icon: '▦' },
    ],
  },
  {
    name: '高级组件',
    items: [
      { type: 'richtext', label: '富文本', icon: '¶' },
      { type: 'math', label: '公式', icon: '∑' },
      { type: 'signature', label: '签名', icon: '✎' },
    ],
  },
  {
    name: '图表组件',
    items: [
      { type: 'chart', label: '条形图', icon: '▮▮', init: { kind: 'bar' as const } as never },
      { type: 'chart', label: '折线图', icon: '〰', init: { kind: 'line' as const } as never },
      { type: 'chart', label: '饼图', icon: '◕', init: { kind: 'pie' as const } as never },
    ],
  },
  {
    name: '业务组件',
    items: [
      { type: 'pagebreak', label: '分页符', icon: '▭', disabled: true },
      { type: 'condblock', label: '条件块', icon: '⑂', disabled: true },
      { type: 'datablock', label: '数据块', icon: '◆', disabled: true },
    ],
  },
]

/** 拖拽时的类型映射：圆形/页码复用已有类型（与 Vue 版 onDragStart 等价） */
function dragTypeOf(item: ControlItem): ControlType {
  if (item.type === 'zone-header' || item.type === 'zone-footer') return 'zone'
  if (item.type === 'circle') return 'rect'
  if (item.type === 'pageno') return 'text'
  return item.type as ControlType
}

function dragInitOf(item: ControlItem): Partial<AnyControl> | undefined {
  if (item.type === 'pageno') return { value: '{{page}}', name: '页码' } as never
  if (item.type === 'zone-header') return { zone: 'header' as const } as never
  if (item.type === 'zone-footer') return { zone: 'footer' as const } as never
  return item.init
}

export default function ControlLibrary() {
  const [keyword, setKeyword] = useState('')

  const filtered = useMemo(() => {
    const kw = keyword.trim()
    if (!kw) return CATEGORIES
    return CATEGORIES.map((c) => ({ ...c, items: c.items.filter((i) => i.label.includes(kw)) })).filter(
      (c) => c.items.length > 0,
    )
  }, [keyword])

  const onDragStart = (e: React.DragEvent, item: ControlItem): void => {
    if (item.disabled) return
    startControlDrag(e.nativeEvent, dragTypeOf(item), dragInitOf(item))
  }

  const onClick = (item: ControlItem): void => {
    if (item.disabled) return
    const store = useDesignerStore.getState()
    if (item.type === 'zone-header') store.addZone('header')
    else if (item.type === 'zone-footer') store.addZone('footer')
    else if (item.type === 'circle') {
      // 圆形点击插入到内容区默认位置（复用 rect 类型 + shape 补丁）
      store.addControlOfType('rect', { leftMm: 60, topMm: 60 }, { shape: 'circle' } as never)
    } else if (item.type === 'pageno') {
      // 页码 = 文本控件 + {{page}} 页码变量（分页引擎每页注入）
      store.addControlOfType('text', { leftMm: 60, topMm: 60 }, { value: '{{page}}', name: '页码' } as never)
    } else if (item.type === 'richtext') {
      store.addControlOfType('richtext', { leftMm: 60, topMm: 60 })
    } else if (item.type === 'chart') {
      store.addControlOfType('chart', { leftMm: 60, topMm: 60 }, item.init)
    } else if (item.type === 'math') {
      store.addControlOfType('math', { leftMm: 60, topMm: 60 })
    } else if (item.type === 'signature') {
      // 签名：打开弹出式手写画板（WPS 式），确认后插入主画布
      store.openSignaturePad()
    } else if (item.type === 'labelgrid') {
      store.addControlOfType('labelgrid', { leftMm: 60, topMm: 60 })
    }
  }

  return (
    <div className="ctrl-lib">
      <div className="ctrl-lib-search">
        <Input size="small" placeholder="搜索组件" allowClear value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      </div>
      <div className="ctrl-lib-scroll">
        <div className="ctrl-lib-body">
          {filtered.map((cat) => (
            <div key={cat.name} className="ctrl-lib-cat">
              <div className="ctrl-lib-cat-name">{cat.name}</div>
              <div className="ctrl-lib-grid">
                {cat.items.map((item) => (
                  <div
                    key={`${item.type}-${item.label}`}
                    className={`control-card${item.disabled ? ' is-disabled' : ''}`}
                    draggable={!item.disabled}
                    onDragStart={(e) => onDragStart(e, item)}
                    onClick={() => onClick(item)}
                  >
                    <div className="control-card-icon">{item.icon}</div>
                    <div className="control-card-label">{item.label}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
