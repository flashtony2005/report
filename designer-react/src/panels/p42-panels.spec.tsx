/**
 * P4.2 面板冒烟 —— Shape / Chart / LabelGrid / Table（React 端到端）
 *
 * 链路：store 造控件 → 渲染面板 → antd 交互 → 断言 store 写回。
 * 共享逻辑（shape/chart/label-grid/table-props-logic）的行为断言在
 * Vue 端 props-logic-p4.spec.ts（33 用例），此处复核 import 链与交互。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import type { ChartControl, LabelGridControl, LineControl, RectControl, TableControl } from '@/types/control'
import { useDesignerStore } from '../stores/designer'
import { useDataSourceStore, selectFlatFields } from '../stores/dataSource'

const body = () => document.body

/** 用原生 setter 触发受控 textarea / input 的 input 事件 */
function typeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function firstSelected(): string {
  return useDesignerStore.getState().controls[0]!.id
}

describe('P4.2 面板', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(() => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useDesignerStore.getState().$reset()
  })

  // 每棵树渲染完必须卸载：body.innerHTML='' 只摘 DOM，React 侧任务仍在，
  // 环境拆除后触碰 window 会报 ReferenceError
  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })

  describe('ShapeProps', () => {
    beforeEach(() => {
      useDesignerStore.getState().addControlOfType('rect', { leftMm: 10, topMm: 10 })
      useDesignerStore.getState().selectControl(firstSelected())
    })

    it('渲染矩形样式，切圆形后强制正方形', async () => {
      const { default: ShapeProps } = await import('./props/ShapeProps')
      await act(async () => {
        root.render(createElement(ShapeProps))
      })
      expect(body().textContent).toContain('矩形样式')

      // antd Select：点开下拉再点「圆形」
      const select = body().querySelector('.ant-select')!
      await act(async () => {
        select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })
      const option = [...body().querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
        (o) => o.textContent === '圆形',
      )
      expect(option, '圆形选项存在').toBeTruthy()
      await act(async () => {
        option!.click()
      })
      const ctl = useDesignerStore.getState().controls[0] as RectControl
      expect(ctl.shape).toBe('circle')
      expect(ctl.width).toBe(ctl.height)
      expect(body().textContent).toContain('圆形样式')
    })

    it('虚线开关写回 strokeDashArray', async () => {
      const { default: ShapeProps } = await import('./props/ShapeProps')
      await act(async () => {
        root.render(createElement(ShapeProps))
      })
      const sw = body().querySelector<HTMLButtonElement>('.ant-switch')!
      await act(async () => {
        sw.click()
      })
      const ctl = useDesignerStore.getState().controls[0] as LineControl | RectControl
      expect(ctl.strokeDashArray).toEqual([6, 4])
    })
  })

  describe('ChartProps', () => {
    beforeEach(() => {
      useDesignerStore.getState().addControlOfType('chart', { leftMm: 10, topMm: 10 })
      useDesignerStore.getState().selectControl(firstSelected())
    })

    it('类目多行文本写回并同步对齐序列数据长度', async () => {
      const { default: ChartProps } = await import('./props/ChartProps')
      await act(async () => {
        root.render(createElement(ChartProps))
      })
      expect(body().textContent).toContain('图表类型')
      expect(body().textContent).toContain('数据序列')

      const tas = [...body().querySelectorAll<HTMLTextAreaElement>('textarea')]
      // 第一个 textarea 是类目编辑框
      const catTa = tas[0]!
      await act(async () => {
        typeValue(catTa, '甲\n乙\n丙')
      })
      const ctl = useDesignerStore.getState().controls[0] as ChartControl
      expect(ctl.categories).toEqual(['甲', '乙', '丙'])
      // 序列数据长度对齐到 3（缺位补 0）
      for (const s of ctl.series) expect(s.data).toHaveLength(3)
    })

    it('「+ 序列」按钮追加一条序列', async () => {
      const { default: ChartProps } = await import('./props/ChartProps')
      await act(async () => {
        root.render(createElement(ChartProps))
      })
      const before = (useDesignerStore.getState().controls[0] as ChartControl).series.length
      const addBtn = [...body().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent!.includes('+ 序列'),
      )
      expect(addBtn, '加序列按钮存在').toBeTruthy()
      await act(async () => {
        addBtn!.click()
      })
      const after = (useDesignerStore.getState().controls[0] as ChartControl).series.length
      expect(after).toBe(before + 1)
    })
  })

  describe('LabelGridProps', () => {
    beforeEach(() => {
      useDesignerStore.getState().addControlOfType('labelgrid', { leftMm: 10, topMm: 10 })
      useDesignerStore.getState().selectControl(firstSelected())
    })

    it('渲染布局控制台并展示列数/卡宽', async () => {
      const { default: LabelGridProps } = await import('./props/LabelGridProps')
      await act(async () => {
        root.render(createElement(LabelGridProps))
      })
      const text = body().textContent!
      expect(text).toContain('标签网格')
      expect(text).toContain('显示网格线')
      expect(text).toContain('卡片贴合内容')
      expect(text).toContain('每页')
    })

    it('清空首卡：clearLabelGridChildren 写回 store', async () => {
      const store = useDesignerStore.getState()
      const grid = store.controls[0] as LabelGridControl
      // 直接写首卡子元素（等价于画布拖入后的 store 状态）
      store.setLabelGridChildren(grid.id, [
        { id: 'lg-child-1', type: 'text', leftMm: 1, topMm: 1, width: 10, height: 5, value: 'X' } as never,
      ])
      expect(((useDesignerStore.getState().controls[0] as LabelGridControl).children ?? []).length).toBe(1)

      const { default: LabelGridProps } = await import('./props/LabelGridProps')
      await act(async () => {
        root.render(createElement(LabelGridProps))
      })
      expect(body().textContent).toContain('首卡元素')
      const clearBtn = [...body().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent!.includes('清空首卡'),
      )
      await act(async () => {
        clearBtn!.click()
      })
      expect((useDesignerStore.getState().controls[0] as LabelGridControl).children).toHaveLength(0)
    })
  })

  describe('TableProps', () => {
    beforeEach(() => {
      useDesignerStore.getState().addControlOfType('table', { leftMm: 10, topMm: 10 })
      useDesignerStore.getState().selectControl(firstSelected())
    })

    it('渲染核心开关与列配置，关「每页打印标题行」写回 options', async () => {
      const { default: TableProps } = await import('./props/TableProps')
      await act(async () => {
        root.render(createElement(TableProps))
      })
      const text = body().textContent!
      expect(text).toContain('数据设置')
      expect(text).toContain('核心开关')
      expect(text).toContain('列配置')
      expect(text).toContain('默认单元格样式')

      // 第一个 switch = 每页打印标题行
      const sw = body().querySelector<HTMLButtonElement>('.ant-switch')!
      await act(async () => {
        sw.click()
      })
      const ctl = useDesignerStore.getState().controls[0] as TableControl
      expect(ctl.options?.repeatHeader).toBe(false)
    })

    it('「+ 添加列」走 table-cells 纯函数写回', async () => {
      const { default: TableProps } = await import('./props/TableProps')
      await act(async () => {
        root.render(createElement(TableProps))
      })
      const before = (useDesignerStore.getState().controls[0] as TableControl).columns.length
      const addCol = [...body().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent!.includes('+ 添加列'),
      )
      expect(addCol, '加列按钮存在').toBeTruthy()
      await act(async () => {
        addCol!.click()
      })
      const after = (useDesignerStore.getState().controls[0] as TableControl).columns.length
      expect(after).toBe(before + 1)
    })

    /* 回归：用户报「数据设置 → 数据源 下拉里全是列、没有表」。
       表格数据源必须是数组路径（table-engine 的 resolveRows 强制 Array.isArray），
       所以这里只能给「数组表」，不能给 items[].列名。 */
    it('「数据设置 → 数据源」下拉列的是「表（数组）」而不是「列」', async () => {
      useDataSourceStore.setState({ kind: 'sample' } as never)
      await act(async () => {
        await useDataSourceStore.getState().init()
      })
      // 前提：字段列表里确实一堆列（旧实现就是把它喂给了数据源下拉）
      const flat = selectFlatFields(useDataSourceStore.getState())
      expect(flat.some((f) => f.path.includes('[].')), '前提：存在明细列字段').toBe(true)

      const { default: TableProps } = await import('./props/TableProps')
      await act(async () => {
        root.render(createElement(TableProps))
      })

      // 首节「数据设置 → 数据源」就是这个 Select
      const select = body().querySelector('.ant-select')!
      await act(async () => {
        select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })
      const opts = [...body().querySelectorAll<HTMLElement>('.ant-select-item-option')].map(
        (o) => o.textContent!,
      )
      const joined = opts.join(' | ')
      expect(joined, '含明细表').toContain('订单明细')
      expect(joined, '含表路径 items[]').toContain('items[]')
      expect(
        opts.some((t) => t.includes('[].')),
        `下拉里不能出现列路径（实际：${joined}）`,
      ).toBe(false)
    })
  })

  describe('TableStylePickerModal', () => {
    it('渲染样式卡片网格并点选回写', async () => {
      const { default: TableStylePickerModal } = await import('./props/TableStylePickerModal')
      let picked = ''
      await act(async () => {
        root.render(
          createElement(TableStylePickerModal, {
            show: true,
            current: 'none',
            onCancel: () => undefined,
            onSelect: (k: string) => {
              picked = k
            },
          }),
        )
      })
      const cards = [...body().querySelectorAll<HTMLButtonElement>('button.style-card')]
      expect(cards.length).toBeGreaterThan(2)
      expect(body().textContent).toContain('全网格')
      await act(async () => {
        cards.find((c) => c.textContent!.includes('全网格'))!.click()
      })
      expect(picked).toBe('grid')
    })
  })
})
