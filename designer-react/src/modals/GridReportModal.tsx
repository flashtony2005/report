/**
 * 网格报表预览（Univer）
 *
 * 分工：
 * - 展开/分组/汇总等算法在 print-server（Rust，127.0.0.1:18888）完成
 * - 前端只负责描述模板 + 把展开结果铺进 Univer 做展示与编辑
 *
 * 四种模板来源：
 * 1. 内置样例：服务端自带的销售分组汇总（无需连库）
 * 2. 分组汇总：挑数据库表 → 选分组字段 + 数值字段 + 聚合方式 → 多级分组小计/合计/总计
 * 3. 交叉表：行字段纵向 × 列字段横向（可多级）→ 自动带指标子表头 + 行/列合计 + 总计
 * 4. 画布表格：把设计器里选中的表格控件转成明细表模板
 *
 * 四类通用能力：
 * - **筛选条件**：WHERE 子句 + 参数（JSON 数组）下推给服务端，走参数化查询
 * - **字段中文别名**：给已选字段填显示名（留空回落内置别名表，region → 地区）
 * - **数值列格式**：按列选「整数 / 小数 / 货币 / 百分比 + 小数位 + 千分位 + 币种」，
 *   服务端渲染文本与 xlsx 数字格式同时生效；小计 / 合计 / 总计同列同口径
 * - **合并美化**：标题铺满整行、多级列头下表头格纵向合并、双指标显示「金额/数量」子表头
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tooltip,
  Typography,
} from 'antd'
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import '@univerjs/preset-sheets-core/lib/index.css'

import {
  buildCrossTemplate,
  buildDetailTemplate,
  buildGroupTemplate,
  cellPos,
  clearGridMerge,
  DEFAULT_FIELD_LABELS,
  deleteGridCol,
  deleteGridRow,
  formatCellText,
  gridToSheet,
  gridToWorkbookData,
  headerRowCount,
  insertGridCol,
  insertGridRow,
  mergeAt,
  PARENT_HIGHLIGHT,
  parseCellText,
  parentChainOf,
  parentPosOf,
  parentTreeOf,
  semanticBgOf,
  isValidReportId,
  parseParams,
  parsePos,
  REPORT_FORMAT,
  REPORT_VERSION,
  SEMANTIC_LEGEND,
  setGridCell,
  setGridMerge,
  suggestReportId,
  stripArrayPrefix,
  templateToGrid,
  toWorkbookData,
  validateTemplate,
  withExportFormula,
  withExpandControl,
  type AggType,
  type CellFormatSpec,
  type CellModel,
  type CellTpl,
  type ExpandDir,
  type MergeRect,
  type RenderRequest,
  type RenderResponse,
  type ReportDef,
  type ReportOptions,
  type ReportSource,
  type ReportSummary,
  type TplNode,
  type ReportTemplate,
  type TemplateGrid,
} from '@/report/grid-report'
import { useDataSourceStore } from '../stores/dataSource'
import { useDesignerStore } from '../stores/designer'

export const REPORT_SERVER = 'http://127.0.0.1:18888'

type TemplateMode = 'sample' | 'group' | 'cross' | 'canvas' | 'free'

/** 模板构建的三种结果：内置样例 / 可提交请求 / 校验错误 */
type BuildResult =
  | { kind: 'sample' }
  | {
      kind: 'request'
      req: RenderRequest
      headerRows: number
      /**
       * 未经后处理的原始模板 + 选项。
       * 保存报表文件时用这一对：存开关本身，而不是存「开关已经套上去」的模板——
       * 否则打开时再套一次就重复了，而且用户改不了开关。
       */
      rawTemplate: ReportTemplate
      options: ReportOptions
    }
  | { kind: 'error'; message: string }

interface CanvasTableLike {
  type: string
  columns?: Array<{ title?: string; field?: string }>
}

/**
 * 字段别名编辑器：只给已选中的字段提供输入框。
 * 留空 → 回落到内置中文别名表（如 region → 地区）。
 */
/** 数值格式种类下拉（空值 = 默认，交回服务端全局口径） */
const FORMAT_KIND_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '默认', value: '' },
  { label: '文本', value: 'text' },
  { label: '整数', value: 'int' },
  { label: '小数', value: 'decimal' },
  { label: '货币', value: 'currency' },
  { label: '百分比', value: 'percent' },
]

const CURRENCY_OPTIONS = [
  { label: '¥ CNY', value: 'CNY' },
  { label: '$ USD', value: 'USD' },
  { label: '€ EUR', value: 'EUR' },
  { label: '£ GBP', value: 'GBP' },
  { label: 'HK$ HKD', value: 'HKD' },
  { label: '¥ JPY', value: 'JPY' },
]

/** 选中某格式种类时的默认参数（与服务端 NumFmt 的缺省口径一致） */
function defaultFormat(kind: CellFormatSpec['kind']): CellFormatSpec {
  switch (kind) {
    case 'int':
      return { kind, thousands: true }
    case 'decimal':
      return { kind, digits: 2, thousands: true }
    case 'currency':
      return { kind, code: 'CNY', digits: 2, thousands: true }
    case 'percent':
      return { kind, digits: 2 }
    default:
      return { kind: 'text' }
  }
}

/**
 * 字段别名编辑器：只给已选中的字段提供输入框。
 * 留空 → 回落到内置中文别名表（如 region → 地区）。
 */
function AliasFields({
  fields,
  aliases,
  onChange,
  testid,
}: {
  fields: string[]
  aliases: Record<string, string>
  onChange: (next: Record<string, string>) => void
  testid?: string
}) {
  const shown = fields.filter(Boolean)
  if (!shown.length) return null
  return (
    <Space wrap size="small">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        字段别名
      </Typography.Text>
      {shown.map((f) => (
        <Space key={f} size={4}>
          <Typography.Text style={{ fontSize: 12 }}>{f} →</Typography.Text>
          <Input
            size="small"
            style={{ width: 96 }}
            value={aliases[f] ?? ''}
            placeholder={DEFAULT_FIELD_LABELS[f] ?? f}
            onChange={(e) => onChange({ ...aliases, [f]: e.target.value })}
            data-testid={testid ? `${testid}-${f}` : undefined}
          />
        </Space>
      ))}
    </Space>
  )
}

/**
 * 数值列格式编辑器：给每个数值字段选「种类 / 小数位 / 千分位 / 币种」。
 *
 * 不选（默认）→ 不下发 format，服务端走全局兜底（整数千分位、非整数两位小数）；
 * 选了 → 该数值列及其小计 / 合计 / 总计格统一套用，xlsx 导出同时带上 Excel 数字格式串。
 */
function FormatFields({
  fields,
  formats,
  onChange,
  testid,
}: {
  fields: string[]
  formats: Record<string, CellFormatSpec>
  onChange: (next: Record<string, CellFormatSpec>) => void
  testid?: string
}) {
  const shown = fields.filter(Boolean)
  if (!shown.length) return null

  const set = (f: string, v: CellFormatSpec | undefined): void => {
    const next = { ...formats }
    if (!v) delete next[f]
    else next[f] = v
    onChange(next)
  }

  return (
    <Space wrap size="small">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        数值格式
      </Typography.Text>
      {shown.map((f) => {
        const cur = formats[f]
        const kind = cur?.kind ?? ''
        const hasDigits = !!cur && ['int', 'decimal', 'currency', 'percent'].includes(cur.kind)
        const hasThousands = !!cur && ['int', 'decimal', 'currency'].includes(cur.kind)
        return (
          <Space key={f} size={4}>
            <Typography.Text style={{ fontSize: 12 }}>{f} →</Typography.Text>
            <Select
              size="small"
              style={{ width: 92 }}
              value={kind}
              options={FORMAT_KIND_OPTIONS}
              data-testid={testid ? `${testid}-${f}` : undefined}
              onChange={(v: string) =>
                set(f, v ? defaultFormat(v as CellFormatSpec['kind']) : undefined)
              }
            />
            {hasDigits && (
              <InputNumber
                size="small"
                style={{ width: 60 }}
                min={0}
                max={6}
                value={cur.digits ?? (cur.kind === 'int' ? 0 : 2)}
                data-testid={testid ? `${testid}-digits-${f}` : undefined}
                onChange={(v: number | null) => set(f, { ...cur, digits: v ?? 0 })}
              />
            )}
            {hasThousands && (
              <Switch
                size="small"
                checked={cur.thousands ?? true}
                data-testid={testid ? `${testid}-sep-${f}` : undefined}
                onChange={(v: boolean) => set(f, { ...cur, thousands: v })}
              />
            )}
            {cur?.kind === 'currency' && (
              <Select
                size="small"
                style={{ width: 96 }}
                value={cur.code ?? 'CNY'}
                options={CURRENCY_OPTIONS}
                onChange={(v: string) => set(f, { ...cur, code: v })}
              />
            )}
          </Space>
        )
      })}
    </Space>
  )
}

/** 图例里的底色按 key 取，避免 UI 里再硬编码一份颜色 */
const LEGEND_BG: Record<string, string | null> = Object.fromEntries(
  SEMANTIC_LEGEND.map((x) => [x.key, x.bg]),
)

/**
 * 主格树：让「关系」**常显**。
 *
 * 为什么不在格子里画：Univer 只渲染底色 + 字色两个通道（`bd` / `ul` 实测画不出来），
 * 两个通道已经给了「扩展方向」和「内容来源」，没有第三个能静态表达关系。
 * 关系本质是树，树不一定要画进格子 —— 常显一棵树，选中时再回网格点亮整条主格链。
 */
function ParentTree({
  tree,
  selected,
  onPick,
}: {
  tree: TplNode[]
  selected: string
  onPick: (pos: string) => void
}): ReactNode {
  const rows: ReactNode[] = []
  const walk = (ns: TplNode[], depth: number): void => {
    for (const n of ns) {
      const dot =
        n.expand === 'r' ? LEGEND_BG['expand-r'] : n.expand === 'c' ? LEGEND_BG['expand-c'] : null
      rows.push(
        <div
          key={n.pos}
          onClick={() => onPick(n.pos)}
          data-testid={`parent-tree-node-${n.pos}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingLeft: depth * 16,
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: '20px',
            borderRadius: 3,
            background: n.pos === selected ? '#FFF7E6' : 'transparent',
          }}
        >
          <span style={{ color: '#bbb', width: 12 }}>{depth > 0 ? '└' : ''}</span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: 2,
              border: '1px solid #d9d9d9',
              background: dot ?? '#fff',
              flex: '0 0 auto',
            }}
          />
          <Typography.Text code style={{ fontSize: 11 }}>
            {n.pos}
          </Typography.Text>
          <span
            style={{
              color: '#333',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {n.text || <span style={{ color: '#bbb' }}>（空）</span>}
          </span>
          {n.cycle && (
            <Typography.Text type="danger" style={{ fontSize: 11 }}>
              成环
            </Typography.Text>
          )}
          {n.orphan && (
            <Typography.Text type="warning" style={{ fontSize: 11 }}>
              主格悬空
            </Typography.Text>
          )}
        </div>,
      )
      walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)
  return <div>{rows}</div>
}

/**
 * 单元格模型编辑器（自由模板用）。
 *
 * 这一层存在的理由：`row_parent` / `expand_type` / `value_expr` 这些字段
 * **没法用格子里的文字表达**，必须有独立的属性面板。三个向导构造器碰不到它们，
 * 所以「手写模板」此前只能靠手写 JSON。
 */
function CellModelEditor({
  pos,
  cell,
  columns,
  merge,
  mergeError,
  onMerge,
  onUnmerge,
  onChange,
}: {
  pos: string
  cell: CellTpl
  columns: string[]
  /** 覆盖本格的合并块（含锚点格自己）；没合并时为 null */
  merge: MergeRect | null
  /** 上一次合并被拒绝的原因（越界 / 有内容 / 交叠） */
  mergeError: string
  onMerge: (rows: number, cols: number) => void
  onUnmerge: () => void
  onChange: (next: CellTpl) => void
}) {
  const m = cell.model
  const [spanRows, setSpanRows] = useState(1)
  const [spanCols, setSpanCols] = useState(1)
  // 字典是 JSON：半截输入 parse 不出来，不能边打边提交。
  // 留一份草稿文本，只有真正解析成对象才落进 model —— 否则用户打第一个 `{`
  // 就被判成「清掉了字典」，那是静默毁数据。
  const [dictDraft, setDictDraft] = useState<string | null>(null)
  // 换格就把跨度归位：否则输入框里还留着上一格的「3 行 × 2 列」，
  // 看着像当前格已经是那个跨度。（不用 key 重挂：--noResolve 下 JSX 的 key
  // 会因为解析不到 React 类型被误报成类型错误。）
  useEffect(() => {
    setSpanRows(1)
    setSpanCols(1)
    setDictDraft(null)
  }, [pos])
  const commitDict = (text: string): void => {
    const t = text.trim()
    if (!t) {
      setDictDraft(null)
      patch({ dict: undefined })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      setDictDraft(t) // 半截 JSON：留着，等用户打完再判定
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setDictDraft(t) // 不是对象：同样留着，别把用户输的吞掉
      return
    }
    const rec: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) rec[k] = String(v)
    setDictDraft(null)
    patch({ dict: rec })
  }
  const patch = (p: Partial<CellModel>): void => {
    const next: CellModel = { ...(m ?? {}), ...p }
    // 全空就没必要留个空 model
    const empty = Object.values(next).every((v) => v === undefined)
    onChange({ ...cell, model: empty ? undefined : next })
  }
  const text = formatCellText(cell)

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space size={4}>
        <Typography.Text strong style={{ fontSize: 12 }}>
          {pos}
        </Typography.Text>
        <Input
          size="small"
          style={{ width: 260 }}
          placeholder="格内容：字面量，或 {{ds1.city}} / {{D3[B3:+0].sum()}}"
          value={text}
          onChange={(e) => {
            const parsed = parseCellText(e.target.value)
            if (parsed.kind === 'literal') {
              onChange({ ...cell, value: e.target.value || null, model: cell.model })
            } else if (parsed.kind === 'field') {
              onChange({
                ...cell,
                value: null,
                model: {
                  ...(cell.model ?? {}),
                  ds: parsed.ds,
                  field: parsed.field,
                  agg: parsed.agg,
                  value_expr: undefined,
                },
              })
            } else {
              onChange({
                ...cell,
                value: null,
                model: {
                  ...(cell.model ?? {}),
                  ds: cell.model?.ds ?? 'ds1',
                  field: undefined,
                  value_expr: parsed.expr,
                },
              })
            }
          }}
          data-testid="free-cell-text"
        />
      </Space>

      <Space wrap size="small">
        <Select
          size="small"
          style={{ width: 110 }}
          data-testid="free-cell-expand"
          placeholder="扩展方向"
          value={m?.expand_type ?? ''}
          options={[
            { label: '不扩展', value: '' },
            { label: '纵向 ↓', value: 'r' },
            { label: '横向 →', value: 'c' },
          ]}
          onChange={(v: string) => patch({ expand_type: v ? (v as ExpandDir) : undefined })}
        />
        <Input
          size="small"
          style={{ width: 76 }}
          placeholder="数据集"
          value={m?.ds ?? ''}
          onChange={(e) => patch({ ds: e.target.value || undefined })}
          data-testid="free-cell-ds"
        />
        <Select
          size="small"
          style={{ width: 150 }}
          placeholder="字段"
          allowClear
          showSearch
          value={m?.field || undefined}
          options={[
            ...(m?.field && !columns.includes(m.field) ? [{ label: m.field, value: m.field }] : []),
            ...columns.map((n) => ({ label: n, value: n })),
          ]}
          onChange={(v?: string) => patch({ field: v || undefined })}
          data-testid="free-cell-field"
        />
        <Select
          size="small"
          style={{ width: 92 }}
          placeholder="聚合"
          value={m?.agg ?? ''}
          options={[
            { label: '不聚合', value: '' },
            { label: '求和', value: 'sum' },
            { label: '计数', value: 'count' },
            { label: '平均', value: 'avg' },
            { label: '最大', value: 'max' },
            { label: '最小', value: 'min' },
          ]}
          onChange={(v: string) => patch({ agg: v ? (v as AggType) : undefined })}
          data-testid="free-cell-agg"
        />
      </Space>

      <Space wrap size="small">
        <Space size={4}>
          <Typography.Text style={{ fontSize: 12 }}>左主格</Typography.Text>
          <Input
            size="small"
            style={{ width: 68 }}
            placeholder="A2"
            value={m?.row_parent ?? ''}
            onChange={(e) => patch({ row_parent: e.target.value.trim() || undefined })}
            data-testid="free-cell-row-parent"
          />
        </Space>
        <Space size={4}>
          <Typography.Text style={{ fontSize: 12 }}>上主格</Typography.Text>
          <Input
            size="small"
            style={{ width: 68 }}
            placeholder="B1"
            value={m?.col_parent ?? ''}
            onChange={(e) => patch({ col_parent: e.target.value.trim() || undefined })}
            data-testid="free-cell-col-parent"
          />
        </Space>
        <Input
          size="small"
          style={{ width: 240 }}
          placeholder="值表达式，如 D3[B3:+0].sum()"
          value={m?.value_expr ?? ''}
          onChange={(e) => patch({ value_expr: e.target.value || undefined })}
          data-testid="free-cell-value-expr"
        />
      </Space>

      {/*
        展示表达式 / 字典：引擎早就支持的「第三值阶段」——
        取值 → 套 format_expr → 查 dict → 才是屏幕上那串字。
        两者都只改展示文本、不动 value：导出 xlsx 时数字格仍写原值，
        所以「金额显示为『大额』」和「导出后还能求和」不冲突。
        设计器一直没入口，只能手写 JSON。
      */}
      <Space wrap size="small">
        <Tooltip title="展示期表达式，可用 value 指代本格的值，如 IF(value >= 1000, &quot;大额&quot;, &quot;小额&quot;)；只影响展示文本，不影响导出值">
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }}>展示表达式</Typography.Text>
            <Input
              size="small"
              style={{ width: 240 }}
              placeholder='如 IF(value >= 1000, "大额", "小额")'
              value={m?.format_expr ?? ''}
              onChange={(e) => patch({ format_expr: e.target.value || undefined })}
              data-testid="free-cell-format-expr"
            />
          </Space>
        </Tooltip>
        <Tooltip title="字典翻译：原始值文本 → 展示文本，JSON 对象。键取未套数字格式的原始文本；命中不了回落数字格式">
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }}>字典</Typography.Text>
            <Input
              size="small"
              style={{ width: 190 }}
              placeholder='{"1":"是","0":"否"}'
              value={dictDraft ?? (m?.dict ? JSON.stringify(m.dict) : '')}
              onChange={(e) => setDictDraft(e.target.value)}
              onBlur={(e) => commitDict(e.target.value)}
              onPressEnter={(e) => commitDict((e.target as HTMLInputElement).value)}
              data-testid="free-cell-dict"
            />
          </Space>
        </Tooltip>
      </Space>

      {/* 数字格式：不配就走服务端全局兜底（整数带千分位、非整数两位小数） */}
      <Space wrap size="small">
        <Space size={4}>
          <Typography.Text style={{ fontSize: 12 }}>数字格式</Typography.Text>
          <Select
            size="small"
            style={{ width: 96 }}
            placeholder="跟随全局"
            value={m?.format?.kind ?? ''}
            options={[
              { label: '跟随全局', value: '' },
              { label: '文本', value: 'text' },
              { label: '整数', value: 'int' },
              { label: '小数', value: 'decimal' },
              { label: '金额', value: 'currency' },
              { label: '百分比', value: 'percent' },
            ]}
            onChange={(v: string) =>
              patch({
                format: v
                  ? { ...(m?.format ?? {}), kind: v as CellFormatSpec['kind'] }
                  : undefined,
              })
            }
            data-testid="free-cell-format-kind"
          />
        </Space>
        {m?.format?.kind && (
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }}>小数位</Typography.Text>
            <InputNumber
              size="small"
              style={{ width: 62 }}
              min={0}
              max={10}
              value={m?.format?.digits ?? 2}
              onChange={(v: number | null) =>
                patch({
                  format: { ...(m?.format ?? { kind: 'decimal' }), digits: v ?? undefined },
                })
              }
              data-testid="free-cell-format-digits"
            />
          </Space>
        )}
      </Space>

      {/*
        行 / 列测试：引擎早就支持（返回 false 就整行 / 整列删掉），但设计器一直没入口，
        只能手写 JSON。补上之后，格子的橙色底边框才真正「用户可设」——
        否则图例里那条「有条测试」是个够不着的开关。
      */}
      <Space wrap size="small">
        <Tooltip title="运行期求值，返回 false 则整行不输出（如 amount > 0）">
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }}>行测试</Typography.Text>
            <Input
              size="small"
              style={{ width: 148 }}
              placeholder="如 amount > 0"
              value={m?.row_test_expr ?? ''}
              onChange={(e) => patch({ row_test_expr: e.target.value || undefined })}
              data-testid="free-cell-row-test-expr"
            />
          </Space>
        </Tooltip>
        <Tooltip title="运行期求值，返回 false 则整列不输出">
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }}>列测试</Typography.Text>
            <Input
              size="small"
              style={{ width: 148 }}
              placeholder="如 amount > 0"
              value={m?.col_test_expr ?? ''}
              onChange={(e) => patch({ col_test_expr: e.target.value || undefined })}
              data-testid="free-cell-col-test-expr"
            />
          </Space>
        </Tooltip>
      </Space>

      {/*
        最少行数：展开结果不足 N 条时补到 N 条（「默认留 N 个空行」）。
        引擎早就有（expand_min_count），但原先只在分组 / 交叉表模式下由一个报表级开关套用——
        那个开关靠「猜最内层」决定打在哪一格上，而自由模板的层级是用户一格一格定的，
        让它再猜一遍会覆盖用户意图。所以自由模板里改成 per-cell 直设：打在哪一格由点选决定。
      */}
      {m?.expand_type && (
        <Space wrap size="small">
          <Tooltip title="展开结果不足 N 条时补足到 N 条（默认留 N 个空行）；数据多于 N 条时按实际条数输出，不截断">
            <Space size={4}>
              <Typography.Text style={{ fontSize: 12 }}>
                最少{m?.expand_type === 'c' ? '列' : '行'}数
              </Typography.Text>
              <InputNumber
                size="small"
                style={{ width: 68 }}
                min={0}
                max={999}
                value={m?.expand_min_count ?? 0}
                onChange={(v: number | null) => patch({ expand_min_count: v && v > 0 ? v : undefined })}
                data-testid="free-cell-expand-min-count"
              />
            </Space>
          </Tooltip>
          <Tooltip title="展开结果超过 N 条时丢弃后面的（只显示前 N 条）；0 = 不限制">
            <Space size={4}>
              <Typography.Text style={{ fontSize: 12 }}>
                最多{m?.expand_type === 'c' ? '列' : '条'}
              </Typography.Text>
              <InputNumber
                size="small"
                style={{ width: 68 }}
                min={0}
                max={9999}
                value={m?.expand_max_count ?? 0}
                onChange={(v: number | null) => patch({ expand_max_count: v && v > 0 ? v : undefined })}
                data-testid="free-cell-expand-max-count"
              />
            </Space>
          </Tooltip>
          <Tooltip title="展开集为空时保留该格（值为 null）；不勾则整格连同子格一起消失">
            <Space size={4}>
              <Switch
                size="small"
                checked={!!m?.keep_expand_empty}
                onChange={(v: boolean) => patch({ keep_expand_empty: v || undefined })}
                data-testid="free-cell-keep-empty"
              />
              <Typography.Text style={{ fontSize: 12 }}>空集保留</Typography.Text>
            </Space>
          </Tooltip>
        </Space>
      )}

      <Space wrap size="small">
        <Typography.Text style={{ fontSize: 12 }}>合并</Typography.Text>
        {merge ? (
          <>
            <Typography.Text style={{ fontSize: 12 }} type="success">
              {cellPos(merge.r, merge.c)} 起 {merge.rows} 行 × {merge.cols} 列
            </Typography.Text>
            <Button size="small" onClick={onUnmerge} data-testid="free-merge-clear">
              取消合并
            </Button>
          </>
        ) : (
          <>
            <InputNumber
              size="small"
              style={{ width: 62 }}
              min={1}
              addonAfter="行"
              value={spanRows}
              onChange={(v: number | null) => setSpanRows(Math.max(1, v ?? 1))}
              data-testid="free-merge-rows"
            />
            <InputNumber
              size="small"
              style={{ width: 62 }}
              min={1}
              addonAfter="列"
              value={spanCols}
              onChange={(v: number | null) => setSpanCols(Math.max(1, v ?? 1))}
              data-testid="free-merge-cols"
            />
            <Button
              size="small"
              onClick={() => onMerge(spanRows, spanCols)}
              disabled={spanRows === 1 && spanCols === 1}
              data-testid="free-merge-apply"
            >
              合并
            </Button>
          </>
        )}
        {/* 合并会丢掉被覆盖格里的内容，所以只允许并**空**格；有内容时明确报错而不是硬做 */}
        {mergeError && (
          <Typography.Text type="danger" style={{ fontSize: 12 }} data-testid="free-merge-error">
            {mergeError}
          </Typography.Text>
        )}
      </Space>
    </Space>
  )
}

export default function GridReportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const univerRef = useRef<{ dispose: () => void } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fallbackHtml, setFallbackHtml] = useState('')
  const [mode, setMode] = useState<TemplateMode>('sample')
  const [groupFields, setGroupFields] = useState<string[]>([])
  const [valueField, setValueField] = useState<string>('')
  /** 分组汇总：每个分组内数值字段的聚合方式 */
  const [groupAgg, setGroupAgg] = useState<AggType>('sum')
  // 交叉表：行字段（纵向）× 列字段（横向）× 数值字段
  const [rowFields, setRowFields] = useState<string[]>([])
  const [colFields, setColFields] = useState<string[]>([])
  const [crossValueFields, setCrossValueFields] = useState<string[]>([])
  const [crossAgg, setCrossAgg] = useState<AggType>('sum')
  /** 字段 → 中文别名（行/列/数值/分组字段通用） */
  const [aliases, setAliases] = useState<Record<string, string>>({})
  /** 数值字段 → 显示格式（留空 = 服务端全局兜底口径） */
  const [valueFormats, setValueFormats] = useState<Record<string, CellFormatSpec>>({})
  /** 服务端筛选：WHERE 子句（占位符 ?）+ 参数（JSON 数组） */
  const [where, setWhere] = useState('')
  const [paramText, setParamText] = useState('')
  /** 分页：按「数据行」切页，表头/表尾每页重复（服务端 sheet.page） */
  const [paging, setPaging] = useState(false)
  const [rowsPerPage, setRowsPerPage] = useState(20)
  const [repeatHeader, setRepeatHeader] = useState(1)
  const [repeatFooter, setRepeatFooter] = useState(0)
  /**
   * 导出 xlsx 时把 value_expr 落成 Excel 公式（而非写死算好的值），
   * 导出后在 Excel 里改明细，小计 / 合计会跟着重算。
   * 分页导出时会自动回落写值（公式坐标按整表生成，逐页复制后行号对不上）。
   */
  const [exportFormula, setExportFormula] = useState(false)
  /**
   * 展开控制。三个值打在不同层级，不是随便挑的：
   * - 最少行数 → 最内层明细格（「每组至少 N 行」；打外层会变成「至少 N 个分组」）
   * - 最多条数 → 最外层分组格（「TOP N」；打内层会变成「每组只显示 N 行」）
   * - 空数据保留 → 所有行展开格（逐级保留，空报表才有空行撑着表头）
   * 0 表示不限制。多级分组下这三个是逐级生效的。
   */
  const [expandMin, setExpandMin] = useState(0)
  const [expandMax, setExpandMax] = useState(0)
  const [keepExpandEmpty, setKeepExpandEmpty] = useState(false)
  /** 自由模板：可逐格编辑的模板网格 + 当前选中位置（1 基行/列，避免让用户数 0） */
  const [grid, setGrid] = useState<TemplateGrid>(() => templateToGrid({ name: '模板', rows: [] }))
  const [selRow, setSelRow] = useState(1)
  const [selCol, setSelCol] = useState(1)
  /** 合并被拒的原因（越界 / 被覆盖格有内容 / 与已有合并块交叠） */
  const [mergeError, setMergeError] = useState('')
  /**
   * 画布重建令牌。**改动来自画布自身时不 +1。**
   *
   * 为什么不能直接让 Univer 的 effect 依赖 `grid`：画布改一格 → `SheetValueChanged`
   * → `setGrid` → effect 重跑 → `dispose()` 掉整个 Univer 再重建。内容本来就已经
   * 在画布上了，这一趟纯属白拆，还会把选区、滚动位置、正在编辑的格一起丢掉。
   *
   * 反过来，**属性面板的改动必须重建**：画布显示的文字来自 `formatCellText(cell)`，
   * 改字段 / 聚合 / 值表达式同样会改变显示内容，不重建就是脏的。
   */
  const [canvasKey, setCanvasKey] = useState(0)
  /** effect 里读的是「最新」的 grid；effect 本身只在 canvasKey 变化时重跑 */
  const gridRef = useRef(grid)
  useEffect(() => {
    gridRef.current = grid
  }, [grid])
  /**
   * 当前被点亮的主格：`{ 位置, 原本的语义底色 }`。
   * 移开选中时要照着这个还原，否则主格会永久留一块橙色 —— 那是**假的语义**。
   */
  const litParentRef = useRef<Array<{ pos: string; color: string | null }>>([])
  /**
   * 画格子的函数由 Univer 那条 effect 提供（要拿到 `univerAPI`），
   * 但树面板点击也要用它，故挂到 ref 上。拿不到时整体跳过点亮，不报错。
   */
  const paintRef = useRef<((pos: string, color: string | null) => void) | null>(null)
  /**
   * 点亮某格的**整条**主格链（不是只点亮直接主格 —— 多级分组下
   * 「我挂在谁下面」要看到完整路径才有用）。先还原上一次点亮的。
   */
  const lightParentChain = useCallback((row: number, col: number) => {
    const paint = paintRef.current
    for (const { pos, color } of litParentRef.current) paint?.(pos, color)
    litParentRef.current = []
    if (!paint) return
    const g = gridRef.current
    const cur = g?.[row]?.[col]
    // 整条行主格链（多级分组要看全路径）+ 直接列主格（交叉表的列方向层次）；
    // 列方向也跟链会变成一张图，所以那里只取直接主格。
    const targets = [...new Set([...parentChainOf(g, cur), ...parentPosOf(cur)])]
    for (const pp of targets) {
      const rc = parsePos(pp)
      const target = rc ? g?.[rc.r]?.[rc.c] : undefined
      litParentRef.current.push({ pos: pp, color: semanticBgOf(target) })
      paint(pp, PARENT_HIGHLIGHT)
    }
  }, [])
  /** 从树面板点一格：同步属性面板选中，并把整条链点亮 */
  const pickFromTree = useCallback(
    (pos: string) => {
      const rc = parsePos(pos)
      if (!rc) return
      setSelRow(rc.r + 1)
      setSelCol(rc.c + 1)
      lightParentChain(rc.r, rc.c)
    },
    [lightParentChain],
  )
  /** 改 grid 并请画布重建（结构变更 / 属性面板改动）。**画布自身的改动别走这里。** */
  /** 主格树：随 grid 变，关系常显（不依赖选中） */
  const parentTree = useMemo(() => parentTreeOf(grid), [grid])
  const applyGrid = useCallback((next: TemplateGrid) => {
    setGrid(next)
    setCanvasKey((v) => v + 1)
  }, [])
  /** 报表文件：id / 名称 / 已保存列表 */
  const [reportId, setReportId] = useState('')
  const [reportName, setReportName] = useState('')
  const [savedReports, setSavedReports] = useState<ReportSummary[]>([])
  const [fileBusy, setFileBusy] = useState(false)
  /** 调试：让服务端回传展开中间结果（层次坐标 / 父格）与模板告警 */
  const [dump, setDump] = useState(false)
  const [dumpText, setDumpText] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])

  const dbDatabases = useDataSourceStore((s) => s.dbDatabases)
  const dbTables = useDataSourceStore((s) => s.dbTables)
  const dbColumns = useDataSourceStore((s) => s.dbColumns)
  const dbSelection = useDataSourceStore((s) => s.dbSelection)
  const loadDatabases = useDataSourceStore((s) => s.loadDatabases)
  const loadTables = useDataSourceStore((s) => s.loadTables)
  const selectDatabase = useDataSourceStore((s) => s.selectDatabase)
  const selectTable = useDataSourceStore((s) => s.selectTable)

  const controls = useDesignerStore((s) => s.controls)
  const selectedIds = useDesignerStore((s) => s.selectedIds)

  const canvasTable = useMemo(() => {
    if (!selectedIds.length) return undefined
    return controls.find((c) => selectedIds.includes(c.id) && c.type === 'table') as
      | CanvasTableLike
      | undefined
  }, [controls, selectedIds])

  // 打开时若还没列过库/表，拉一次
  useEffect(() => {
    if (!open) return
    if (dbDatabases.length === 0) void loadDatabases()
    else if (dbTables.length === 0 && dbSelection.database) void loadTables()
  }, [open, dbDatabases.length, dbTables.length, dbSelection.database, loadDatabases, loadTables])

  const columnNames = useMemo(() => dbColumns.map((c) => c.name).filter(Boolean), [dbColumns])

  /** 自由模板：当前选中格的位置名与内容（1 基输入 → 0 基下标） */
  const selectedPos = useMemo(() => cellPos(selRow - 1, selCol - 1), [selRow, selCol])
  const selCell = useMemo<CellTpl | undefined>(() => {
    const r = selRow - 1
    const c = selCol - 1
    return grid[r]?.[c]
  }, [grid, selRow, selCol])
  /** 模板体检：只报「能确定是错的」，避免告警变成噪声 */
  const tplWarnings = useMemo(
    () => (mode === 'free' ? validateTemplate({ sheets: [gridToSheet(grid, '自由模板')] }) : []),
    [mode, grid],
  )

  /**
   * 分页配置。必须 memo：buildRequest 是 useCallback，而预览有一层 400ms 去抖，
   * 若 page 每次渲染都换新对象，doRender 身份随之变化，去抖会退化成反复请求。
   */
  const page = useMemo(
    () =>
      paging
        ? {
            // rows_per_page 兜底为 1：0 会让服务端把整表退化成一页
            rows_per_page: Math.max(1, rowsPerPage),
            repeat_header_rows: Math.max(0, repeatHeader),
            repeat_footer_rows: Math.max(0, repeatFooter),
          }
        : undefined,
    [paging, rowsPerPage, repeatHeader, repeatFooter],
  )

  /**
   * 组装渲染请求：模板 + 数据源声明
   * - sample：用服务端内置样例
   * - error：校验不通过，带错误信息
   * - request：可提交给 /api/report/render 的完整请求
   */
  const buildRequest = useCallback((): BuildResult => {
    if (mode === 'sample') return { kind: 'sample' }

    const dsName = 'ds1'
    let template: ReportTemplate
    if (mode === 'free') {
      const tpl = { sheets: [gridToSheet(grid, '自由模板')] }
      if (tpl.sheets[0].rows.length === 0) {
        return { kind: 'error', message: '模板是空的：先在格子里填内容或绑定字段' }
      }
      // 只套导出公式。
      // **不套 withExpandControl**：那个函数按「最内/最外层」猜层级，
      // 而自由模板的主格层级是用户一格一格定好的，让它再猜一遍会覆盖用户意图。
      template = withExportFormula(tpl, exportFormula)
      const rawTemplate = tpl
      const opts: ReportOptions = {
        exportFormula: exportFormula || undefined,
        dump: dump || undefined,
      }
      const { database: db1, table: tb1, engine: eg1 } = dbSelection
      if (!db1 || !tb1) return { kind: 'error', message: '请先在数据源里选择库和表' }
      const p1 = parseParams(paramText)
      if (!p1.ok) return { kind: 'error', message: p1.message ?? '参数不合法' }
      return {
        kind: 'request',
        req: {
          template,
          dump: dump ? true : undefined,
          sources: [
            {
              name: dsName,
              database: db1,
              engine: eg1,
              table: tb1,
              where: where.trim() || undefined,
              params: p1.params?.length ? p1.params : undefined,
            },
          ],
        },
        headerRows: 0,
        rawTemplate,
        options: opts,
      }
    } else if (mode === 'canvas') {
      if (!canvasTable?.columns?.length) {
        return { kind: 'error', message: '请先在画布里选中一个带字段列的表格控件' }
      }
      template = buildDetailTemplate({
        sheetName: '画布明细表',
        ds: dsName,
        columns: canvasTable.columns,
        aliases,
        valueFormats,
        title: '画布表格明细',
      })
    } else if (mode === 'cross') {
      if (rowFields.length === 0 || colFields.length === 0 || crossValueFields.length === 0) {
        return { kind: 'error', message: '交叉表需要至少一个行字段、一个列字段和一个数值字段' }
      }
      template = buildCrossTemplate({
        sheetName: '交叉表',
        ds: dsName,
        rowFields,
        colFields,
        valueFields: crossValueFields,
        agg: crossAgg,
        aliases,
        valueFormats,
        page,
        title: `${rowFields.join('/')} × ${colFields.join('/')}`,
      })
    } else {
      if (groupFields.length === 0 || !valueField) {
        return { kind: 'error', message: '请选择至少一个分组字段和一个数值字段' }
      }
      template = buildGroupTemplate({
        sheetName: '分组汇总',
        ds: dsName,
        groupFields,
        valueField,
        agg: groupAgg,
        aliases,
        valueFormats,
        title: `${groupFields.join(' / ')} · ${valueField} 汇总`,
      })
    }

    // 存原样：打开报表时由服务端按 options 再套一次
    const rawTemplate = template
    const opts: ReportOptions = {
      rowsPerPage: paging ? Math.max(1, rowsPerPage) : undefined,
      repeatHeaderRows: paging ? Math.max(0, repeatHeader) : undefined,
      repeatFooterRows: paging ? Math.max(0, repeatFooter) : undefined,
      exportFormula: exportFormula || undefined,
      expandMinCount: expandMin || undefined,
      expandMaxCount: expandMax || undefined,
      keepExpandEmpty: keepExpandEmpty || undefined,
      dump: dump || undefined,
    }

    // 导出公式 / 展开控制：统一后处理，不动三个构造器的签名
    template = withExportFormula(template, exportFormula)
    template = withExpandControl(template, {
      minCount: expandMin,
      maxCount: expandMax,
      keepEmpty: keepExpandEmpty,
    })

    const { database, table, engine } = dbSelection
    if (!database || !table) return { kind: 'error', message: '请先在数据源里选择库和表' }

    // 参数框是 JSON 数组；空串按「无参数」处理
    const parsed = parseParams(paramText)
    if (!parsed.ok) return { kind: 'error', message: parsed.message ?? '参数不合法' }
    const params = parsed.params?.length ? parsed.params : undefined
    const whereClause = where.trim() ? where.trim() : undefined

    return {
      kind: 'request',
      req: {
        template,
        dump: dump ? true : undefined,
        sources: [{ name: dsName, database, engine, table, where: whereClause, params }],
      },
      headerRows: headerRowCount(template),
      rawTemplate,
      options: opts,
    }
  }, [
    mode,
    canvasTable,
    groupFields,
    valueField,
    groupAgg,
    rowFields,
    colFields,
    crossValueFields,
    crossAgg,
    aliases,
    valueFormats,
    where,
    paramText,
    page,
    exportFormula,
    expandMin,
    expandMax,
    keepExpandEmpty,
    dump,
    dbSelection,
    grid,
  ])

  /* ------------------------- 报表文件：存 / 开 / 跑 ------------------------- */

  const refreshReports = useCallback(async () => {
    try {
      const res = await fetch(`${REPORT_SERVER}/api/reports`)
      if (!res.ok) throw new Error(`服务端返回 ${res.status}`)
      setSavedReports((await res.json()) as ReportSummary[])
    } catch {
      /* 列表拉不到不影响设计器本身，静默 */
    }
  }, [])

  useEffect(() => {
    if (open) void refreshReports()
  }, [open, refreshReports])

  const saveReport = useCallback(async () => {
    const id = reportId.trim()
    if (!isValidReportId(id)) {
      setError('报表 id 只能用字母、数字、-、_（最长 80），不能带空格或中文')
      return
    }
    const built = buildRequest()
    if (built.kind === 'error') {
      setError(built.message)
      return
    }

    let template: ReportTemplate
    let sources: ReportSource[] | undefined
    let options: ReportOptions | undefined
    if (built.kind === 'sample') {
      // 内置样例的模板在服务端手上，得先拉回来才能存。
      // （第一版这里直接写了 { sheets: [] }，等于存了个空报表，还不报错。）
      try {
        const res = await fetch(`${REPORT_SERVER}/api/report/sample-template`)
        if (!res.ok) throw new Error(`取样例模板失败 ${res.status}`)
        template = (await res.json()) as ReportTemplate
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
      options = { exportFormula: exportFormula || undefined, dump: dump || undefined }
    } else {
      template = built.rawTemplate
      sources = built.req.sources
      options = built.options
    }

    const def: ReportDef = {
      format: REPORT_FORMAT,
      version: REPORT_VERSION,
      id,
      name: reportName.trim() || id,
      template,
      sources,
      options,
    }
    setFileBusy(true)
    try {
      const res = await fetch(`${REPORT_SERVER}/api/reports/save`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(def),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(text || `保存失败 ${res.status}`)
      setError('')
      void refreshReports()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFileBusy(false)
    }
  }, [buildRequest, reportId, reportName, refreshReports, exportFormula, dump])

  /**
   * 打开已保存的报表。
   *
   * **一律落到「自由模板」模式**：自由模板能表达任何模板（分组/交叉/画布生成的
   * 也一样），进去之后还能逐格改。反过来做不到——向导模式填不出手写的模板。
   */
  const openReport = useCallback(async (id: string) => {
    setFileBusy(true)
    try {
      const res = await fetch(`${REPORT_SERVER}/api/reports/${encodeURIComponent(id)}`)
      const text = await res.text()
      if (!res.ok) throw new Error(text || `打开失败 ${res.status}`)
      const def = JSON.parse(text) as ReportDef
      setMode('free')
      applyGrid(templateToGrid(def.template.sheets?.[0] ?? { name: '模板', rows: [] }))
      setReportId(def.id)
      setReportName(def.name)
      setExportFormula(def.options?.exportFormula ?? false)
      setDump(def.options?.dump ?? false)
      const pagingOn = !!def.options?.rowsPerPage
      setPaging(pagingOn)
      if (def.options?.rowsPerPage) setRowsPerPage(def.options.rowsPerPage)
      if (def.options?.repeatHeaderRows != null) setRepeatHeader(def.options.repeatHeaderRows)
      if (def.options?.repeatFooterRows != null) setRepeatFooter(def.options.repeatFooterRows)
      // 数据源回填到左侧选择器，让人看得见数据从哪来
      const s0 = def.sources?.[0]
      if (s0?.database && s0?.table) {
        void selectDatabase(s0.database, s0.engine)
        void selectTable(s0.table)
      }
      if (s0?.where) setWhere(s0.where)
      if (s0?.params?.length) setParamText(JSON.stringify(s0.params))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFileBusy(false)
    }
  }, [selectDatabase, selectTable, applyGrid])

  /**
   * 执行已保存的报表：**不依赖当前表单**，直接按文件里存的定义跑。
   * 这是「打开报表就能出数据」的那一半——表单只是编辑态，文件才是事实。
   */
  const runReport = useCallback(async (id: string) => {
    setFileBusy(true)
    try {
      // 先取定义：要它算表头行数（给 Univer 加粗用），顺便提前告诉用户「没数据源」
      const defRes = await fetch(`${REPORT_SERVER}/api/reports/${encodeURIComponent(id)}`)
      if (!defRes.ok) throw new Error((await defRes.text()) || `打开失败 ${defRes.status}`)
      const def = JSON.parse(await defRes.text()) as ReportDef
      if (!def.sources?.length && !def.template?.datasets?.length) {
        setError(`报表「${def.name || id}」没有数据源也没有内嵌数据，执行会没有数据。先补上数据源再执行。`)
        return
      }
      const rows = headerRowCount(def.template)

      const res = await fetch(`${REPORT_SERVER}/api/reports/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(text || `执行失败 ${res.status}`)
      const data = JSON.parse(text) as RenderResponse
      setWarnings(data.warnings ?? [])
      setDumpText(data.dump ?? '')
      setFallbackHtml(data.html || '')
      // 先清上一次的错误，再 init —— 反过来的话 init 报的错会被这次清空盖掉
      setError('')
      try {
        univerRef.current?.dispose()
        univerRef.current = null
        const { univerAPI } = createUniver({
          locale: LocaleType.ZH_CN,
          locales: { [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN) },
          presets: [UniverSheetsCorePreset({ container: containerRef.current! })],
        })
        ;(univerAPI as any).createWorkbook(toWorkbookData(data.sheets[0], { headerRows: rows }))
        univerRef.current = univerAPI as unknown as { dispose: () => void }
      } catch (e) {
        setError(`Univer 初始化失败：${e instanceof Error ? e.message : String(e)}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFileBusy(false)
    }
  }, [])

  /**
   * 渲染。`silent` 用于「参数变化触发的自动刷新」：
   * 表单还没填完时不该弹警告条（用户正在输入），但**服务端/网络错误必须暴露**，
   * 否则会留着上一次的结果，用户以为新参数生效了。
   */
  const doRender = useCallback(async (silent = false) => {
    setLoading(true)
    if (!silent) setError('')
    setFallbackHtml('')
    const built = buildRequest()
    if (built.kind === 'error') {
      // 表单未填完：静默跳过（输入过程中的中间态）
      if (!silent) setError(built.message)
      setLoading(false)
      return null
    }
    try {
      let data: RenderResponse
      if (built.kind === 'sample') {
        const res = await fetch(`${REPORT_SERVER}/api/report/sample`)
        if (!res.ok) throw new Error(`服务端返回 ${res.status}`)
        data = (await res.json()) as RenderResponse
      } else {
        const res = await fetch(`${REPORT_SERVER}/api/report/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(built.req),
        })
        const text = await res.text()
        let payload: { message?: string } | RenderResponse = {}
        try {
          payload = JSON.parse(text)
        } catch {
          /* 非 JSON（如 400 纯文本） */
        }
        if (!res.ok) {
          throw new Error((payload as { message?: string }).message || `服务端返回 ${res.status}`)
        }
        data = payload as RenderResponse
      }
      // 告警与展开中间结果：只有 dump=true 时服务端才回 dump 字段
      setWarnings(data.warnings ?? [])
      setDumpText(data.dump ?? '')
      return { data, headerRows: built.kind === 'sample' ? 2 : built.headerRows }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setLoading(false)
    }
  }, [buildRequest])

  /** 导出 xlsx：与渲染同一份请求体，服务端直接返回文件流 */
  const doExport = useCallback(async () => {
    try {
      const built = buildRequest()
      if (built.kind === 'error') throw new Error(built.message)
      let res: Response
      if (built.kind === 'sample') {
        res = await fetch(`${REPORT_SERVER}/api/report/sample.xlsx`)
      } else {
        res = await fetch(`${REPORT_SERVER}/api/report/xlsx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(built.req),
        })
      }
      if (!res.ok) throw new Error(`导出失败：${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download =
        built.kind === 'sample'
          ? 'sample-report.xlsx'
          : `${built.req.template.sheets[0]?.name ?? 'report'}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [buildRequest])

  /**
   * 渲染 + 重建 Univer。
   *
   * 去抖 400ms：筛选条件 / 字段别名是文本框，逐字符触发会把 Univer 反复拆了重建。
   */
  /**
   * 自由模板：Univer 里装的是**模板本身**（不是展开结果）。
   *
   * 与预览共用一个容器，两种模式互斥——同页面起两个 Univer 实例会互相抢全局，
   * 所以这里在 free 模式下把预览那条路让出去。
   */
  useEffect(() => {
    if (!open || mode !== 'free') return
    let disposed = false
    const listeners: Array<{ dispose: () => void }> = []
    const timer = setTimeout(() => {
      if (disposed || !containerRef.current) return
      try {
        univerRef.current?.dispose()
        univerRef.current = null
        const { univerAPI } = createUniver({
          locale: LocaleType.ZH_CN,
          locales: { [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN) },
          presets: [UniverSheetsCorePreset({ container: containerRef.current })],
        })
        // 选中格不自绘高亮：Univer 自己会画选区光框，再叠一层反而打架
        ;(univerAPI as any).createWorkbook(gridToWorkbookData(gridRef.current))
        univerRef.current = univerAPI as unknown as { dispose: () => void }

        /**
         * 事件接线。API 名称已对着 @univerjs/*@0.25.1 的 .d.ts 核过：
         * - `univerAPI.addEvent(univerAPI.Event.SelectionChanged, p => p.selections)`（sheets-ui facade）
         * - `univerAPI.addEvent(univerAPI.Event.SheetValueChanged, p => p.effectedRanges)`（sheets facade）
         * 仍整体包在 try/catch 里：拿不到事件就退化成「只用右侧属性面板」，
         * 不至于让整块区域白屏。
         */
        const api = univerAPI as any
        /**
         * 主格是「关系」不是「属性」，静态样式画不出来 —— 选中一格时把它的主格
         * 点亮，就是最省事的关系可视化。
         *
         * 用 `setBackgroundColor` 直接改，不重建工作簿：重建会把整张表拆了再装，
         * 光标和选区都会丢（这正是 `SheetValueChanged` 里**刻意**不用 applyGrid
         * 的原因）。代价是要自己记着还原，见 `litParentRef`。
         */
        const sheet = () => api.getActiveWorkbook?.()?.getActiveSheet?.()
        const paintCell = (pos: string, color: string | null) => {
          const rc = parsePos(pos)
          const sh = sheet()
          if (!rc || !sh) return
          try {
            sh.getRange(rc.r, rc.c, 1, 1).setBackgroundColor(color ?? '#ffffff')
          } catch {
            /* 拿不到 range 就算了，图例仍在 */
          }
        }
        // 树面板点击也要用；实例销毁时清空，别留着指向已 dispose 的 sheet
        paintRef.current = paintCell
        try {
          listeners.push(
            api.addEvent(api.Event.SelectionChanged, (p: any) => {
              const s = p?.selections?.[0]
              if (!s) return
              setSelRow((s.startRow ?? 0) + 1)
              setSelCol((s.startColumn ?? 0) + 1)
              // 换了格子，上一格「合并被拒」的提示就不该还挂着
              setMergeError('')
              lightParentChain(s.startRow ?? 0, s.startColumn ?? 0)
            }),
          )
          listeners.push(
            api.addEvent(api.Event.SheetValueChanged, (p: any) => {
              const range = p?.effectedRanges?.[0]
              if (!range) return
              const r = range.getRow()
              const c = range.getColumn()
              const raw = range.getValue()
              const text = raw === null || raw === undefined ? '' : String(raw)
              // 注意这里**故意**用 setGrid 而不是 applyGrid：改动就来自画布，
              // 内容已经在画布上了，再 bump 一次 canvasKey 只会把整张表拆了重建。
              setGrid((g) => {
                const cur = g[r]?.[c]
                if (!cur) return g
                const parsed = parseCellText(text)
                let next: CellTpl
                if (parsed.kind === 'literal') {
                  next = { ...cur, value: text || null }
                } else if (parsed.kind === 'field') {
                  next = {
                    ...cur,
                    value: null,
                    model: {
                      ...(cur.model ?? {}),
                      ds: parsed.ds,
                      field: parsed.field,
                      agg: parsed.agg,
                      value_expr: undefined,
                    },
                  }
                } else {
                  next = {
                    ...cur,
                    value: null,
                    model: {
                      ...(cur.model ?? {}),
                      ds: cur.model?.ds ?? 'ds1',
                      field: undefined,
                      value_expr: parsed.expr,
                    },
                  }
                }
                return setGridCell(g, r, c, next)
              })
            }),
          )
        } catch {
          /* 事件不可用：属性面板仍可编辑，静默降级 */
        }
      } catch (e) {
        if (!disposed) setError(`Univer 初始化失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }, 200)
    return () => {
      disposed = true
      clearTimeout(timer)
      paintRef.current = null
      litParentRef.current = []
      for (const l of listeners) {
        try {
          l.dispose()
        } catch {
          /* 忽略 */
        }
      }
    }
  }, [open, mode, canvasKey, lightParentChain])

  useEffect(() => {
    if (!open) return
    if (mode === 'free') return // 自由模板由上面的 effect 接管容器
    let disposed = false
    const timer = setTimeout(() => {
      void (async () => {
        const out = await doRender(true)
        if (!out || disposed || !containerRef.current) return
        const { data, headerRows } = out
        setFallbackHtml(data.html || '')
        try {
          // 重建前先销毁上一个实例，否则多份 Univer 会叠在同一容器里
          univerRef.current?.dispose()
          univerRef.current = null
          const { univerAPI } = createUniver({
            locale: LocaleType.ZH_CN,
            locales: { [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN) },
            presets: [UniverSheetsCorePreset({ container: containerRef.current })],
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(univerAPI as any).createWorkbook(toWorkbookData(data.sheets[0], { headerRows }))
          univerRef.current = univerAPI as unknown as { dispose: () => void }
        } catch (e) {
          if (!disposed) setError(`Univer 初始化失败：${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    }, 400)

    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [open, mode, doRender])

  /** 关闭时才销毁实例（弹窗 destroyOnHidden，容器随之卸载） */
  useEffect(() => {
    if (open) return
    try {
      univerRef.current?.dispose()
    } catch {
      /* 忽略销毁异常 */
    }
    univerRef.current = null
  }, [open])

  const showQuery = mode !== 'sample'

  return (
    <Modal
      title="网格报表（Univer · 服务端展开）"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Button size="small" onClick={() => void doRender()} data-testid="grid-report-refresh">
            重新渲染
          </Button>
          <Button size="small" onClick={() => void doExport()} data-testid="grid-report-export">
            导出 xlsx
          </Button>
          <Button size="small" onClick={onClose} data-testid="grid-report-close">
            关闭
          </Button>
        </Space>
      }
      width="90vw"
      style={{ top: 24 }}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }} size="small">
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as TemplateMode)}
          options={[
            { label: '内置样例', value: 'sample' },
            { label: '分组汇总', value: 'group' },
            { label: '交叉表', value: 'cross' },
            { label: '画布表格', value: 'canvas' },
            { label: '自由模板', value: 'free' },
          ]}
        />

        {/* 报表文件：存下来之后，打开就能跑 */}
        <Space wrap size="small">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            报表文件
          </Typography.Text>
          <Input
            size="small"
            style={{ width: 150 }}
            placeholder="名称，如 地区销售汇总"
            value={reportName}
            onChange={(e) => {
              setReportName(e.target.value)
              // 名称→id 只自动填一次（用户没手动改过 id 时）
              if (!reportId || reportId === suggestReportId(reportName)) {
                setReportId(suggestReportId(e.target.value))
              }
            }}
            data-testid="report-file-name"
          />
          <Input
            size="small"
            style={{ width: 170 }}
            placeholder="文件 id（字母数字-_）"
            value={reportId}
            onChange={(e) => setReportId(e.target.value)}
            data-testid="report-file-id"
          />
          <Button
            size="small"
            type="primary"
            loading={fileBusy}
            onClick={() => void saveReport()}
            data-testid="report-file-save"
          >
            保存
          </Button>
          <Select
            size="small"
            style={{ minWidth: 210 }}
            placeholder="打开已保存的报表"
            value={undefined}
            options={savedReports.map((r) => ({
              label: r.sourceCount ? `${r.name}（${r.sourceCount} 个数据源）` : `${r.name}（无数据源）`,
              value: r.id,
            }))}
            onChange={(id: string) => void openReport(id)}
            data-testid="report-file-open"
          />
          <Button
            size="small"
            disabled={!reportId}
            loading={fileBusy}
            onClick={() => void runReport(reportId.trim())}
            data-testid="report-file-run"
          >
            执行
          </Button>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          保存的是「模板 + 数据源声明 + 渲染选项」，不是数据快照——打开时按声明现查。
          打开后一律进<b>自由模板</b>（它能表达任何模板，进去还能逐格改）。
          执行按文件里存的定义跑，与当前表单无关。
        </Typography.Text>

        {showQuery && (
          <>
            <Space wrap size="small">
              <Select
                size="small"
                style={{ minWidth: 180 }}
                data-testid="grid-report-database"
                placeholder="选择数据库"
                value={dbSelection.database}
                options={dbDatabases.map((d) => ({ label: d.label || d.name, value: d.name }))}
                onChange={(v) => void selectDatabase(v, dbDatabases.find((d) => d.name === v)?.engine)}
              />
              <Select
                size="small"
                style={{ minWidth: 180 }}
                data-testid="grid-report-table"
                placeholder="选择表"
                value={dbSelection.table}
                options={dbTables.map((t) => ({ label: t.name, value: t.name }))}
                onChange={(v) => void selectTable(v)}
              />
              <Input
                size="small"
                style={{ width: 320 }}
                placeholder="筛选条件（不含 WHERE，占位符用 ?），如 region = ?"
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                data-testid="grid-report-where"
              />
              <Input
                size="small"
                style={{ width: 200 }}
                placeholder='参数 JSON 数组，如 ["华东", 1000]'
                value={paramText}
                onChange={(e) => setParamText(e.target.value)}
                data-testid="grid-report-params"
              />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              筛选条件与参数留空即全表（引擎分支不同占位符不同：sqlite 用 ?，postgres 用 ? 或 $1）
            </Typography.Text>
          </>
        )}

        {mode === 'group' && (
          <>
            <Space wrap size="small">
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 260 }}
                placeholder="分组字段（从粗到细）"
                value={groupFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setGroupFields}
                data-testid="grid-report-group-fields"
              />
              <Select
                size="small"
                style={{ minWidth: 160 }}
                placeholder="数值字段"
                value={valueField || undefined}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setValueField}
                data-testid="grid-report-value-field"
              />
              <Select
                size="small"
                style={{ minWidth: 110 }}
                data-testid="grid-report-group-agg"
                value={groupAgg}
                options={[
                  { label: '求和', value: 'sum' },
                  { label: '计数', value: 'count' },
                  { label: '平均', value: 'avg' },
                  { label: '最大', value: 'max' },
                  { label: '最小', value: 'min' },
                ]}
                onChange={(v) => setGroupAgg(v as AggType)}
              />
            </Space>
            <AliasFields
              fields={[...groupFields, valueField]}
              aliases={aliases}
              onChange={setAliases}
              testid="grid-report-alias"
            />
            <FormatFields
              fields={[valueField]}
              formats={valueFormats}
              onChange={setValueFormats}
              testid="grid-report-format"
            />
          </>
        )}

        {mode === 'cross' && (
          <>
            <Space wrap size="small">
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 200 }}
                data-testid="grid-report-row-fields"
                placeholder="行字段（纵向）"
                value={rowFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setRowFields}
              />
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 200 }}
                data-testid="grid-report-col-fields"
                placeholder="列字段（横向）"
                value={colFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setColFields}
              />
              <Select
                size="small"
                mode="multiple"
                style={{ minWidth: 200 }}
                data-testid="grid-report-value-fields"
                placeholder="数值字段"
                value={crossValueFields}
                options={columnNames.map((n) => ({ label: n, value: n }))}
                onChange={setCrossValueFields}
              />
              <Select
                size="small"
                style={{ minWidth: 110 }}
                data-testid="grid-report-agg"
                value={crossAgg}
                options={[
                  { label: '求和', value: 'sum' },
                  { label: '计数', value: 'count' },
                  { label: '平均', value: 'avg' },
                  { label: '最大', value: 'max' },
                  { label: '最小', value: 'min' },
                ]}
                onChange={(v) => setCrossAgg(v as AggType)}
              />
            </Space>
            <AliasFields
              fields={[...rowFields, ...colFields, ...crossValueFields]}
              aliases={aliases}
              onChange={setAliases}
              testid="grid-report-cross-alias"
            />
            <FormatFields
              fields={crossValueFields}
              formats={valueFormats}
              onChange={setValueFormats}
              testid="grid-report-cross-format"
            />
          </>
        )}

        {mode === 'canvas' && (
          <>
            <Typography.Text type={canvasTable ? 'secondary' : 'warning'} style={{ fontSize: 12 }}>
              {canvasTable
                ? `已取到画布表格：${canvasTable.columns?.length ?? 0} 列`
                : '请先在画布里选中一个表格控件'}
            </Typography.Text>
            <AliasFields
              fields={(canvasTable?.columns ?? []).map((c) => stripArrayPrefix(c.field ?? ''))}
              aliases={aliases}
              onChange={setAliases}
              testid="grid-report-canvas-alias"
            />
            <FormatFields
              fields={(canvasTable?.columns ?? []).map((c) => stripArrayPrefix(c.field ?? ''))}
              formats={valueFormats}
              onChange={setValueFormats}
              testid="grid-report-canvas-format"
            />
          </>
        )}

        {mode === 'free' && (
          <>
            <Space wrap size="small">
              <Space size={4}>
                <Typography.Text style={{ fontSize: 12 }}>当前格</Typography.Text>
                <InputNumber
                  size="small"
                  style={{ width: 64 }}
                  min={1}
                  max={grid.length}
                  value={selRow}
                  onChange={(v: number | null) => setSelRow(v ?? 1)}
                  data-testid="free-sel-row"
                />
                <InputNumber
                  size="small"
                  style={{ width: 64 }}
                  min={1}
                  max={grid[0]?.length ?? 1}
                  value={selCol}
                  onChange={(v: number | null) => setSelCol(v ?? 1)}
                  data-testid="free-sel-col"
                />
              </Space>
              <Button size="small" onClick={() => applyGrid(insertGridRow(grid, selRow - 1))}>
                插入行
              </Button>
              <Button size="small" onClick={() => applyGrid(deleteGridRow(grid, selRow - 1))}>
                删除行
              </Button>
              <Button size="small" onClick={() => applyGrid(insertGridCol(grid, selCol - 1))}>
                插入列
              </Button>
              <Button size="small" onClick={() => applyGrid(deleteGridCol(grid, selCol - 1))}>
                删除列
              </Button>
              <Button
                size="small"
                onClick={() => {
                  try {
                    const tpl: ReportTemplate = { sheets: [gridToSheet(grid, '自由模板')] }
                    navigator.clipboard?.writeText(JSON.stringify(tpl, null, 2))
                  } catch {
                    /* 剪贴板不可用时静默 */
                  }
                }}
              >
                复制模板 JSON
              </Button>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              格内容写字面量或 <code>{'{{ds1.city}}'}</code>；插删行列会自动平移主格与表达式里的位置引用。
              格子的底色 / 字色就是它的语义，对照下方图例看。
            </Typography.Text>
            {parentTree.length > 0 && (
              <div
                data-testid="grid-report-parent-tree"
                style={{
                  border: '1px solid #f0f0f0',
                  borderRadius: 4,
                  padding: '6px 8px',
                  background: '#fcfcfc',
                }}
              >
                <Typography.Text style={{ fontSize: 12 }} strong>
                  主格树（行方向）
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {' '}
                  —— 谁挂在谁下面；点一格跳过去并点亮整条主格链
                </Typography.Text>
                <ParentTree tree={parentTree} selected={selectedPos} onPick={pickFromTree} />
              </div>
            )}
            {selCell && (
              <CellModelEditor
                pos={selectedPos}
                cell={selCell}
                columns={columnNames}
                merge={mergeAt(grid, selRow - 1, selCol - 1)}
                mergeError={mergeError}
                onMerge={(rows, cols) => {
                  const r = setGridMerge(grid, selRow - 1, selCol - 1, rows, cols)
                  if (r.ok) {
                    // 合并改了版面，必须让画布重建才能看见
                    applyGrid(r.grid)
                    setMergeError('')
                  } else {
                    // 拒绝理由原样显示：合并会丢数据，不能默默照做
                    setMergeError(r.message)
                  }
                }}
                onUnmerge={() => {
                  applyGrid(clearGridMerge(grid, selRow - 1, selCol - 1))
                  setMergeError('')
                }}
                onChange={(next) => applyGrid(setGridCell(grid, selRow - 1, selCol - 1, next))}
              />
            )}
            {tplWarnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                title="模板体检"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {tplWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                }
                data-testid="free-warnings"
              />
            )}
          </>
        )}

        {showQuery && (
          <>
            <Space wrap size="small">
              <Space size={4}>
                <Switch
                  size="small"
                  checked={paging}
                  onChange={(v: boolean) => setPaging(v)}
                  data-testid="grid-report-paging"
                />
                <Typography.Text style={{ fontSize: 12 }}>分页</Typography.Text>
              </Space>
              {paging && (
                <>
                  <Space size={4}>
                    <Typography.Text style={{ fontSize: 12 }}>每页数据行</Typography.Text>
                    <InputNumber
                      size="small"
                      style={{ width: 72 }}
                      min={1}
                      max={500}
                      value={rowsPerPage}
                      onChange={(v: number | null) => setRowsPerPage(v ?? 20)}
                      data-testid="grid-report-rows-per-page"
                    />
                  </Space>
                  <Space size={4}>
                    <Typography.Text style={{ fontSize: 12 }}>重复表头行</Typography.Text>
                    <InputNumber
                      size="small"
                      style={{ width: 64 }}
                      min={0}
                      max={10}
                      value={repeatHeader}
                      onChange={(v: number | null) => setRepeatHeader(v ?? 0)}
                      data-testid="grid-report-repeat-header"
                    />
                  </Space>
                  <Space size={4}>
                    <Typography.Text style={{ fontSize: 12 }}>重复表尾行</Typography.Text>
                    <InputNumber
                      size="small"
                      style={{ width: 64 }}
                      min={0}
                      max={10}
                      value={repeatFooter}
                      onChange={(v: number | null) => setRepeatFooter(v ?? 0)}
                      data-testid="grid-report-repeat-footer"
                    />
                  </Space>
                </>
              )}
              <Space size={4}>
                <Switch
                  size="small"
                  checked={dump}
                  onChange={(v: boolean) => setDump(v)}
                  data-testid="grid-report-dump"
                />
                <Typography.Text style={{ fontSize: 12 }}>调试（展开中间结果）</Typography.Text>
              </Space>
              <Space size={4}>
                <Switch
                  size="small"
                  checked={exportFormula}
                  onChange={(v: boolean) => setExportFormula(v)}
                  data-testid="grid-report-export-formula"
                />
                <Typography.Text style={{ fontSize: 12 }}>导出公式</Typography.Text>
              </Space>
              {/*
                自由模板不显示这三个：它们靠「猜最内/最外层」打在不同层级上，
                而自由模板的层级是用户一格一格定的，让它再猜一遍会覆盖用户意图。
              */}
              {mode !== 'free' && (
                <>
                  <Space size={4}>
                    <Typography.Text style={{ fontSize: 12 }}>最少行数</Typography.Text>
                    <InputNumber
                      size="small"
                      style={{ width: 64 }}
                      min={0}
                      max={999}
                      value={expandMin}
                      onChange={(v: number | null) => setExpandMin(v ?? 0)}
                      data-testid="grid-report-expand-min"
                    />
                  </Space>
                  <Space size={4}>
                    <Typography.Text style={{ fontSize: 12 }}>最多条数</Typography.Text>
                    <InputNumber
                      size="small"
                      style={{ width: 64 }}
                      min={0}
                      max={9999}
                      value={expandMax}
                      onChange={(v: number | null) => setExpandMax(v ?? 0)}
                      data-testid="grid-report-expand-max"
                    />
                  </Space>
                  <Space size={4}>
                    <Switch
                      size="small"
                      checked={keepExpandEmpty}
                      onChange={(v: boolean) => setKeepExpandEmpty(v)}
                      data-testid="grid-report-keep-empty"
                    />
                    <Typography.Text style={{ fontSize: 12 }}>空数据保留</Typography.Text>
                  </Space>
                </>
              )}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              分页按「数据行」计数，不含每页重复的表头/表尾。预览区始终展示未分页的完整表；
              「导出 xlsx」按页出 sheet（每页一个）。
              {exportFormula && (
                <>
                  {' '}
                  导出公式：小计 / 合计落成 Excel 公式，导出后改明细会自动重算；
                  <b>分页导出时会自动回落写值</b>（公式坐标按整表生成，逐页复制后行号对不上）。
                </>
              )}
              {(expandMin > 0 || expandMax > 0 || keepExpandEmpty) && (
                <>
                  {' '}
                  展开控制（0 = 不限制）：<b>最少行数</b>作用于最内层明细（每组至少 N 行），
                  <b>最多条数</b>作用于最外层分组（TOP N 个分组）；多级分组下逐级生效。
                </>
              )}
            </Typography.Text>
          </>
        )}
      </Space>

      {error && (
        <Alert
          type="warning"
          showIcon
          title="渲染失败，下面为服务端生成的 HTML 兜底"
          description={error}
          style={{ marginBottom: 12 }}
        />
      )}

      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="模板告警（表照常出，但数据可能不是你要的）"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          }
          style={{ marginBottom: 12 }}
          data-testid="grid-report-warnings"
        />
      )}

      <div style={{ position: 'relative', height: '52vh' }} data-testid="grid-report-container">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(255,255,255,0.6)',
            }}
          >
            <Spin tip="正在从 18888 拉取展开结果…" />
          </div>
        )}
        {error && fallbackHtml && (
          <div style={{ maxHeight: '52vh', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: fallbackHtml }} />
        )}
      </div>

      {/*
        语义图例：格子的底色 / 字色是**非线性语义的唯一可见载体**（文本不能加标记，
        因为文本就是回写载体）。没有图例的话这些颜色只是"看起来好看"，用户解码不了。
      */}
      {mode === 'free' && (
        <div
          data-testid="grid-report-semantic-legend"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 16px',
            alignItems: 'center',
            marginTop: 8,
            fontSize: 12,
            color: '#555',
          }}
        >
          {SEMANTIC_LEGEND.map((it) => (
            <span key={it.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 22,
                  height: 15,
                  lineHeight: '15px',
                  textAlign: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 2,
                  border: it.swatch === 'border' ? `2px solid ${it.fg}` : '1px solid #d9d9d9',
                  background: it.bg ?? '#fff',
                  color: it.fg ?? '#333',
                  fontStyle: it.italic ? 'italic' : 'normal',
                }}
              >
                Aa
              </span>
              {it.label}
            </span>
          ))}
          <span style={{ color: '#888' }}>
            · 选中一格会点亮它的<b>整条主格链</b>（橙底）；层次看上方主格树
          </span>
        </div>
      )}

      {dumpText && (
        <details style={{ marginTop: 12 }} data-testid="grid-report-dump-panel">
          <summary style={{ fontSize: 12, cursor: 'pointer' }}>
            展开中间结果（层次坐标 / 父格）
          </summary>
          <pre
            style={{
              maxHeight: 200,
              overflow: 'auto',
              fontSize: 11,
              lineHeight: 1.5,
              background: '#fafafa',
              border: '1px solid #f0f0f0',
              padding: 8,
              margin: '8px 0 0',
            }}
          >
            {dumpText}
          </pre>
        </details>
      )}
    </Modal>
  )
}
