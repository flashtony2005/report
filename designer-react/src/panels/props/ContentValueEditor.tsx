/**
 * ContentValueEditor —— 通用「内容三态」编辑器（React 版）
 *
 * 与 Vue 版 `props/ContentValueEditor.vue` 交互一致：固定值 / 变量 / 表达式。
 * 组件只发事件不写模型 —— 父级把事件映射到各自控件 schema。
 *
 * P3.3：变量模式已接 VariableModal（弹窗选字段）；
 * P4.1：表达式模式已接 ExpressionModal（函数目录 + 实时预览）。
 * 模式切换时的新模式默认值语义与 Vue 版一致（仅当该字段为空才填充）。
 */
import { Button, Input, Radio } from 'antd'
import { useState } from 'react'
import type { RadioChangeEvent } from 'antd'
import type { ChangeEvent } from 'react'
import type { ContentMode } from '@/design/panels/props/shared/panel-logic'
import VariableModal from './VariableModal'
import ExpressionModal from './ExpressionModal'

export type { ContentMode }

/** 表达式输入框占位 */
const EXPR_PLACEHOLDER = "{{order.total | currency:'CNY'}}"

export interface ContentValueEditorProps {
  mode: ContentMode
  value?: string
  binding?: string
  expression?: string
  placeholder?: string
  /** 单行输入（条码/二维码/单元格）；默认多行 textarea（文本） */
  singleLine?: boolean
  /** 切模式时对应字段为空则自动填入的默认值 */
  fixedDefault?: string
  bindingDefault?: string
  expressionDefault?: string
  onModeChange: (m: ContentMode) => void
  onValueChange: (v: string) => void
  onBindingChange: (v: string) => void
  onExpressionChange: (v: string) => void
}

export default function ContentValueEditor(props: ContentValueEditorProps) {
  const {
    mode,
    value = '',
    binding = '',
    expression = '',
    placeholder = '内容',
    singleLine = false,
    fixedDefault = '',
    bindingDefault = '',
    expressionDefault = '',
  } = props

  const [varModalShow, setVarModalShow] = useState(false)
  const [exprModalShow, setExprModalShow] = useState(false)

  /** 用户点类型 radio：通知父级切模式，并给新模式填充默认值（仅当该字段为空） */
  const handleModeChange = (m: ContentMode): void => {
    props.onModeChange(m)
    if (m === 'fixed' && !value && fixedDefault) props.onValueChange(fixedDefault)
    else if (m === 'variable' && !binding && bindingDefault) props.onBindingChange(bindingDefault)
    else if (m === 'expression' && !expression && expressionDefault)
      props.onExpressionChange(expressionDefault)
  }

  const modeRadio = (
    <Radio.Group
      size="small"
      value={mode}
      onChange={(e: RadioChangeEvent) => handleModeChange(e.target.value as ContentMode)}
      optionType="button"
      options={[
        { label: '固定值', value: 'fixed' },
        { label: '变量', value: 'variable' },
        { label: '表达式', value: 'expression' },
      ]}
    />
  )

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs text-gray-500">类型</span>
        {modeRadio}
      </div>

      <div className="flex items-center gap-2">
        {mode === 'fixed' &&
          (singleLine ? (
            <Input
              size="small"
              value={value}
              placeholder={placeholder}
              onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => props.onValueChange(e.target.value)}
            />
          ) : (
            <Input.TextArea
              size="small"
              rows={3}
              value={value}
              placeholder={placeholder}
              onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => props.onValueChange(e.target.value)}
            />
          ))}
        {mode === 'variable' && (
          <Input
            size="small"
            value={binding}
            placeholder="字段路径，如 order.orderNo"
            onChange={(e) => props.onBindingChange(e.target.value)}
          />
        )}
        {mode === 'expression' && (
          <Input
            size="small"
            value={expression}
            placeholder={EXPR_PLACEHOLDER}
            onChange={(e) => props.onExpressionChange(e.target.value)}
          />
        )}
        {mode !== 'fixed' && (
          <Button
            size="small"
            onClick={() => {
              if (mode === 'variable') setVarModalShow(true)
              else setExprModalShow(true)
            }}
          >
            {mode === 'variable' ? '选择字段' : '插入函数'}
          </Button>
        )}
      </div>

      {/* 变量模式：弹窗选字段；表达式模式：弹窗插函数（与 Vue 版一致） */}
      <VariableModal
        show={varModalShow && mode === 'variable'}
        binding={binding}
        onCancel={() => setVarModalShow(false)}
        onConfirm={(path) => {
          props.onBindingChange(path)
          setVarModalShow(false)
        }}
      />
      <ExpressionModal
        show={exprModalShow && mode === 'expression'}
        expression={expression}
        onCancel={() => setExprModalShow(false)}
        onConfirm={(v) => {
          props.onExpressionChange(v)
          setExprModalShow(false)
        }}
      />
    </div>
  )
}
