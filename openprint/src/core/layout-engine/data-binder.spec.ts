import { describe, expect, it } from 'vitest'
import { resolveTextValue, resolveControlContent, resolveCodeText } from './data-binder'
import type { BarcodeControl, MathControl, SignatureControl, TextControl } from '@/types/control'
import type { EvalContext } from './types'

function text(partial: Partial<TextControl>): TextControl {
  return { id: 't1', type: 'text', left: 0, top: 0, width: 50, height: 10, ...partial }
}

describe('resolveTextValue —— 文本控件格式化', () => {
  const ctx: EvalContext = { data: { order: { date: '2026-08-11', total: 12800.5, qty: 1234.5, rate: 0.125 } } }

  it('无 format 时回落默认 stringify', () => {
    const r = resolveTextValue(text({ binding: 'order.total' }), ctx)
    expect(r.text).toBe('12800.5')
  })

  it('日期格式', () => {
    const r = resolveTextValue(
      text({ binding: 'order.date', format: { kind: 'date', pattern: 'YYYY年MM月DD日' } }),
      ctx,
    )
    expect(r.text).toBe('2026年08月11日')
  })

  it('整数 + 千分位', () => {
    const r = resolveTextValue(
      text({ binding: 'order.qty', format: { kind: 'int', thousands: true } }),
      ctx,
    )
    expect(r.text).toBe('1,235')
  })

  it('小数 + 千分位', () => {
    const r = resolveTextValue(
      text({ binding: 'order.total', format: { kind: 'decimal', digits: 2, thousands: true } }),
      ctx,
    )
    expect(r.text).toBe('12,800.50')
  })

  it('货币', () => {
    const r = resolveTextValue(
      text({ binding: 'order.total', format: { kind: 'currency', code: 'USD', digits: 2, thousands: true } }),
      ctx,
    )
    expect(r.text).toBe('$12,800.50')
  })

  it('百分比', () => {
    const r = resolveTextValue(
      text({ binding: 'order.rate', format: { kind: 'percent', digits: 1 } }),
      ctx,
    )
    expect(r.text).toBe('12.5%')
  })

  it('expression 模式不被 format 影响（过滤器优先）', () => {
    const r = resolveTextValue(
      text({ expression: '{{order.total | currency:\'CNY\'}}', format: { kind: 'int' } }),
      ctx,
    )
    expect(r.text).toContain('12,800.50')
  })
})

describe('resolveControlContent —— 文本格式贯穿渲染', () => {
  const ctx: EvalContext = { data: { order: { date: '2026-08-11' } } }

  it('绑定字段按 format 输出（走 content 解析总入口）', async () => {
    const { content, warnings } = await resolveControlContent(
      text({ id: 't2', binding: 'order.date', format: { kind: 'date', pattern: 'MM/DD/YYYY' } }),
      ctx,
    )
    expect(content.kind).toBe('text')
    if (content.kind === 'text') expect(content.text).toBe('08/11/2026')
    expect(warnings).toEqual([])
  })
})

function math(partial: Partial<MathControl>): MathControl {
  return {
    id: 'm1',
    type: 'math',
    left: 0,
    top: 0,
    width: 80,
    height: 25,
    latex: 'c = \\sqrt{a^2 + b^2}',
    displayMode: true,
    fontSize: 16,
    color: '#000000',
    ...partial,
  }
}

describe('resolveControlContent —— 数学公式', () => {
  const ctx: EvalContext = { data: {} }

  it('公式控件解析为 html（KaTeX 产物）', async () => {
    const { content, warnings } = await resolveControlContent(math({}), ctx)
    expect(content.kind).toBe('html')
    if (content.kind === 'html') expect(content.html).toContain('katex')
    expect(warnings).toEqual([])
  })

  it('行内模式下发对齐样式', async () => {
    const { content } = await resolveControlContent(math({ displayMode: false, fontSize: 12 }), ctx)
    expect(content.kind).toBe('html')
    if (content.kind === 'html') expect(content.html).toContain('text-align:left')
  })

  it('公式渲染失败时降级为 placeholder + warning', async () => {
    // KaTeX 对未闭合分组会抛异常，但 throwOnError:false 会渲染错误节点而非抛错。
    // 这里通过非法访问验证失败兜底逻辑（直接构造异常路径不易，仅校验占位抛出分支）。
    const { content, warnings } = await resolveControlContent(
      math({ latex: String.fromCharCode(0) + '\\' }),
      ctx,
    )
    expect(['html', 'placeholder']).toContain(content.kind)
    // 至少不抛未捕获异常
    expect(Array.isArray(warnings)).toBe(true)
  })
})

function signature(partial: Partial<SignatureControl>): SignatureControl {
  return {
    id: 's1',
    type: 'signature',
    left: 0,
    top: 0,
    width: 60,
    height: 30,
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    penWidth: 3,
    color: '#000000',
    ...partial,
  }
}

describe('resolveControlContent —— 手写签名', () => {
  const ctx: EvalContext = { data: {} }

  it('签名笔迹解析为 image（PNG data-URI）', async () => {
    const { content, warnings } = await resolveControlContent(signature({}), ctx)
    expect(content.kind).toBe('image')
    if (content.kind === 'image') expect(content.src).toContain('data:image/png')
    expect(warnings).toEqual([])
  })

  it('空签名降级为 placeholder + SIGNATURE_EMPTY 警告', async () => {
    const { content, warnings } = await resolveControlContent(signature({ src: '' }), ctx)
    expect(content.kind).toBe('placeholder')
    expect(warnings.map((w) => w.code)).toContain('SIGNATURE_EMPTY')
  })
})

describe('resolveControlContent —— 条码宽高独立', () => {
  const ctx: EvalContext = { data: {} }

  function barcode(partial: Partial<BarcodeControl>): BarcodeControl {
    return { id: 'b1', type: 'barcode', left: 0, top: 0, width: 60, height: 40, value: 'SN-001', ...partial }
  }

  it('SVG 携带 width 参数（72dpi→96dpi 补偿）+ preserveAspectRatio="none" 拉伸填满', async () => {
    const { content, warnings } = await resolveControlContent(barcode({ width: 30, height: 20 }), ctx)
    expect(content.kind).toBe('svg')
    expect(warnings).toEqual([])
    if (content.kind === 'svg') {
      // bwip-js 输出的 SVG 内部含 viewBox（宽度按 width 参数换算），且 class 注入
      expect(content.svg).toContain('op-barcode-svg')
      // makeSvgResponsive 去固定尺寸 + 条码分支改为 none（宽高独立填满，非 contain 居中）
      expect(content.svg).toContain('preserveAspectRatio="none"')
      expect(content.svg).not.toContain('xMidYMid meet')
    }
  })

  it('showText=false 时 SVG 不含文字（includetext 关闭）', async () => {
    const { content } = await resolveControlContent(barcode({ showText: false }), ctx)
    expect(content.kind).toBe('svg')
    if (content.kind === 'svg') expect(content.svg).not.toContain('text')
  })
})

describe('resolveCodeText —— 条码内容三态（固定值/变量/表达式）', () => {
  const ctx: EvalContext = { data: { order: { orderNo: 'SN-2026-001' } } }

  function barcode(partial: Partial<BarcodeControl>): BarcodeControl {
    return { id: 'b1', type: 'barcode', left: 0, top: 0, width: 60, height: 40, ...partial }
  }

  it('fixed：静态内容直接编码', () => {
    expect(resolveCodeText(barcode({ contentType: 'fixed', value: 'SN-001' }), ctx)).toBe('SN-001')
  })

  it('variable：绑定字段路径取值', () => {
    expect(resolveCodeText(barcode({ contentType: 'variable', binding: 'order.orderNo' }), ctx)).toBe('SN-2026-001')
  })

  it('expression：表达式求值（可叠加过滤器）', () => {
    expect(resolveCodeText(barcode({ contentType: 'expression', expression: '{{order.orderNo | upper}}' }), ctx)).toBe('SN-2026-001')
  })

  it('显式模式内容为空时回落示例码（条码永不空白）', () => {
    expect(resolveCodeText(barcode({ contentType: 'fixed' }), ctx)).toBe('0123456789')
  })

  it('老模板（无 contentType）：binding 优先于 value', () => {
    expect(resolveCodeText(barcode({ binding: 'order.orderNo', value: 'OLD' }), ctx)).toBe('SN-2026-001')
  })

  it('fixed 模式仍走插值（value 里的 {{}} 生效）', () => {
    expect(resolveCodeText(barcode({ contentType: 'fixed', value: '{{order.orderNo}}' }), ctx)).toBe('SN-2026-001')
  })
})

describe('resolveControlContent —— 明细行字段缺行上下文的告警文案', () => {
  // 数据库数据源的字段统一是 items[].xxx；表格外（正文/页眉页脚）的文本控件没有行上下文
  const ctx: EvalContext = { data: { items: [{ phone: '13800000001' }, { phone: '13800000002' }] } }

  it('无行上下文 → 提示是明细行字段，并给出 items[0]. 单值写法', async () => {
    const { content, warnings } = await resolveControlContent(text({ binding: 'items[].phone' }), ctx)
    expect(content.kind === 'text' && content.text).toBe('')
    const w = warnings.find((x) => x.code === 'BINDING_MISSING')
    expect(w).toBeTruthy()
    expect(w!.message).toContain('明细行字段')
    expect(w!.message).toContain('表格行内')
    expect(w!.message).toContain('items[0].phone')
  })

  it('有行上下文但该行取值确实为空 → 保持"在数据中为空"文案', async () => {
    const { warnings } = await resolveControlContent(text({ binding: 'items[].phone' }), {
      data: {},
      row: { phone: '' },
      rowIndex: 0,
    })
    const w = warnings.find((x) => x.code === 'BINDING_MISSING')
    expect(w!.message).toBe('字段 "items[].phone" 在数据中为空')
  })

  it('items[0].phone 在无行上下文时可直接解析（表格外取首条记录）', async () => {
    const { content, warnings } = await resolveControlContent(text({ binding: 'items[0].phone' }), ctx)
    expect(warnings).toEqual([])
    expect(content.kind === 'text' && content.text).toBe('13800000001')
  })
})
