import { describe, expect, it } from 'vitest'

import { buildRawPayloadObject, sanitizeTemplate } from './raw-sanitize'
import { createDemoTemplate } from '@/repository/mock/data/demo-template'
import type { AnyControl, TableControl, TextControl } from '@/types/control'

/** 构造一个塞满样式字段的文本控件（字体样式/颜色/元数据/渲染装饰应有尽有） */
function richText(): TextControl {
  return {
    id: 't1',
    type: 'text',
    left: 10,
    top: 20,
    width: 80,
    height: 12,
    angle: 90,
    printable: false,
    visibleIf: 'data.vip === true',
    // 设计器元数据：应被删除
    locked: true,
    name: '客户名称',
    showGuides: true,
    childOf: 'grid~card~0',
    // 内容三态：应保留
    contentType: 'variable',
    binding: 'customer.name',
    format: { kind: 'date', pattern: 'YYYY-MM-DD' },
    // 样式：fontSize/textAlign 保留，字体样式与颜色删除
    style: {
      fontSize: 12,
      textAlign: 'center',
      fill: '#ff0000',
      fontFamily: 'Source Han Sans CN',
      fontWeight: 'bold',
      fontStyle: 'italic',
      textDecoration: 'underline',
      lineHeight: 1.5,
      letterSpacing: 2,
    },
  }
}

/** 带样式污染的表格控件 */
function richTable(): TableControl {
  return {
    id: 'tb1',
    type: 'table',
    left: 0,
    top: 0,
    width: 190,
    height: 100,
    dataSource: 'items',
    columns: [
      {
        title: '名称',
        field: 'name',
        width: 80,
        align: 'left',
        aggregate: false,
        cellBackgroundColor: '#f5f5f5',
        style: { fontSize: 9, align: 'center', fontFamily: 'Arial', bold: true, color: '#333' },
      },
    ],
    options: {
      repeatHeader: true,
      borders: 'all',
      striped: true,
      defaultCellStyle: { fontSize: 9, backgroundColor: '#eee', italic: true },
      summaryRow: {
        type: 'sum',
        fields: ['qty'],
        label: '合计',
        subtotalStyle: { fontSize: 10, bold: true, backgroundColor: '#ddd' },
      },
    },
    cells: [
      [
        { text: '表头', colSpan: 2, style: { fontSize: 10, align: 'center', underline: true, color: '#111' } },
        { field: 'qty', contentType: 'variable', format: { kind: 'int' }, style: { align: 'right' } },
      ],
    ],
    headerRows: 1,
  }
}

describe('raw-sanitize —— 指令直通画布 JSON 净化', () => {
  it('文本控件：删除字体样式 / 颜色 / 设计器元数据，保留几何 / 内容 / 字号 / 对齐', () => {
    const out = sanitizeTemplate({
      version: '1.0',
      document: { type: 'report', page: { width: 210, height: 297, unit: 'mm', orientation: 'portrait', margin: { top: 5, right: 5, bottom: 5, left: 5 } }, sections: [{ type: 'body', components: [richText()] }] },
    })
    const c = out.document.sections[0]!.components[0] as TextControl

    // 保留
    expect(c.id).toBe('t1')
    expect(c.left).toBe(10)
    expect(c.angle).toBe(90)
    expect(c.printable).toBe(false)
    expect(c.visibleIf).toBe('data.vip === true')
    expect(c.contentType).toBe('variable')
    expect(c.binding).toBe('customer.name')
    expect(c.format).toEqual({ kind: 'date', pattern: 'YYYY-MM-DD' })
    expect(c.style).toEqual({ fontSize: 12, textAlign: 'center' })

    // 删除
    expect(c.style).not.toHaveProperty('fill')
    expect(c.style).not.toHaveProperty('fontFamily')
    expect(c.style).not.toHaveProperty('fontWeight')
    expect(c.style).not.toHaveProperty('fontStyle')
    expect(c.style).not.toHaveProperty('textDecoration')
    expect(c.style).not.toHaveProperty('lineHeight')
    expect(c.style).not.toHaveProperty('letterSpacing')
    expect(c).not.toHaveProperty('locked')
    expect(c).not.toHaveProperty('name')
    expect(c).not.toHaveProperty('showGuides')
    expect(c).not.toHaveProperty('childOf')
  })

  it('表格：递归净化 columns/cells/options 样式，保留结构与语义', () => {
    const out = sanitizeTemplate({
      version: '1.0',
      document: { type: 'report', page: { width: 210, height: 297, unit: 'mm', orientation: 'portrait', margin: { top: 5, right: 5, bottom: 5, left: 5 } }, sections: [{ type: 'body', components: [richTable()] }] },
    })
    const t = out.document.sections[0]!.components[0] as TableControl

    // 结构保留
    expect(t.dataSource).toBe('items')
    expect(t.columns[0]).toMatchObject({ title: '名称', field: 'name', width: 80, align: 'left', aggregate: false })
    expect(t.options).toMatchObject({ repeatHeader: true, borders: 'all' })
    expect(t.cells![0]![0]).toMatchObject({ text: '表头', colSpan: 2 })
    expect(t.cells![0]![1]).toMatchObject({ field: 'qty', contentType: 'variable', format: { kind: 'int' } })

    // 列样式净化：fontSize/align 留，字体/颜色删
    expect(t.columns[0]!.style).toEqual({ fontSize: 9, align: 'center' })
    expect(t.columns[0]).not.toHaveProperty('cellBackgroundColor')

    // 选项样式净化
    expect(t.options!.defaultCellStyle).toEqual({ fontSize: 9 })
    expect(t.options!.summaryRow!.subtotalStyle).toEqual({ fontSize: 10 })
    expect(t.options!).not.toHaveProperty('striped')

    // 单元格样式净化
    expect(t.cells![0]![0]!.style).toEqual({ fontSize: 10, align: 'center' })
    expect(t.cells![0]![1]!.style).toEqual({ align: 'right' })
  })

  it('页面设置：删除 backgroundColor / watermark / minPages，保留尺寸 / 边距', () => {
    const out = sanitizeTemplate({
      version: '1.0',
      document: {
        type: 'report',
        page: {
          width: 80,
          height: 60,
          unit: 'mm',
          orientation: 'landscape',
          margin: { top: 2, right: 2, bottom: 2, left: 2 },
          backgroundColor: '#ffffff',
          watermark: { enabled: true, text: '内部资料', color: '#ccc', fontSize: 20, rotation: 45, tile: true },
          minPages: 2,
        },
        sections: [],
      },
    })
    const page = out.document.page as unknown as Record<string, unknown>
    expect(page.width).toBe(80)
    expect(page.margin).toEqual({ top: 2, right: 2, bottom: 2, left: 2 })
    expect(page).not.toHaveProperty('backgroundColor')
    expect(page).not.toHaveProperty('watermark')
    expect(page).not.toHaveProperty('minPages')
  })

  it('buildRawPayloadObject：平铺无 template 包裹层，data 原样保留，样式已净化', () => {
    const template = createDemoTemplate()
    const request = { template, data: { order: { orderNo: 'SO-001' }, items: [{ name: 'A', qty: 1 }] } }
    const obj = buildRawPayloadObject(request)

    expect(obj).not.toHaveProperty('template')
    expect(obj).not.toHaveProperty('output')
    expect(obj.version).toBe(template.version)
    expect(obj.data).toEqual(request.data)
    // 模板内的组件已走净化（demo 模板若有字体字段应被剔除）
    const body = (obj.document as { sections: Array<{ type: string; components: AnyControl[] }> }).sections.find((s) => s.type === 'body')
    for (const c of body?.components ?? []) {
      expect(c).not.toHaveProperty('locked')
      expect(c).not.toHaveProperty('name')
      expect(c).not.toHaveProperty('showGuides')
      expect(c).not.toHaveProperty('childOf')
    }
  })
})
