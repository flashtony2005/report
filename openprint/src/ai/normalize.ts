/**
 * AI 输出归一化 —— 把模型返回的「接近协议」的 JSON 修成可通过校验的 TemplateData。
 * 设计器 loadTemplate 也会兜底缺 id，这里提前补齐让校验更稳。
 *
 * ⚠️ **丢弃必须上报。** 早先这里对白名单外的类型直接 `return null`、调用方 `.filter` 掉，
 * 于是「AI 看不懂的控件」与「AI 主动删掉的控件」在下游长得一模一样：
 * `diffSelectedControls` 把前者算进 `removedIds` → `removeControl` **真把用户的控件删了**，
 * 还弹绿色成功。现在丢什么、为什么丢，一律写进 `dropped` 交回调用方。
 */
import type { AnyControl, ControlType } from '@/types/control'
import type { TemplateData } from '@/types/template'

/** AI 层能处理（能补齐字段、能安全回写画布）的控件类型。
 *  比 `ControlType` 窄是**刻意的**：这里没有的类型不是「不支持协议」，
 *  而是「AI 不理解它的载荷，别碰」。窄不要紧，**静默丢才要紧**。 */
export const VALID_TYPES: ControlType[] = [
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

/**
 * 归一化过程中被丢掉的东西。**必填通道，不是日志。**
 *
 * 有了它，调用方才能区分两种「没出现在结果里」：
 *   - 模型**故意**没返回（用户让它删）→ 可以删；
 *   - 我们**看不懂**所以丢了（在 `dropped` 里）→ **绝不能删**，要保持原样。
 */
export interface DroppedItem {
  /** 丢的是控件还是整节 */
  kind: 'control' | 'section'
  /** 原始 type。可能是任意字符串（未知类型），所以是 string 而不是 ControlType */
  type: string
  /** 原始 id（模型给了就带上）—— 调用方据此认出「这是我选中的那个」 */
  id?: string
  /** 为什么丢（给人看，也回喂给模型重试） */
  reason: string
}

/** 归一化结果：值 + 丢掉了什么。分开返回，让「忽略 dropped」写不出来。 */
export interface NormalizeResult<T> {
  value: T
  dropped: DroppedItem[]
}

function genId(prefix = 'ctrl'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function typeName(v: unknown): string {
  if (typeof v === 'string') return v
  return v === undefined ? '(缺 type)' : String(v)
}

/**
 * 归一化单个控件。
 *
 * `dropped` **必填**（不是可选）：让「我不管丢弃」在类型层面就写不出来 ——
 * 传一个数组进来，丢的时候必须往里写。
 */
export function normalizeControl(
  raw: Record<string, unknown>,
  dropped: DroppedItem[],
): AnyControl | null {
  const type = raw.type as ControlType
  if (!VALID_TYPES.includes(type)) {
    dropped.push({
      kind: 'control',
      type: typeName(raw.type),
      ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
      reason:
        `控件类型「${typeName(raw.type)}」不在 AI 可处理的类型里` +
        `（可用：${VALID_TYPES.join(' / ')}），该控件已跳过。`,
    })
    return null
  }
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

function normalizeSection(
  raw: Record<string, unknown>,
  dropped: DroppedItem[],
): Record<string, unknown> | null {
  const type = raw.type
  if (type !== 'header' && type !== 'body' && type !== 'footer') {
    // 整节丢掉同样是静默的：一份「body + 一个 type 拼错的节」照样能过校验，
    // 错的那节凭空消失。一并上报。
    dropped.push({
      kind: 'section',
      type: typeName(raw.type),
      reason: `节类型「${typeName(raw.type)}」不是 header / body / footer，该节已跳过。`,
    })
    return null
  }
  const components = Array.isArray(raw.components)
    ? (raw.components as Record<string, unknown>[])
        .map((c) => normalizeControl(c, dropped))
        .filter((c): c is AnyControl => c !== null)
    : []
  return {
    type,
    ...(type !== 'body' ? { height: num(raw.height, 20) } : {}),
    repeat: raw.repeat === false ? false : true,
    components,
  }
}

/** 归一化整份模板。返回 `{ value, dropped }` —— 丢弃不吞掉。 */
export function normalizeTemplate(raw: unknown): NormalizeResult<TemplateData<AnyControl>> {
  const dropped: DroppedItem[] = []
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const doc = (obj.document && typeof obj.document === 'object'
    ? obj.document
    : {}) as Record<string, unknown>
  const page = (doc.page && typeof doc.page === 'object' ? doc.page : {}) as Record<string, unknown>
  const sectionsRaw = Array.isArray(doc.sections) ? (doc.sections as Record<string, unknown>[]) : []

  const sections = sectionsRaw
    .map((s) => normalizeSection(s, dropped))
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
  return { value: normalized, dropped }
}
