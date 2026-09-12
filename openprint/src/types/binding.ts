/**
 * 数据绑定契约 —— 《OpenPrint-设计方案.md》§5.3 / §6
 *
 * binding：简单的字段路径绑定（点选 path，非手敲）
 * expression：mustache 表达式，可带过滤器（{{ order.total | currency:'CNY' }}）
 */

/** 字段路径绑定，如 "customer.name"、"order.orderNo" */
export type BindingPath = string

export interface Binding {
  /** 数据路径（相对数据源根） */
  path: BindingPath
  /** 可选格式化器名（currency / date / number 等，见 core/expression.ts） */
  formatter?: string
  /** 格式化器参数 */
  formatterArgs?: unknown[]
}
