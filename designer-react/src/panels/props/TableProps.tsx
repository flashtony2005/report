/**
 * TableProps —— 表格控件属性（React 版，P4.2，对应 Vue §5.4 / #100 网格管理）
 *
 * 与 Vue 版交互一致：数据源绑定、核心 3 开关置顶、合计行（总计）、分组统计、
 * 表格样式库、网格结构（行 stepper / 列增删移动）、行高、列配置（字段/格式/样式）、
 * 默认单元格样式、高级选项折叠。
 * 网格变更走共享 table-cells 纯函数；options/样式/选项构造走共享 table-props-logic（两端同源）。
 */
import { useState } from 'react'
import {
  AutoComplete,
  Button,
  Collapse,
  ColorPicker,
  Input,
  InputNumber,
  Select,
  Switch,
} from 'antd'
import type {
  CellFormat,
  CellFormatKind,
  TableCellStyle,
  TableColumn,
  TableControl,
  TableOptions,
  TableStylePreset,
} from '@/types/control'
import { useDesignerStore } from '../../stores/designer'
import { selectSelectedControl } from '../../stores/selectors'
import { useDataSourceStore, selectFlatFields, selectActiveSource } from '../../stores/dataSource'
import { addTableColumn, moveTableColumn, removeTableColumn, setGridRows } from '@/core/layout-engine/table-cells'
import {
  formatKindOptions,
  datePatternOptions,
  currencyCodeOptions,
  needsPattern,
  needsDigits,
  needsCode,
  supportsThousands,
} from '@/design/format-options'
import { tableStyleLabel, TABLE_STYLE_PRESETS } from '@/design/canvas/table-style-presets'
import {
  cleanOptions,
  columnFieldOptions as columnFieldOptionsOf,
  defaultSummary,
  fieldTypeMapOf,
  formatFromKind,
  groupFieldOptions as groupFieldOptionsOf,
  isAggregateOn,
  isPresetDatePattern,
  mergeClean,
  normalizeColumnFormat,
  stylePickPatch,
  summaryFieldOptions as summaryFieldOptionsOf,
  tableSourceOptions,
  withSummaryExpr,
  withSummaryFallback,
} from '@/design/panels/props/shared/table-props-logic'
import type { SummaryRowCfg } from '@/design/panels/props/shared/table-props-logic'
import BindingEditor from './BindingEditor'
import VariableModal from './VariableModal'
import TableStylePickerModal from './TableStylePickerModal'

const ALIGN_OPTIONS = [
  { label: '左', value: 'left' },
  { label: '中', value: 'center' },
  { label: '右', value: 'right' },
]
const VALIGN_OPTIONS = [
  { label: '顶部', value: 'top' },
  { label: '居中', value: 'middle' },
  { label: '底部', value: 'bottom' },
]

export default function TableProps() {
  const control = useDesignerStore(selectSelectedControl) as TableControl | undefined
  const flatFields = useDataSourceStore(selectFlatFields)
  const [colVarIndex, setColVarIndex] = useState(-1)
  const [pickerShow, setPickerShow] = useState(false)

  if (!control || control.type !== 'table') return null

  const isData = Boolean(control.dataSource?.trim())
  const patch = (p: Record<string, unknown>): void => {
    useDesignerStore.getState().updateControl(control.id, p)
  }
  const patchOptions = (p: Partial<TableOptions>): void => {
    patch({ options: cleanOptions(control.options, p) })
  }
  const patchColumn = (index: number, p: Partial<TableColumn>): void => {
    patch({ columns: control.columns.map((c, i) => (i === index ? { ...c, ...p } : c)) })
  }
  /** 应用一个返回"新控件"的网格纯函数（保持类型/ID 不变） */
  const applyGrid = (fn: (c: TableControl) => TableControl): void => {
    useDesignerStore.getState().updateControl(control.id, fn(control))
  }

  /* ------------------------------ 列字段选项 / 类型提示 ------------------------------ */
  const columnFieldOptions = columnFieldOptionsOf(flatFields)
  const fieldTypeMap = fieldTypeMapOf(flatFields)
  const fieldTypeOf = (path?: string): string | undefined => (path ? fieldTypeMap.get(path) : undefined)

  /* ------------------------------ 样式 ------------------------------ */
  const currentStyle = (control.options?.tableStyle ?? 'none') as TableStylePreset
  const patchDefaultStyle = (p: Record<string, unknown>): void => {
    const cur = (control.options?.defaultCellStyle ?? {}) as Record<string, unknown>
    patchOptions({ defaultCellStyle: mergeClean(cur, p) as unknown as TableCellStyle })
  }
  const patchColumnStyle = (index: number, p: Record<string, unknown>): void => {
    const cur = (control.columns[index]?.style ?? {}) as Record<string, unknown>
    patchColumn(index, { style: mergeClean(cur, p) as unknown as TableCellStyle })
  }

  /* ------------------------------ 列数据格式 ------------------------------ */
  const patchColumnFormat = (index: number, fmt: CellFormat | undefined): void => {
    patchColumn(index, { format: normalizeColumnFormat(fmt) })
  }

  /* ------------------------------ 合计行（总计） ------------------------------ */
  const summary = (control.options?.summaryRow ?? null) as SummaryRowCfg | null
  const hasSummary = summary !== null

  /* ------------------------------ 分组统计 ------------------------------ */
  const activeTables = selectActiveSource(useDataSourceStore.getState())?.tables
  const groupFieldOptions = groupFieldOptionsOf(flatFields, activeTables)
  const summaryFieldOptions = summaryFieldOptionsOf(control.columns)
  /** 表格数据源只能选数组表（明细表）；喂字段列表会"全是列、没有表" */
  const dataSourceOptions = tableSourceOptions(activeTables)

  return (
    <div>
      {/* 数据设置 */}
      <div className="props-section">
        <div className="props-title">数据设置</div>
        <div className="props-row">
          <span className="props-label">数据源</span>
          <BindingEditor
            value={control.dataSource}
            placeholder="留空 = 空白表格"
            options={dataSourceOptions}
            emptyHint="当前数据源没有明细表（数组），可手动输入路径"
            onChange={(v) => patch({ dataSource: v })}
          />
        </div>
      </div>

      {/* 核心开关 */}
      <div className="props-section">
        <div className="props-title">核心开关</div>
        <div className="props-row">
          <span className="props-label" style={{ minWidth: 88 }}>每页打印标题行</span>
          <Switch
            size="small"
            checked={control.options?.repeatHeader ?? true}
            onChange={(v) => patchOptions({ repeatHeader: v })}
          />
        </div>
        <div className="props-row">
          <span className="props-label" style={{ minWidth: 88 }}>每页打印合计行</span>
          <Switch
            size="small"
            checked={control.options?.repeatFooter ?? true}
            onChange={(v) => patchOptions({ repeatFooter: v })}
          />
        </div>
        <div className="props-row">
          <span className="props-label" style={{ minWidth: 88 }}>每页行数</span>
          <InputNumber
            size="small"
            min={1}
            placeholder="auto"
            value={
              control.options?.pageRows === 'auto' || control.options?.pageRows === undefined
                ? null
                : (control.options.pageRows as number)
            }
            onChange={(v) => patchOptions({ pageRows: v ?? 'auto' })}
          />
        </div>
      </div>

      {/* 合计行（总计） */}
      {isData && (
        <div className="props-section">
          <div className="props-title">合计行（总计）</div>
          <div className="props-row">
            <span className="props-label" style={{ minWidth: 88 }}>显示合计行</span>
            <Switch
              size="small"
              checked={hasSummary}
              onChange={(on) => {
                if (on) {
                  patchOptions({ summaryRow: defaultSummary() })
                  patch({ summary: undefined })
                } else {
                  patchOptions({ summaryRow: undefined })
                  patch({ summary: undefined })
                }
              }}
            />
          </div>
          {hasSummary && summary && (
            <>
              <div className="props-row">
                <span className="props-label" style={{ minWidth: 88 }}>统计方式</span>
                <Select
                  size="small"
                  style={{ flex: 1 }}
                  value={summary.type ?? 'sum'}
                  options={[
                    { label: '求和', value: 'sum' },
                    { label: '计数', value: 'count' },
                    { label: '自定义表达式', value: 'custom' },
                  ]}
                  onChange={(v) => patchOptions({ summaryRow: { ...summary, type: v } })}
                />
              </div>
              <div className="props-row">
                <span className="props-label" style={{ minWidth: 88 }}>聚合列</span>
                <Select
                  size="small"
                  mode="multiple"
                  style={{ flex: 1 }}
                  value={summary.fields ?? []}
                  options={summaryFieldOptions}
                  placeholder="选择参与统计的列"
                  onChange={(v) => patchOptions({ summaryRow: { ...summary, fields: v } })}
                />
              </div>
              <div className="props-row">
                <span className="props-label" style={{ minWidth: 88 }}>合计标签</span>
                <Input
                  size="small"
                  value={summary.label ?? '合计'}
                  placeholder="合计"
                  onChange={(e) => patchOptions({ summaryRow: { ...summary, label: e.target.value || '合计' } })}
                />
              </div>
              {summary.type === 'custom' && (
                <>
                  <div className="props-tip">
                    自定义表达式作用域：<code>sum.字段</code> / <code>avg.字段</code>（按列预聚合）、<code>rows</code>（当前分组行）、
                    <code>allRows</code>（整表行）。先在上方「聚合列」选要显示结果的列，再为每列填表达式。例如{' '}
                    <code>sum.amount - sum.discount</code>。
                  </div>
                  {(summary.fields ?? []).map((f) => (
                    <div key={f} className="props-row">
                      <span className="props-label" style={{ minWidth: 88 }}>{f} 表达式</span>
                      <Input
                        size="small"
                        value={summary.expressions?.[f] ?? ''}
                        placeholder="如 sum.amount"
                        onChange={(e) =>
                          patchOptions({ summaryRow: withSummaryExpr(summary, f, e.target.value) })
                        }
                      />
                    </div>
                  ))}
                  <div className="props-row">
                    <span className="props-label" style={{ minWidth: 88 }}>兜底表达式</span>
                    <Input
                      size="small"
                      value={summary.expression ?? ''}
                      placeholder="无聚合列时生效"
                      onChange={(e) => patchOptions({ summaryRow: withSummaryFallback(summary, e.target.value) })}
                    />
                  </div>
                </>
              )}
              <div className="props-tip">
                合计行固定在表尾；开启「每页打印合计行」后可每页重复。聚合列显示数值，其余列留空。
              </div>
            </>
          )}
        </div>
      )}

      {/* 分组统计 */}
      {isData && (
        <div className="props-section">
          <div className="props-title">分组统计</div>
          <div className="props-row">
            <span className="props-label" style={{ minWidth: 88 }}>分组字段</span>
            <Select
              size="small"
              allowClear
              showSearch
              style={{ flex: 1 }}
              value={control.groupBy ?? null}
              options={groupFieldOptions}
              placeholder="不分组"
              onChange={(v) => patch({ groupBy: v || undefined })}
            />
          </div>
          <div className="props-tip">
            按该字段分组打印；同时开启「合计行」后，<b>每个分组自动生成小计行</b>，末尾再附总计。
          </div>
          {control.groupBy && hasSummary && summary && (
            <>
              <div className="props-row">
                <span className="props-label" style={{ minWidth: 88 }}>小计标签</span>
                <Input
                  size="small"
                  value={summary.subtotalLabel ?? ''}
                  placeholder="${key} 小计"
                  onChange={(e) => patchOptions({ summaryRow: { ...summary, subtotalLabel: e.target.value || undefined } })}
                />
              </div>
              <div className="props-tip">
                <code>${'{key}'}</code> 会被替换为分组值。例如 <code>类别合计</code> 或 <code>{'{key}'} 小计</code>。
              </div>
              <div className="props-row">
                <span className="props-label" style={{ minWidth: 88 }}>小计加粗</span>
                <Switch
                  size="small"
                  checked={summary.subtotalStyle?.bold ?? true}
                  onChange={(v) =>
                    patchOptions({ summaryRow: { ...summary, subtotalStyle: { ...(summary.subtotalStyle ?? {}), bold: v } } })
                  }
                />
              </div>
              <div className="props-row">
                <span className="props-label" style={{ minWidth: 88 }}>小计字色</span>
                <ColorPicker
                  size="small"
                  disabledAlpha
                  value={summary.subtotalStyle?.color}
                  onChange={(c) =>
                    patchOptions({
                      summaryRow: { ...summary, subtotalStyle: { ...(summary.subtotalStyle ?? {}), color: c.toHexString() } },
                    })
                  }
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* 表格样式 */}
      <div className="props-section">
        <div className="props-title">表格样式</div>
        <div className="props-row">
          <span className="props-label" style={{ minWidth: 88 }}>样式预设</span>
          <a style={{ cursor: 'pointer' }} onClick={() => setPickerShow(true)}>
            {tableStyleLabel(currentStyle)}
          </a>
          <Button size="small" type="text" title="打开表格样式库" onClick={() => setPickerShow(true)}>
            ⊞
          </Button>
        </div>
        <div className="props-tip">
          点击打开「表格样式库」，可预览每种样式并直接点选套用（类似 Excel 表格样式快速切换）。默认「无」仅显示边框与表头加粗，无任何背景色（含标题行）。
        </div>
        <TableStylePickerModal
          show={pickerShow}
          current={currentStyle}
          onCancel={() => setPickerShow(false)}
          onSelect={(key) => {
            patchOptions(stylePickPatch(key))
            setPickerShow(false)
          }}
        />
      </div>

      {/* 网格结构 */}
      <div className="props-section">
        <div className="props-title">网格结构</div>
        <div className="props-row">
          <span className="props-label" style={{ minWidth: 88 }}>表头行数</span>
          <InputNumber
            size="small"
            min={0}
            max={10}
            value={control.headerRows ?? (control.columns.some((c) => c.title) ? 1 : 0)}
            onChange={(v) => applyGrid((c) => setGridRows(c, { headerRows: v ?? 0 }))}
          />
        </div>
        {!isData ? (
          <>
            <div className="props-row">
              <span className="props-label" style={{ minWidth: 88 }}>正文行数</span>
              <InputNumber
                size="small"
                min={0}
                max={100}
                value={control.designRows ?? 0}
                onChange={(v) => applyGrid((c) => setGridRows(c, { designRows: v ?? 0 }))}
              />
            </div>
            <div className="props-tip">布局网格：双击单元格可填写静态内容（表头 / 正文）。</div>
          </>
        ) : (
          <>
            <div className="props-row">
              <span className="props-label" style={{ minWidth: 88 }}>固定尾行</span>
              <InputNumber
                size="small"
                min={0}
                max={20}
                value={control.staticRows ?? 0}
                onChange={(v) => applyGrid((c) => setGridRows(c, { staticRows: v ?? 0 }))}
              />
            </div>
            <div className="props-tip">数据表：固定尾行用于备注 / 签字栏等；合计行由「高级选项」配置。</div>
          </>
        )}
      </div>

      {/* 行高 */}
      <div className="props-section">
        <div className="props-title">
          行高
          <span className="props-title-tip">画布与打印一致（所见即所得）</span>
        </div>
        <div className="props-row">
          <span className="props-label" style={{ minWidth: 88 }}>行高模式</span>
          <Select
            size="small"
            style={{ flex: 1 }}
            value={control.options?.rowHeightMode ?? 'auto'}
            options={[
              { label: '自动（内容撑开）', value: 'auto' },
              { label: '固定行高', value: 'fixed' },
            ]}
            onChange={(v) => patchOptions({ rowHeightMode: v })}
          />
        </div>
        {control.options?.rowHeightMode === 'fixed' && (
          <div className="props-row">
            <span className="props-label" style={{ minWidth: 88 }}>行高 (mm)</span>
            <InputNumber
              size="small"
              min={6}
              precision={1}
              value={control.options?.rowHeight ?? 8}
              onChange={(v) => patchOptions({ rowHeight: v ?? 8 })}
            />
          </div>
        )}
        <div className="props-tip">
          自动：每行高度按实际内容自适应（单行 ≈ 6.7mm）；固定：所有行统一为指定高度，改后画布包围盒自动跟随。
        </div>
      </div>

      {/* 列配置 */}
      <div className="props-section">
        <div className="props-title">列配置（{control.columns.length} 列）</div>
        {control.columns.map((col, i) => (
          <div key={i} className="mb-2 rounded border border-brand-border p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-12px text-gray-500">列 {i + 1}</span>
              <div className="flex items-center gap-1">
                <Button type="text" size="small" disabled={i === 0} title="左移" onClick={() => applyGrid((c) => moveTableColumn(c, i, i - 1))}>
                  ←
                </Button>
                <Button
                  type="text"
                  size="small"
                  disabled={i === control.columns.length - 1}
                  title="右移"
                  onClick={() => applyGrid((c) => moveTableColumn(c, i, i + 1))}
                >
                  →
                </Button>
                <Button
                  type="text"
                  size="small"
                  danger
                  disabled={control.columns.length <= 1}
                  onClick={() => applyGrid((c) => removeTableColumn(c, i))}
                >
                  删除
                </Button>
              </div>
            </div>
            <div className="props-row">
              <span className="props-label">标题</span>
              <Input size="small" value={col.title} onChange={(e) => patchColumn(i, { title: e.target.value })} />
            </div>
            <div className="props-row">
              <span className="props-label">字段</span>
              <AutoComplete
                size="small"
                style={{ flex: 1 }}
                value={col.field ?? ''}
                options={columnFieldOptions}
                placeholder="选择或输入字段，如 items[].qty"
                onChange={(v) => patchColumn(i, { field: v || undefined })}
              />
              <Button size="small" title="从数据源选择字段" onClick={() => setColVarIndex(i)}>
                ▾
              </Button>
            </div>
            <div className="props-row">
              <span className="props-label">参与合计</span>
              <Switch
                size="small"
                checked={isAggregateOn(col)}
                onChange={(v) => patchColumn(i, { aggregate: v })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="props-row">
                <span className="props-label">宽</span>
                <InputNumber size="small" value={col.width} min={5} onChange={(v) => patchColumn(i, { width: v ?? 30 })} />
              </div>
              <div className="props-row">
                <span className="props-label">对齐</span>
                <Select
                  size="small"
                  style={{ flex: 1 }}
                  value={col.align ?? 'left'}
                  options={ALIGN_OPTIONS}
                  onChange={(v) => patchColumn(i, { align: v })}
                />
              </div>
            </div>

            <div className="mt-1.5 border-t border-brand-border pt-1.5">
              <div className="mb-1 text-12px text-gray-500">数据格式</div>
              <div className="props-row">
                <span className="props-label">类型</span>
                <Select
                  size="small"
                  style={{ flex: 1 }}
                  value={col.format?.kind ?? 'none'}
                  options={formatKindOptions}
                  onChange={(k: CellFormatKind) => patchColumnFormat(i, formatFromKind(k))}
                />
              </div>
              {col.format && col.format.kind !== 'none' && (
                <>
                  {needsPattern(col.format.kind) && (
                    <div className="props-row">
                      <span className="props-label">日期模板</span>
                      <Select
                        size="small"
                        style={{ flex: 1 }}
                        value={isPresetDatePattern(col.format.pattern) ? col.format.pattern : '__custom__'}
                        options={datePatternOptions}
                        onChange={(v: string) => {
                          if (v !== '__custom__') patchColumnFormat(i, { ...col.format!, pattern: v })
                        }}
                      />
                    </div>
                  )}
                  {needsPattern(col.format.kind) && !isPresetDatePattern(col.format.pattern) && (
                    <div className="props-row">
                      <span className="props-label">自定义</span>
                      <Input
                        size="small"
                        value={col.format.pattern}
                        placeholder="如 YYYY年MM月DD日"
                        onChange={(e) =>
                          patchColumnFormat(i, { ...col.format!, pattern: e.target.value || 'YYYY-MM-DD' })
                        }
                      />
                    </div>
                  )}
                  {needsDigits(col.format.kind) && (
                    <div className="props-row">
                      <span className="props-label">小数位</span>
                      <InputNumber
                        size="small"
                        min={0}
                        max={6}
                        value={col.format.digits ?? (col.format.kind === 'int' ? 0 : 2)}
                        onChange={(v) => patchColumnFormat(i, { ...col.format!, digits: v ?? 0 })}
                      />
                    </div>
                  )}
                  {needsCode(col.format.kind) && (
                    <div className="props-row">
                      <span className="props-label">币种</span>
                      <Select
                        size="small"
                        style={{ flex: 1 }}
                        value={col.format.code ?? 'CNY'}
                        options={currencyCodeOptions}
                        onChange={(v: string) => patchColumnFormat(i, { ...col.format!, code: v })}
                      />
                    </div>
                  )}
                  {supportsThousands(col.format.kind) && (
                    <div className="props-row">
                      <span className="props-label">千分位</span>
                      <Switch
                        size="small"
                        checked={col.format.thousands ?? true}
                        onChange={(v) => patchColumnFormat(i, { ...col.format!, thousands: v })}
                      />
                    </div>
                  )}
                  {fieldTypeOf(col.field) && (
                    <div className="props-tip">
                      绑定的字段类型为 <b>{fieldTypeOf(col.field) === 'date' ? '日期' : '数值'}</b>
                      ，建议相应选择日期 / 数值格式。
                    </div>
                  )}
                </>
              )}
            </div>
            <Collapse
              className="mt-1"
              items={[
                {
                  key: 'col-style',
                  label: '单元格样式',
                  children: (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="props-row">
                        <span className="props-label">加粗</span>
                        <Switch size="small" checked={col.style?.bold ?? false} onChange={(v) => patchColumnStyle(i, { bold: v })} />
                      </div>
                      <div className="props-row">
                        <span className="props-label">字色</span>
                        <ColorPicker
                          size="small"
                          disabledAlpha
                          value={col.style?.color}
                          onChange={(c) => patchColumnStyle(i, { color: c.toHexString() })}
                        />
                      </div>
                      <div className="props-row">
                        <span className="props-label">单元格底</span>
                        <ColorPicker
                          size="small"
                          value={col.cellBackgroundColor}
                          onChange={(c) => patchColumn(i, { cellBackgroundColor: c.toHexString() || undefined })}
                        />
                      </div>
                      <div className="props-row">
                        <span className="props-label">表头底</span>
                        <ColorPicker
                          size="small"
                          value={col.headerBackgroundColor}
                          onChange={(c) => patchColumn(i, { headerBackgroundColor: c.toHexString() || undefined })}
                        />
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        ))}
        <Button size="small" variant="dashed" block onClick={() => applyGrid((c) => addTableColumn(c))}>
          + 添加列
        </Button>
      </div>

      {/* 默认单元格样式 */}
      <div className="props-section">
        <div className="props-title">默认单元格样式</div>
        <div className="props-tip">整表默认样式，可被列样式 / 单元格样式覆盖。</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="props-row">
            <span className="props-label">字号(pt)</span>
            <InputNumber
              size="small"
              min={6}
              max={72}
              placeholder="继承"
              value={control.options?.defaultCellStyle?.fontSize ?? null}
              onChange={(v) => patchDefaultStyle({ fontSize: v })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">对齐</span>
            <Select
              size="small"
              style={{ flex: 1 }}
              value={control.options?.defaultCellStyle?.align ?? 'left'}
              options={ALIGN_OPTIONS}
              onChange={(v) => patchDefaultStyle({ align: v })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">垂直对齐</span>
            <Select
              size="small"
              style={{ flex: 1 }}
              value={control.options?.defaultCellStyle?.valign ?? 'middle'}
              options={VALIGN_OPTIONS}
              onChange={(v) => patchDefaultStyle({ valign: v })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">字色</span>
            <ColorPicker
              size="small"
              disabledAlpha
              value={control.options?.defaultCellStyle?.color}
              onChange={(c) => patchDefaultStyle({ color: c.toHexString() })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">背景</span>
            <ColorPicker
              size="small"
              value={control.options?.defaultCellStyle?.backgroundColor}
              onChange={(c) => patchDefaultStyle({ backgroundColor: c.toHexString() })}
            />
          </div>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2">
          <div className="props-row">
            <span className="props-label">加粗</span>
            <Switch
              size="small"
              checked={control.options?.defaultCellStyle?.bold ?? false}
              onChange={(v) => patchDefaultStyle({ bold: v })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">斜体</span>
            <Switch
              size="small"
              checked={control.options?.defaultCellStyle?.italic ?? false}
              onChange={(v) => patchDefaultStyle({ italic: v })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">下划线</span>
            <Switch
              size="small"
              checked={control.options?.defaultCellStyle?.underline ?? false}
              onChange={(v) => patchDefaultStyle({ underline: v })}
            />
          </div>
        </div>
      </div>

      {/* 高级选项 */}
      <div className="props-section">
        <Collapse
          items={[
            {
              key: 'advanced',
              label: '高级选项',
              children: (
                <div>
                  <div className="props-row">
                    <span className="props-label" style={{ minWidth: 88 }}>整行跨页换页</span>
                    <Switch size="small" checked={control.options?.keepTogether ?? false} onChange={(v) => patchOptions({ keepTogether: v })} />
                  </div>
                  <div className="props-row">
                    <span className="props-label" style={{ minWidth: 88 }}>跳过空行</span>
                    <Switch size="small" checked={control.options?.skipEmptyRows ?? false} onChange={(v) => patchOptions({ skipEmptyRows: v })} />
                  </div>
                  <div className="props-row">
                    <span className="props-label" style={{ minWidth: 88 }}>斑马纹</span>
                    <Switch size="small" checked={control.options?.striped ?? false} onChange={(v) => patchOptions({ striped: v })} />
                  </div>
                  <div className="props-row">
                    <span className="props-label" style={{ minWidth: 88 }}>垂直对齐</span>
                    <Select
                      size="small"
                      style={{ flex: 1 }}
                      value={control.options?.verticalAlign ?? 'middle'}
                      options={VALIGN_OPTIONS}
                      onChange={(v) => patchOptions({ verticalAlign: v })}
                    />
                  </div>
                  <div className="props-row">
                    <span className="props-label" style={{ minWidth: 88 }}>边框</span>
                    <Select
                      size="small"
                      style={{ flex: 1 }}
                      value={control.options?.borders ?? 'all'}
                      options={[
                        { label: '全部', value: 'all' },
                        { label: '仅横线', value: 'horizontal' },
                        { label: '仅外框', value: 'outline' },
                        { label: '无', value: 'none' },
                      ]}
                      onChange={(v) => patchOptions({ borders: v })}
                    />
                  </div>
                </div>
              ),
            },
          ]}
        />
      </div>

      {/* 列字段变量弹窗（数据列字段应为明细数组字段，弹窗展示全部字段 + 类型 + 示例值） */}
      <VariableModal
        show={colVarIndex >= 0}
        binding={colVarIndex >= 0 ? (control.columns[colVarIndex]?.field ?? '') : ''}
        onCancel={() => setColVarIndex(-1)}
        onConfirm={(path) => {
          if (colVarIndex >= 0) patchColumn(colVarIndex, { field: path })
          setColVarIndex(-1)
        }}
      />
    </div>
  )
}
