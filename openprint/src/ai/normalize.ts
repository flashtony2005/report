/**
 * AI 输出归一化 —— 把模型返回的「接近协议」的 JSON 修成可通过校验的 TemplateData。
 * 设计器 loadTemplate 也会兜底缺 id，这里提前补齐让校验更稳。
 */
import type { AnyControl, ControlType } from '@/types/control'
import type { TemplateData } from '@/types/template'

const VALID_TYPES: ControlType[] = [
  'text',
  'image',
  'table',
  'barcode',
  'qrcode',
  'richtext',
  'rect',
  'line',
  'zone',
]

function genId(prefix = 'ctrl'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

export function normalizeControl(raw: Record<string, unknown>): AnyControl | null {
  const type = raw.type as ControlType
  if (!VALID_TYPES.includes(type)) return null
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId(type),
    type,
    left: round1(num(raw.left, 0)),
    top: round1(num(raw.top, 0)),
    width: round1(Math.max(num(raw.width, 10), 1)),
    height: round1(Math.max(num(raw.height, 6), 1)),
  }
  const extra: Record<string, unknown> = { ...raw }
  delete extra.id
  delete extra.type
  delete extra.left
  delete extra.top
  delete extra.width
  delete extra.height
  return { ...base, ...extra } as AnyControl
}

function normalizeSection(raw: Record<string, unknown>): Record<string, unknown> | null {
  const type = raw.type
  if (type !== 'header' && type !== 'body' && type !== 'footer') return null
  const components = Array.isArray(raw.components)
    ? (raw.components as Record<string, unknown>[])
        .map(normalizeControl)
        .filter((c): c is AnyControl => c !== null)
    : []
  return {
    type,
    ...(type !== 'body' ? { height: num(raw.height, 20) } : {}),
    repeat: raw.repeat === false ? false : true,
    components,
  }
}

/** 归一化整份模板 */
export function normalizeTemplate(raw: unknown): TemplateData<AnyControl> {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const doc = (obj.document && typeof obj.document === 'object'
    ? obj.document
    : {}) as Record<string, unknown>
  const page = (doc.page && typeof doc.page === 'object' ? doc.page : {}) as Record<string, unknown>
  const sectionsRaw = Array.isArray(doc.sections) ? (doc.sections as Record<string, unknown>[]) : []

  const sections = sectionsRaw
    .map(normalizeSection)
    .filter((s): s is Record<string, unknown> => s !== null)

  // 至少保证有一个 body
  if (!sections.some((s) => s.type === 'body')) {
    sections.push({ type: 'body', components: [] })
  }

  // —— 坐标纠偏：把「相对页面(page-origin)」的 AI 输出还原为「相对内容区(content-relative)」 ——
  // 触发条件：某节内控件的最小 left 接近 margin.left 且最小 top 接近 margin.top（即模型把页边距也算进了坐标）。
  // 此时统一减去页边距，避免整页内容向右下偏移一个 margin。正确生成的模板 minLeft/minTop≈0，不会触发。
  const ml = num((page.margin as Record<string, unknown>)?.left, 10)
  const mt = num((page.margin as Record<string, unknown>)?.top, 10)
  const EPS = 2
  for (const section of sections) {
    const comps = (section.components as AnyControl[] | undefined) ?? []
    if (!comps.length) continue
    const minLeft = Math.min(...comps.map((c) => c.left))
    const minTop = Math.min(...comps.map((c) => c.top))
    if (minLeft > 1 && Math.abs(minLeft - ml) <= EPS && minTop > 1 && Math.abs(minTop - mt) <= EPS) {
      for (const c of comps) {
        c.left = round1(c.left - ml)
        c.top = round1(c.top - mt)
      }
    }
  }

  const width = num(page.width, 210)
  const height = num(page.height, 297)

  const normalized: TemplateData<AnyControl> = {
    version: typeof obj.version === 'string' ? obj.version : '1.0.0',
    document: {
      type: 'report',
      page: {
        width,
        height,
        unit: page.unit === 'in' || page.unit === 'pt' ? page.unit : 'mm',
        orientation:
          page.orientation === 'landscape' || width > height ? 'landscape' : 'portrait',
        margin: {
          top: num((page.margin as Record<string, unknown>)?.top, 10),
          bottom: num((page.margin as Record<string, unknown>)?.bottom, 10),
          left: num((page.margin as Record<string, unknown>)?.left, 10),
          right: num((page.margin as Record<string, unknown>)?.right, 10),
        },
        ...(typeof page.backgroundColor === 'string'
          ? { backgroundColor: page.backgroundColor }
          : {}),
      },
      sections: sections as unknown as TemplateData<AnyControl>['document']['sections'],
    },
  }
  return normalized
}
