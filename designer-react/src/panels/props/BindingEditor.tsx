/**
 * BindingEditor —— 绑定路径编辑器（点选 path，非手敲）
 *
 * 默认接 dataSource store 的扁平字段列表（`selectFlatFields`，用于单值绑定）。
 * 传了 `options` 就用外部给的选项 —— 表格「数据设置 → 数据源」传的是**数组表**
 * （见 `tableSourceOptions`）：表格数据源必须是数组路径，喂字段列表会"全是列、没有表"。
 */
import { Select } from 'antd'
import { useMemo } from 'react'
import { useDataSourceStore } from '../../stores/dataSource'
import { selectFlatFields } from '../../stores/dataSource'

import type { FieldDef } from '@/types/datasource'

interface Props {
  value?: string
  placeholder?: string
  /** 外部选项；不传则回退到数据源的扁平字段列表 */
  options?: { label: string; value: string }[]
  /** 选项为空时的提示 */
  emptyHint?: string
  onChange?: (value: string | undefined) => void
}

export default function BindingEditor({ value, placeholder, options, emptyHint, onChange }: Props) {
  const flatFields = useDataSourceStore(selectFlatFields)
  const loading = useDataSourceStore((s) => s.loading)

  const opts = useMemo(
    () =>
      options ??
      flatFields.map((f: FieldDef) => ({
        label: `${f.label}（${f.path}）`,
        value: f.path,
      })),
    [flatFields, options],
  )

  return (
    <Select
      // 等价 Vue 版 tag 模式：允许手输自定义 path，但语义上仍是单值
      value={value ? [value] : []}
      options={opts}
      size="small"
      showSearch
      mode="tags"
      maxCount={1}
      allowClear
      placeholder={placeholder ?? '选择或输入绑定字段'}
      loading={loading}
      notFoundContent={opts.length ? '没有匹配项' : emptyHint ?? '暂无可选项'}
      onChange={(v) => {
        const arr = v as string[]
        onChange?.(arr.length ? arr[arr.length - 1] : undefined)
      }}
    />
  )
}
