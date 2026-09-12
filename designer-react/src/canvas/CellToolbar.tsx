/**
 * CellToolbar —— 单元格浮动工具栏（React 版，方案 A）
 *
 * 从 Vue 版 `openprint/src/design/canvas/CellToolbar.vue` 迁移（P7 收尾）。
 * 双击进入单元格后浮在其上方，提供 ERP 报表最常用的单元格级能力：
 * 字段绑定 / 字体族 / 字号 / 加粗斜体下划线 / 水平垂直对齐 / 文字色 / 填充色 /
 * 横纵向合并 / 单元格斜线 / 行列增删 / 数据格式 / 清除样式。
 *
 * 交互契约（与 Vue 版逐条对齐）：
 * - 本组件**不直接改 store**：所有动作算出「新的表格控件」后 onApply(next)，
 *   由 TableViewLayer 统一写回并重放冻结 HTML —— 保持单一写入口，撤销栈干净。
 * - 浮层内的 mousedown / dblclick 一律 stopPropagation，避免按钮点击被画布的
 *   「点外面就退出编辑」逻辑吞掉，也避免触发 Fabric 的命中。
 *
 * antd v6 适配要点（与 Vue/naive 的差异）：
 * - naive `<NButtonGroup>` → `Space.Compact`；`NSelect/NInputNumber/NSwitch` → 同名 antd 组件
 * - `NColorPicker value+@update:value` → antd `ColorPicker`（`children` 自定义触发器 + `onChange(c, css)`）
 * - React 端 UnoCSS **无 presetIcons**（无 `i-carbon-*`），图标统一用 Unicode 字符 + 文字
 * - 两字中文按钮会被 antd 插入空格 → 统一 `autoInsertSpace={false}`
 * - 下拉/取色器弹层走 body 传送门，由 TableViewLayer 的 ANTD_TELEPORT_SELECTOR 豁免
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, ColorPicker, Divider, Input, InputNumber, Select, Space, Switch, Tooltip } from 'antd'
import type {
  CellFormat,
  CellFormatKind,
  TableCell,
  TableCellStyle,
  TableControl,
} from '@/types/control'
import {
  buildDesignGrid,
  insertTableColumn,
  insertTableRow,
  patchCell,
  patchCellStyle,
  removeTableColumn,
  removeTableRow,
  resolveCellStyle,
  rowRoleLabel,
  setCellRowSpan,
  setCellSpan,
} from '@/core/layout-engine/table-cells'
import { FONT_CATALOG } from '@/core/fonts/catalog'
import { useSystemFonts } from '../hooks/useSystemFonts'
import { selectActiveSource, selectFlatFields, useDataSourceStore } from '../stores/dataSource'
import ContentValueEditor from '../panels/props/ContentValueEditor'
import type { ContentMode } from '../panels/props/ContentValueEditor'
import ExpressionModal from '../panels/props/ExpressionModal'
import {
  currencyCodeOptions,
  datePatternOptions,
  formatKindOptions,
  makeFormat,
  needsCode,
  needsDigits,
  needsPattern,
  supportsThousands,
} from '@/design/format-options'

export interface CellToolbarProps {
  control: TableControl
  row: number
  col: number
  /** 行语义：header=表头 / data=数据样例行（影响整列）/ static=静态行 */
  rowKind: 'header' | 'data' | 'static'
  x: number
  y: number
  onApply: (next: TableControl) => void
  onClose: () => void
}

/** antd ColorPicker 的 onChange 第二参（css 串）在不同格式下形态不一，统一取 6 位 hex */
function toHex6(c: { toHexString: () => string } | null | undefined): string {
  if (!c || typeof c.toHexString !== 'function') return ''
  try {
    const h = c.toHexString()
    return h.length === 9 ? h.slice(0, 7) : h
  } catch {
    return ''
  }
}

/** 自定义触发器按钮（取色器用），带色块 / fx 占位 */
function SwatchTrigger({ value, children }: { value?: string; children: ReactNode }): ReactNode {
  return (
    <span className="op-cell-toolbar__swatch-trigger">
      {children}
      <span className="op-cell-toolbar__swatch" style={{ background: value || 'transparent' }} />
    </span>
  )
}

export default function CellToolbar(props: CellToolbarProps) {
  const { control, row, col, rowKind, x, y, onApply, onClose } = props

  const flatFields = useDataSourceStore(selectFlatFields)
  const activeSource = useDataSourceStore(selectActiveSource)
  const sysFonts = useSystemFonts()

  const [colorExprShow, setColorExprShow] = useState(false)
  const [bgExprShow, setBgExprShow] = useState(false)

  const grid = useMemo(() => buildDesignGrid(control), [control])
  const cell: TableCell = grid.cells[row]?.[col] ?? {}
  const column = control.columns[col]
  const style: TableCellStyle = resolveCellStyle(control, column, cell)

  /* ------------------------------ 字体下拉 ------------------------------ */

  type FontOption = { label: string; value: string }
  type FontGroup = { label: string; options: FontOption[] }

  const fontOptions = useMemo<Array<FontOption | FontGroup>>(() => {
    const out: Array<FontOption | FontGroup> = [{ label: '默认', value: '' }]
    if (sysFonts.ready) {
      out.push({
        label: '预设字体',
        options: FONT_CATALOG.map((f) => ({ label: f.label, value: f.family })),
      })
      out.push({
        label: `电脑系统字体（${sysFonts.count}）`,
        options: sysFonts.grouped.map((g) => ({ label: g.family, value: g.family })),
      })
    } else {
      out.push(...FONT_CATALOG.map((f) => ({ label: f.label, value: f.family })))
    }
    return out
  }, [sysFonts])

  /* ------------------------------ 字段绑定 ------------------------------ */

  /**
   * 可绑定字段（用于变量模式默认值）：
   * - 数据样例行 → 明细表（数组）字段，运行期按行迭代
   * - 表头 / 静态行 → 主表标量字段
   */
  const detailFields = useMemo(() => {
    const isDetail = rowKind === 'data'
    const tables = activeSource?.tables ?? []
    const arrayTableIds = new Set(tables.filter((t) => t.isArray).map((t) => t.id))
    return flatFields.filter((f) => {
      const inArray = f.tableId ? arrayTableIds.has(f.tableId) : f.path.includes('[]')
      return isDetail ? inArray : !inArray
    })
  }, [flatFields, activeSource, rowKind])

  const bindingDefault =
    detailFields[0]?.path ?? (rowKind === 'data' ? 'items[].name' : 'order.orderNo')
  const expressionDefault = rowKind === 'data' ? '{{rowIndex + 1}}' : '{{order.total}}'

  /** 单元格内容三态：固定值 / 变量（字段绑定） / 表达式（显式 contentType，老模板启发式回退） */
  const cellMode: ContentMode = cell.contentType
    ? cell.contentType
    : cell.expression
      ? 'expression'
      : cell.field
        ? 'variable'
        : 'fixed'

  /** 模式切换：写 contentType + 清空其它两个字段（默认值由编辑器按 bindingDefault 注入） */
  function onCellMode(m: ContentMode): void {
    const p: Partial<TableCell> = { contentType: m }
    if (m === 'fixed') {
      p.field = undefined
      p.expression = undefined
    } else if (m === 'variable') {
      p.expression = undefined
    } else {
      p.field = undefined
    }
    onApply(patchCell(control, row, col, p))
  }

  function onCellValue(v: string): void {
    onApply(patchCell(control, row, col, { text: v }))
  }

  /** 变量模式：写 contentType + field 并清空 text/expression，保证 field 为唯一取值源 */
  function onCellBinding(path: string): void {
    onApply(
      patchCell(control, row, col, {
        contentType: 'variable',
        field: path || undefined,
        text: undefined,
        expression: undefined,
      }),
    )
  }

  function onCellExpression(v: string): void {
    onApply(
      patchCell(control, row, col, {
        contentType: 'expression',
        expression: v || undefined,
        text: undefined,
        field: undefined,
      }),
    )
  }

  /* ------------------------------ 样式动作 ------------------------------ */

  function applyStyle(patch: TableCellStyle): void {
    onApply(patchCellStyle(control, row, col, patch))
  }

  /* ----- 动态配色：把 {{}} 表达式写入列级 columns[i].style ----- */

  const colorExprInit = column?.style?.color ?? ''
  const bgExprInit = column?.style?.backgroundColor ?? ''

  /** 文字色 / 填充色是否处于「表达式模式」（值含 {{）—— 此时色块按钮显示 fx 占位 */
  const isColorExpr = /\{\{/.test(column?.style?.color ?? '')
  const isBgExpr = /\{\{/.test(column?.style?.backgroundColor ?? '')

  /** 写入列级 style（columns[i].style），整列数据行生效 */
  function applyColumnStyle(patch: TableCellStyle): void {
    const cur = column?.style ?? {}
    const merged: TableCellStyle = { ...cur }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (merged as Record<string, unknown>)[k]
      else (merged as Record<string, unknown>)[k] = v
    }
    const columns = control.columns.map((c, i) => (i === col ? { ...c, style: merged } : c))
    onApply({ ...control, columns })
  }

  function toggle(key: 'bold' | 'italic' | 'underline'): void {
    applyStyle({ [key]: !style[key] } as TableCellStyle)
  }

  /* ------------------------------ 合并 ------------------------------ */

  const spanMax = Math.max(1, grid.colCount - col)
  const currentSpan = Math.min(cell.colSpan ?? 1, spanMax)

  function setSpan(n: number | null): void {
    onApply(setCellSpan(control, row, col, n ?? 1))
  }

  /**
   * 纵向合并（rowSpan）。
   * 仅表头 / 静态 / 布局网格行生效：数据行由运行期逐条生成，跨行会跨越不同记录，语义不成立，
   * 故数据样例行（rowKind==='data'）禁用该项，与表格引擎的「模板行强制 rowSpan=1」一致。
   */
  const canRowSpan = rowKind !== 'data'
  const rowSpanMax = Math.max(1, grid.rowCount - row)
  const currentRowSpan = Math.min(cell.rowSpan ?? 1, rowSpanMax)

  function setRowSpanValue(n: number | null): void {
    if (!canRowSpan) return
    onApply(setCellRowSpan(control, row, col, n ?? 1))
  }

  function clearStyle(): void {
    onApply(patchCell(control, row, col, { style: undefined }))
  }

  /* ------------------------------ 斜线 ------------------------------ */

  const diagOptions = [
    { label: '无', value: 'none' },
    { label: '↘ 右下', value: 'down' },
    { label: '↗ 右上', value: 'up' },
  ]
  const currentDiagonal = (cell.style?.diagonal ?? 'none') as 'none' | 'down' | 'up'
  function setDiagonal(v: 'none' | 'down' | 'up'): void {
    applyStyle({ diagonal: v === 'none' ? undefined : v })
  }

  /* ------------------------------ 数据格式 ------------------------------ */

  /** 仅绑定了字段/表达式（或显式 variable/expression 模式）的单元格才需要格式 */
  const canFormat =
    cell.contentType === 'variable' ||
    cell.contentType === 'expression' ||
    Boolean(cell.field || cell.expression) ||
    (rowKind === 'data' && Boolean(column?.field || column?.expression))

  /** 生效中的格式（单元格优先，回落列默认） */
  const cellFormat: CellFormat | undefined = cell.format ?? column?.format

  function applyFormat(fmt: CellFormat | undefined): void {
    // kind='none' 视为清除，避免脏字段
    onApply(
      patchCell(control, row, col, { format: fmt && fmt.kind !== 'none' ? fmt : undefined }),
    )
  }

  function isPresetDatePattern(p?: string): boolean {
    return Boolean(p && datePatternOptions.some((o) => o.value !== '__custom__' && o.value === p))
  }

  /* ------------------------------ 行列插入/删除 ------------------------------ */

  const canDeleteRow = rowKind !== 'data' && grid.rowCount > 1
  const canDeleteCol = grid.colCount > 1

  /* ------------------------------ 行角色名 ------------------------------ */

  /** 行角色名（标题行 / 数据行 / 本页合计行 / 总计行 / 大写金额行），用于工具栏标签 */
  const roleLabel = rowKind === 'data' ? '数据行（影响整列）' : rowRoleLabel(grid, row)

  const alignOptions = [
    { key: 'left', icon: '⇤', title: '左对齐' },
    { key: 'center', icon: '↔', title: '居中' },
    { key: 'right', icon: '⇥', title: '右对齐' },
  ] as const
  const valignOptions = [
    { key: 'top', icon: '⇡', title: '顶端对齐' },
    { key: 'middle', icon: '⇕', title: '垂直居中' },
    { key: 'bottom', icon: '⇣', title: '底端对齐' },
  ] as const

  const smallBtn = { size: 'small' as const, autoInsertSpace: false }

  return (
    <div
      className="op-cell-toolbar"
      style={{ left: x, top: y }}
      data-testid="cell-toolbar"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="op-cell-toolbar__inner">
        {/* 第 0 行：内容三态（固定值 / 变量 / 表达式），与文本组件完全一致 */}
        <div className="op-cell-toolbar__row">
          <span className="op-cell-toolbar__tag">内容</span>
          <div className="op-cell-content">
            <ContentValueEditor
              mode={cellMode}
              value={cell.text ?? ''}
              binding={cell.field ?? ''}
              expression={cell.expression ?? ''}
              placeholder="单元格内容"
              singleLine
              bindingDefault={bindingDefault}
              expressionDefault={expressionDefault}
              onModeChange={onCellMode}
              onValueChange={onCellValue}
              onBindingChange={onCellBinding}
              onExpressionChange={onCellExpression}
            />
          </div>
        </div>

        {/* 第一行：行角色 / 字体 / 字形 / 对齐 */}
        <div className="op-cell-toolbar__row">
          <span className="op-cell-toolbar__tag" data-testid="cell-role">{roleLabel}</span>

          <Divider orientation="vertical" />

          <Select
            size="small"
            className="op-cell-toolbar__w24"
            value={style.fontFamily ?? ''}
            options={fontOptions}
            showSearch
            optionFilterProp="label"
            data-testid="cell-font"
            onChange={(v: string) => applyStyle({ fontFamily: v || undefined })}
          />
          <InputNumber
            size="small"
            className="op-cell-toolbar__w18"
            value={style.fontSize ?? null}
            min={5}
            max={72}
            step={1}
            placeholder="9"
            onChange={(v: number | null) => applyStyle({ fontSize: v ?? undefined })}
          />

          <Space.Compact>
            <Tooltip title="加粗">
              <Button
                {...smallBtn}
                data-testid="cell-bold"
                type={style.bold ? 'primary' : 'default'}
                onClick={() => toggle('bold')}
              >
                <span className="font-bold">B</span>
              </Button>
            </Tooltip>
            <Tooltip title="斜体">
              <Button
                {...smallBtn}
                data-testid="cell-italic"
                type={style.italic ? 'primary' : 'default'}
                onClick={() => toggle('italic')}
              >
                <span className="italic font-serif">I</span>
              </Button>
            </Tooltip>
            <Tooltip title="下划线">
              <Button
                {...smallBtn}
                data-testid="cell-underline"
                type={style.underline ? 'primary' : 'default'}
                onClick={() => toggle('underline')}
              >
                <span className="underline">U</span>
              </Button>
            </Tooltip>
          </Space.Compact>

          <Space.Compact>
            {alignOptions.map((a) => (
              <Tooltip key={a.key} title={a.title}>
                <Button
                  {...smallBtn}
                  type={style.align === a.key ? 'primary' : 'default'}
                  onClick={() => applyStyle({ align: a.key })}
                >
                  <span className="op-cell-toolbar__icon">{a.icon}</span>
                </Button>
              </Tooltip>
            ))}
          </Space.Compact>

          <Space.Compact>
            {valignOptions.map((v) => (
              <Tooltip key={v.key} title={v.title}>
                <Button
                  {...smallBtn}
                  type={style.valign === v.key ? 'primary' : 'default'}
                  onClick={() => applyStyle({ valign: v.key })}
                >
                  <span className="op-cell-toolbar__icon">{v.icon}</span>
                </Button>
              </Tooltip>
            ))}
          </Space.Compact>
        </div>

        {/* 第二行：文字色 / 填充色 / 斜线 / 合并 / 清除 / 行列 */}
        <div className="op-cell-toolbar__row">
          {/* 文字颜色：自定义触发器，色块展示当前值；表达式模式下显示 fx */}
          <ColorPicker
            value={isColorExpr ? '#1f2329' : (style.color ?? '#1f2329')}
            disabledAlpha
            format="hex"
            size="small"
            onChange={(c) => applyStyle({ color: toHex6(c) || undefined })}
          >
            <Button {...smallBtn} type="text" title="文字颜色" data-testid="cell-color">
              <SwatchTrigger value={isColorExpr ? undefined : (style.color ?? '#1f2329')}>
                {isColorExpr ? (
                  <span className="i-fx">fx</span>
                ) : (
                  <span className="font-bold">A</span>
                )}
              </SwatchTrigger>
            </Button>
          </ColorPicker>
          {/* 文字色：切到表达式模式（fx 按钮） */}
          <Tooltip title="文字色表达式（如 {{row.amount < 0 ? '#D93636' : ''}}）">
            <Button
              {...smallBtn}
              type={isColorExpr ? 'primary' : 'text'}
              data-testid="cell-color-expr"
              onClick={() => setColorExprShow(true)}
            >
              fx
            </Button>
          </Tooltip>

          {/* 填充颜色 */}
          <ColorPicker
            value={isBgExpr ? '#ffffff' : (style.backgroundColor ?? '#ffffff')}
            disabledAlpha
            format="hex"
            size="small"
            onChange={(c) => applyStyle({ backgroundColor: toHex6(c) || undefined })}
          >
            <Button {...smallBtn} type="text" title="填充颜色" data-testid="cell-bg">
              <SwatchTrigger value={isBgExpr ? undefined : style.backgroundColor}>
                {isBgExpr ? <span className="i-fx">fx</span> : <span>▨</span>}
              </SwatchTrigger>
            </Button>
          </ColorPicker>
          {/* 填充色：切到表达式模式（fx 按钮） */}
          <Tooltip title="填充色表达式（如 {{row.amount < 0 ? '#FFE5E5' : '#fff'}}）">
            <Button
              {...smallBtn}
              type={isBgExpr ? 'primary' : 'text'}
              data-testid="cell-bg-expr"
              onClick={() => setBgExprShow(true)}
            >
              fx
            </Button>
          </Tooltip>
          <Tooltip title="清除填充">
            <Button
              {...smallBtn}
              type="text"
              onClick={() => applyStyle({ backgroundColor: undefined })}
            >
              ⌫
            </Button>
          </Tooltip>

          <Tooltip title="单元格斜线（课表角标）：无 / ↘左上→右下 / ↗左下→右上">
            <Select
              size="small"
              style={{ width: 92 }}
              value={currentDiagonal}
              options={diagOptions}
              data-testid="cell-diagonal"
              onChange={(v: 'none' | 'down' | 'up') => setDiagonal(v)}
            />
          </Tooltip>

          <Divider orientation="vertical" />

          <Tooltip title="横向合并列数">
            <InputNumber
              size="small"
              className="op-cell-toolbar__w20"
              value={currentSpan}
              min={1}
              max={spanMax}
              step={1}
              data-testid="cell-span"
              onChange={setSpan}
            />
          </Tooltip>
          <Tooltip title="纵向合并行数（数据行不跨行）">
            <InputNumber
              size="small"
              className="op-cell-toolbar__w20"
              value={currentRowSpan}
              min={1}
              max={rowSpanMax}
              step={1}
              disabled={!canRowSpan}
              data-testid="cell-rowspan"
              onChange={setRowSpanValue}
            />
          </Tooltip>

          <Divider orientation="vertical" />

          <Tooltip title="清除本格样式">
            <Button {...smallBtn} type="text" onClick={clearStyle}>
              ⌫
            </Button>
          </Tooltip>

          <Divider orientation="vertical" />

          <span className="op-cell-toolbar__tag">行列</span>
          <Tooltip title="上方插入行">
            <Button
              {...smallBtn}
              type="text"
              data-testid="cell-insert-row-above"
              onClick={() => onApply(insertTableRow(control, row))}
            >
              ↑行
            </Button>
          </Tooltip>
          <Tooltip title="下方插入行">
            <Button
              {...smallBtn}
              type="text"
              data-testid="cell-insert-row-below"
              onClick={() => onApply(insertTableRow(control, row + 1))}
            >
              ↓行
            </Button>
          </Tooltip>
          <Tooltip title="左侧插入列">
            <Button
              {...smallBtn}
              type="text"
              data-testid="cell-insert-col-left"
              onClick={() => onApply(insertTableColumn(control, col))}
            >
              ←列
            </Button>
          </Tooltip>
          <Tooltip title="右侧插入列">
            <Button
              {...smallBtn}
              type="text"
              data-testid="cell-insert-col-right"
              onClick={() => onApply(insertTableColumn(control, col + 1))}
            >
              →列
            </Button>
          </Tooltip>

          <Divider orientation="vertical" />

          <Tooltip title="删除本行">
            <Button
              {...smallBtn}
              type="text"
              disabled={!canDeleteRow}
              data-testid="cell-del-row"
              onClick={() => onApply(removeTableRow(control, row))}
            >
              ✕行
            </Button>
          </Tooltip>
          <Tooltip title="删除本列">
            <Button
              {...smallBtn}
              type="text"
              disabled={!canDeleteCol}
              data-testid="cell-del-col"
              onClick={() => onApply(removeTableColumn(control, col))}
            >
              ✕列
            </Button>
          </Tooltip>

          <Button {...smallBtn} type="text" data-testid="cell-close" onClick={onClose}>
            ✕
          </Button>
        </div>

        {/* 第三行：数据格式（仅绑定字段的单元格） */}
        {canFormat && (
          <div className="op-cell-toolbar__row op-cell-toolbar__format">
            <span className="op-cell-toolbar__tag">格式</span>
            <Select
              size="small"
              className="op-cell-toolbar__w24"
              value={cellFormat?.kind ?? 'none'}
              options={formatKindOptions}
              data-testid="cell-format-kind"
              onChange={(k: CellFormatKind) => applyFormat(k === 'none' ? undefined : makeFormat(k))}
            />
            {cellFormat && cellFormat.kind !== 'none' && (
              <>
                {needsPattern(cellFormat.kind) && (
                  <Select
                    size="small"
                    className="op-cell-toolbar__w30"
                    value={
                      isPresetDatePattern(cellFormat.pattern)
                        ? cellFormat.pattern
                        : '__custom__'
                    }
                    options={datePatternOptions}
                    onChange={(v: string) => {
                      if (v !== '__custom__') applyFormat({ ...cellFormat, pattern: v })
                    }}
                  />
                )}
                {needsPattern(cellFormat.kind) && !isPresetDatePattern(cellFormat.pattern) && (
                  <Input
                    size="small"
                    className="op-cell-toolbar__w30"
                    value={cellFormat.pattern}
                    placeholder="如 YYYY年MM月DD日"
                    onChange={(e) =>
                      applyFormat({ ...cellFormat, pattern: e.target.value || 'YYYY-MM-DD' })
                    }
                  />
                )}
                {needsDigits(cellFormat.kind) && (
                  <InputNumber
                    size="small"
                    className="op-cell-toolbar__w16"
                    value={cellFormat.digits ?? (cellFormat.kind === 'int' ? 0 : 2)}
                    min={0}
                    max={6}
                    onChange={(v: number | null) => applyFormat({ ...cellFormat, digits: v ?? 0 })}
                  />
                )}
                {needsCode(cellFormat.kind) && (
                  <Select
                    size="small"
                    className="op-cell-toolbar__w20"
                    value={cellFormat.code ?? 'CNY'}
                    options={currencyCodeOptions}
                    onChange={(v: string) => applyFormat({ ...cellFormat, code: v })}
                  />
                )}
                {supportsThousands(cellFormat.kind) && (
                  <Switch
                    size="small"
                    checked={cellFormat.thousands ?? true}
                    onChange={(v: boolean) => applyFormat({ ...cellFormat, thousands: v })}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* 动态配色：文字色 / 填充色表达式编辑 */}
      <ExpressionModal
        show={colorExprShow}
        expression={colorExprInit}
        onCancel={() => setColorExprShow(false)}
        onConfirm={(v) => {
          applyColumnStyle({ color: v || undefined })
          setColorExprShow(false)
        }}
      />
      <ExpressionModal
        show={bgExprShow}
        expression={bgExprInit}
        onCancel={() => setBgExprShow(false)}
        onConfirm={(v) => {
          applyColumnStyle({ backgroundColor: v || undefined })
          setBgExprShow(false)
        }}
      />
    </div>
  )
}
