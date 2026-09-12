/**
 * createHttpRepository —— 云端模板仓库（《后端对接规范》§4.1）
 *
 * 对接 `/api/print/templates`：
 *   GET    /api/print/templates            → 列表（{items,total}，不含 content）
 *   GET    /api/print/templates/{id}       → 详情（含 content，即 TemplateJSON 字符串）
 *   POST   /api/print/templates            → 创建（201 + 真实 id）
 *   PUT    /api/print/templates/{id}       → 全量更新（覆盖保存，200）
 *   DELETE /api/print/templates/{id}       → 物理删除（204 无 body）
 *
 * 与 createLocalRepository 同一 TemplateRepository 接口，可无缝替换。
 * content ⇄ TemplateData 互转：前端始终以 JSON 对象流转，落库为字符串（MEDIUMTEXT）原样往返。
 */
import { HttpClient, HttpError, type HttpOptions } from './http-client'
import type { TemplateRecord, TemplateRepository, TemplateSummary } from './types'
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'

/** 后端返回的资源元信息（含运行时计算的 permissions，见 §2.6） */
interface RawPermission {
  editable?: boolean
  deletable?: boolean
  copyable?: boolean
}

interface RawSummary {
  id: string
  name: string
  code?: string
  category?: string
  visibility?: 'public' | 'private'
  createdBy?: string
  createdAt?: string
  updatedBy?: string
  updatedAt?: string
  permissions?: RawPermission
}

interface RawRecord extends RawSummary {
  /** 模板内容（MEDIUMTEXT 字符串）；个别后端可能用 spec 字段名，两者兼容 */
  content?: string
  spec?: string
  /** 若后端直接返回对象（未序列化为字符串）时的兜底 */
  data?: TemplateData<AnyControl>
}

const BASE = '/api/print/templates'

function parseData(raw: RawRecord): TemplateData<AnyControl> {
  const content = raw.content ?? raw.spec
  if (content) return JSON.parse(content) as TemplateData<AnyControl>
  if (raw.data) return raw.data
  throw new Error(`模板 ${raw.id} 缺少 content 字段`)
}

function mapSummary(r: RawSummary): TemplateSummary {
  return {
    id: r.id,
    name: r.name,
    editable: r.permissions?.editable ?? true,
    deletable: r.permissions?.deletable ?? true,
    updatedAt: r.updatedAt,
  }
}

function mapRecord(r: RawRecord): TemplateRecord {
  return {
    id: r.id,
    name: r.name,
    editable: r.permissions?.editable ?? true,
    deletable: r.permissions?.deletable ?? true,
    updatedAt: r.updatedAt,
    data: parseData(r),
  }
}

export function createHttpRepository(opts: HttpOptions): TemplateRepository {
  const client = new HttpClient(opts)

  return {
    async list() {
      const items = await client.list<RawSummary>(BASE)
      return items.map(mapSummary)
    },

    async get(id) {
      const r = await client.json<RawRecord>(`${BASE}/${encodeURIComponent(id)}`)
      if (!r) return null
      return mapRecord(r)
    },

    async create(record) {
      const r = await client.json<RawRecord>(BASE, {
        method: 'POST',
        body: JSON.stringify({
          name: record.name,
          // 仅存模板内容；visibility 等后端可按默认策略处理
          content: JSON.stringify(record.data),
        }),
      })
      if (!r) throw new HttpError('创建模板失败：后端未返回数据', { status: 201 })
      return mapRecord(r)
    },

    async update(id, record) {
      const body: Record<string, unknown> = {}
      if (record.name !== undefined) body.name = record.name
      if (record.data !== undefined) body.content = JSON.stringify(record.data)
      const r = await client.json<RawRecord>(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      if (!r) throw new HttpError('更新模板失败：后端未返回数据', { status: 200 })
      return mapRecord(r)
    },

    async remove(id) {
      await client.json(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}
