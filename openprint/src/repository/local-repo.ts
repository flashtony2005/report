/**
 * createLocalRepository —— localStorage 模板仓库
 *
 * 未配置后端接口时的默认持久化实现（2026-08-08 主任定：无后端全链路可用）。
 * 与未来 http-repo 同一 TemplateRepository 接口，可无缝替换。
 *
 * 存储结构：
 * - `openprint:templates`        → TemplateSummary[]（列表索引）
 * - `openprint:template:{id}`    → TemplateRecord（完整数据）
 */
import type { TemplateRecord, TemplateRepository, TemplateSummary } from './types'
import { genId } from '@/utils/id'

const INDEX_KEY = 'openprint:templates'
const RECORD_PREFIX = 'openprint:template:'

function readIndex(): TemplateSummary[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as TemplateSummary[]
  } catch {
    return []
  }
}

function writeIndex(list: TemplateSummary[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list))
}

export function createLocalRepository(): TemplateRepository {
  return {
    async list() {
      return readIndex()
    },

    async get(id) {
      try {
        const raw = localStorage.getItem(RECORD_PREFIX + id)
        return raw ? (JSON.parse(raw) as TemplateRecord) : null
      } catch {
        return null
      }
    },

    async create(record) {
      const full: TemplateRecord = {
        ...record,
        id: genId('tpl'),
        editable: true,
        deletable: true,
        updatedAt: new Date().toISOString(),
      }
      localStorage.setItem(RECORD_PREFIX + full.id, JSON.stringify(full))
      const index = readIndex()
      index.push({
        id: full.id,
        name: full.name,
        editable: true,
        deletable: true,
        updatedAt: full.updatedAt,
      })
      writeIndex(index)
      return full
    },

    async update(id, record) {
      const existing = await this.get(id)
      if (!existing) throw new Error(`模板不存在：${id}`)
      const merged: TemplateRecord = {
        ...existing,
        ...record,
        id,
        updatedAt: new Date().toISOString(),
      }
      localStorage.setItem(RECORD_PREFIX + id, JSON.stringify(merged))
      const index = readIndex().map((t) =>
        t.id === id ? { ...t, name: merged.name, updatedAt: merged.updatedAt } : t,
      )
      writeIndex(index)
      return merged
    },

    async remove(id) {
      localStorage.removeItem(RECORD_PREFIX + id)
      writeIndex(readIndex().filter((t) => t.id !== id))
    },
  }
}
