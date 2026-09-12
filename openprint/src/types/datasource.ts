/**
 * 数据源契约 —— 《OpenPrint-设计方案.md》§19.4.3a
 *
 * 「内省优先 + 标注增强」：字段定义源头 = 数据库 schema（自动合并），
 * 标注表仅覆盖 label/hidden/group。后端未就绪时 createMockDataSource 开箱即用。
 *
 * 关键接口变更（v5）：DataSourceMeta 支持多表层级，FieldDef 增加分组/隐藏/排序字段。
 */
export interface FieldDef {
  /** 字段完整路径，如 "order.no"、"customer.name"、"items[].productName" */
  path: string
  /** 中文显示名（标注覆盖 > schema 注释 > 自动生成） */
  label: string
  /** 数据类型 */
  type: 'string' | 'number' | 'boolean' | 'date' | 'image' | 'array' | 'object'
  /** 枚举选项 */
  options?: { value: string; label: string }[]
  /** 示例值（设计器预览/占位符用） */
  sample?: unknown

  // === 增强字段（标注表提供，schema 内省时可为空） ===

  /** 所属表 ID（设计器按此分组展现金蝶式树形） */
  tableId?: string
  /** 分组名（如 "基础信息"/"金额信息"/"自定义"） */
  group?: string
  /** 排序权重（升序，默认 0） */
  sort?: number
  /** 是否在字段面板隐藏（true=隐藏，但已绑定的旧模板仍可用该 path） */
  hidden?: boolean
  /** 是否 ERP 自定义字段 */
  custom?: boolean
  /** 只读标记（UI 提示，不影响打印） */
  readonly?: boolean
  /** 图片格式列表（仅 type=image 时有意义） */
  format?: string[]
}

export interface TableMeta {
  /** 表标识，如 "order"、"order_item"、"customer" */
  id: string
  /** 表显示名，如 "订单主表"、"订单明细"、"客户信息" */
  name: string
  /** 关系类型 */
  relation: 'main' | 'detail' | 'join'
  /** 路径前缀（用于拼字段完整 path，如 "order."、"customer."、"items[]"） */
  pathPrefix: string
  /** 是否数组（relation=detail 通常为 true，绑定后渲染期按数组迭代） */
  isArray?: boolean
  /** 关联键（仅文档说明，设计器不强校验） */
  joinKey?: string
  extra?: Record<string, unknown>
}

export interface DataSourceMeta {
  /** 数据源 ID，如 "sale_order" */
  id: string
  /** 名称，如 "销售订单" */
  name: string
  description?: string
  /** 子表层级（金蝶式可展开） */
  tables?: TableMeta[]
}

/**
 * DataSourceRepository —— 数据源仓库契约（增强版，§19.4.3a）
 *
 * 三种实现模式可互换（接口完全相同）：
 * - A：内省模式（后端 information_schema 自动发现）
 * - B：声明模式（后端返回固定 JSON）
 * - C：自定义实现（GraphQL / RPC / 任意数据源）
 * - Mock：createMockDataSource()（内置静态示例，零后端开箱即用）
 */
export interface DataSourceRepository {
  /** 列出可用数据源（含子表层级） */
  listSources(): Promise<DataSourceMeta[]>
  /** 获取某数据源的字段定义（扁平列表，设计器按 tableId 分组为树形） */
  getFields(sourceId: string): Promise<FieldDef[]>
}
