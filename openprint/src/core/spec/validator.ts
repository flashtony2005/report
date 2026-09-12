/**
 * template.json 协议校验（AJV）
 * 加载模板时调用；校验失败抛出带可读信息的 TemplateValidationError。
 */
import Ajv from 'ajv'
import type { ErrorObject, ValidateFunction } from 'ajv'
import schema from './template.schema.json'

const ajv = new Ajv({ allErrors: true, strict: false })

// JSON Schema 与 TS 类型保持松散对应（schema 允许 additionalProperties 扩展）
const validateFn = ajv.compile(schema) as ValidateFunction

export interface ValidationIssue {
  path: string
  message: string
}

export class TemplateValidationError extends Error {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super(
      'template.json 协议校验失败：\n' +
        issues.map((i) => `  - ${i.path || '/'}: ${i.message}`).join('\n'),
    )
    this.name = 'TemplateValidationError'
    this.issues = issues
  }
}

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath,
    message: e.message ?? '未知错误',
  }))
}

export interface ValidateResult {
  valid: boolean
  issues: ValidationIssue[]
}

/** 校验模板，返回结果（不抛异常） */
export function validateTemplate(template: unknown): ValidateResult {
  const valid = validateFn(template)
  return { valid: !!valid, issues: valid ? [] : toIssues(validateFn.errors) }
}

/** 校验模板，失败抛 TemplateValidationError */
export function assertTemplate(template: unknown): asserts template is import('@/types/template').TemplateData {
  const result = validateTemplate(template)
  if (!result.valid) throw new TemplateValidationError(result.issues)
}
