/**
 * 模板仓库契约 —— 《实施指南》§2 repository 层 / 《后端对接规范》§4.1
 *
 * 铁律（2026-08-08 主任定）：
 * - 设计器内一切操作**纯本地**，不触发任何后端写入
 * - 只有用户手动点击「保存模板」才调用 save()
 * - 未配置后端接口时，使用 createLocalRepository（localStorage），功能不受影响
 */
import type { AnyControl } from '@/types/control'
import type { TemplateData } from '@/types/template'

/** 模板记录 = 协议数据 + 管理元信息 */
export interface TemplateRecord {
  id: string
  name: string
  /** 权限（云端返回；本地实现恒为可编辑可删除） */
  editable?: boolean
  deletable?: boolean
  updatedAt?: string
  data: TemplateData<AnyControl>
}

export interface TemplateSummary {
  id: string
  name: string
  editable?: boolean
  deletable?: boolean
  updatedAt?: string
}

/** 纯 CRUD 五项（对齐后端 /api/print/templates） */
export interface TemplateRepository {
  list(): Promise<TemplateSummary[]>
  get(id: string): Promise<TemplateRecord | null>
  create(record: Omit<TemplateRecord, 'id' | 'updatedAt'>): Promise<TemplateRecord>
  update(id: string, record: Partial<Omit<TemplateRecord, 'id'>>): Promise<TemplateRecord>
  remove(id: string): Promise<void>
}

/** 数据源仓库契约（Phase 5 实现） */
export type { DataSourceRepository } from '@/types/datasource'
