/**
 * TextProps —— 文本控件属性面板（React 版）
 *
 * 与 Vue 版 `panels/props/TextProps.vue` 行为一致：内容三态 + 数据格式 + 排版样式。
 * 业务决策（模式判别/切换、格式补丁、样式合并）全部来自**共享的 panel-logic**，
 * 本组件只负责渲染与把 patch 交给 store —— 两端行为漂移在逻辑层被物理杜绝。
 *
 * P3.1 裁剪：字体下拉暂只含「预设字体」（系统字体运行时 core/fonts/system.ts
 * 仍依赖 vue，P3.2 迁移后接入）。
 */
import { Button, ColorPicker, InputNumber, Radio, Select } from 'antd'
import type { RadioChangeEvent } from 'antd'
import type { TextControl, TextStyle } from '@/types/control'
import { FONT_CATALOG } from '@/core/fonts/catalog'
import { useSystemFonts } from '../../hooks/useSystemFonts'
import {
  currencyCodeOptions,
  datePatternOptions,
  formatKindOptions,
  needsCode,
  needsDigits,
  needsPattern,
  supportsThousands,
} from '@/design/format-options'
import {
  contentModePatch,
  formatHint as formatHintOf,
  formatKindFirstPatch,
  formatPatch,
  isPresetDatePattern,
  mergeStyle,
  resolveContentMode,
  type ContentMode,
} from '@/design/panels/props/shared/panel-logic'
import { useDesignerStore } from '../../stores/designer'
import { selectActiveFields, useDataSourceStore } from '../../stores/dataSource'
import { useSelectedControl } from '../../stores/selectors'
import ContentValueEditor from './ContentValueEditor'

/** 颜色快选（与 Vue 版 swatches 一致） */
const SWATCHES = ['#000000', '#333333', '#666666', '#999999', '#1677FF', '#F5222D']

export default function TextProps() {
  const control = useSelectedControl() as TextControl | null

  if (!control) return null

  const updateControl = useDesignerStore.getState().updateControl
  const patch = (p: Record<string, unknown>): void => updateControl(control.id, p)
  const patchStyle = (p: Partial<TextStyle>): void => {
    patch({ style: mergeStyle(control, p).style })
  }

  /* ---------- 内容模式 ---------- */
  const contentMode = resolveContentMode(control)
  const onModeChange = (m: ContentMode): void => patch(contentModePatch(m))

  /* ---------- 数据格式 ---------- */
  const textFormat = control.format ?? { kind: 'none' as const }
  // 绑定字段在数据源里的类型 → 建议文案（字段列表低频变化，此处直接读即可）
  const boundFieldType = control.binding
    ? selectActiveFields(useDataSourceStore.getState()).find((f) => f.path === control.binding)
        ?.type
    : undefined
  const hint = formatHintOf(boundFieldType)

  const patchFormat = (fmt: typeof textFormat): void => patch({ format: formatPatch(fmt) })

  /* ---------- 样式 ---------- */
  const style = control.style ?? {}
  const isBold = (style.fontWeight ?? 'normal') === 'bold'
  const isItalic = (style.fontStyle ?? 'normal') === 'italic'
  const isUnderline = (style.textDecoration ?? 'none') === 'underline'

  // 字体下拉：预设 + 电脑系统字体（打印客户端连接时出现分组，对齐 Vue 版）
  const sysFonts = useSystemFonts()
  const builtinFonts = FONT_CATALOG.map((f) => ({ label: f.label, value: f.family }))
  const fontOptions = sysFonts.ready
    ? [
        { label: '预设字体', title: 'group', options: builtinFonts },
        {
          label: `电脑系统字体（${sysFonts.count}）`,
          title: 'group',
          options: sysFonts.grouped.map((g) => ({ label: g.family, value: g.family })),
        },
        { label: '系统默认', value: '' },
      ]
    : [{ label: '系统默认', value: '' }, ...builtinFonts]

  return (
    <>
      <div className="props-section">
        <div className="props-title">内容设置</div>

        <ContentValueEditor
          mode={contentMode}
          value={control.value ?? ''}
          binding={control.binding ?? ''}
          expression={control.expression ?? ''}
          placeholder="文本内容"
          fixedDefault="文本"
          bindingDefault="order.orderNo"
          expressionDefault="{{order.total}}"
          onModeChange={onModeChange}
          onValueChange={(v) => patch({ value: v })}
          onBindingChange={(v) => patch({ binding: v })}
          onExpressionChange={(v) => patch({ expression: v || undefined })}
        />

        {contentMode === 'variable' && (
          <div className="props-section">
            <div className="props-title">数据格式</div>
            {hint && <div className="props-tip">{hint}</div>}

            <div className="props-row">
              <span className="props-label">类型</span>
              <Select
                size="small"
                value={textFormat.kind}
                options={formatKindOptions}
                onChange={(kind) => patch({ format: formatKindFirstPatch(control.format, kind) })}
              />
            </div>

            {needsPattern(textFormat.kind) && (
              <div className="props-row">
                <span className="props-label">日期模板</span>
                <Select
                  size="small"
                  value={isPresetDatePattern(textFormat.pattern) ? textFormat.pattern : '__custom__'}
                  options={datePatternOptions}
                  onChange={(v) => {
                    if (v !== '__custom__') patchFormat({ ...textFormat, kind: 'date', pattern: v })
                  }}
                />
              </div>
            )}
            {needsPattern(textFormat.kind) && !isPresetDatePattern(textFormat.pattern) && (
              <div className="props-row">
                <span className="props-label">自定义</span>
                <input
                  className="props-input"
                  value={textFormat.pattern ?? 'YYYY-MM-DD'}
                  placeholder="YYYY-MM-DD HH:mm"
                  onChange={(e) =>
                    patchFormat({
                      ...textFormat,
                      kind: 'date',
                      pattern: e.target.value || 'YYYY-MM-DD',
                    })
                  }
                />
              </div>
            )}

            {needsDigits(textFormat.kind) && (
              <div className="props-row">
                <span className="props-label">小数位</span>
                <InputNumber
                  size="small"
                  min={0}
                  max={6}
                  precision={0}
                  value={textFormat.digits ?? 2}
                  onChange={(v) => patchFormat({ ...textFormat, digits: v ?? 0 })}
                />
              </div>
            )}

            {needsCode(textFormat.kind) && (
              <div className="props-row">
                <span className="props-label">币种</span>
                <Select
                  size="small"
                  value={textFormat.code ?? 'CNY'}
                  options={currencyCodeOptions}
                  onChange={(v) => patchFormat({ ...textFormat, kind: 'currency', code: v })}
                />
              </div>
            )}

            {supportsThousands(textFormat.kind) && (
              <div className="props-row">
                <span className="props-label">千分位</span>
                <Radio.Group
                  size="small"
                  value={textFormat.thousands === false ? 'off' : 'on'}
                  optionType="button"
                  options={[
                    { label: '开', value: 'on' },
                    { label: '关', value: 'off' },
                  ]}
                  onChange={(e: RadioChangeEvent) => patchFormat({ ...textFormat, thousands: e.target.value === 'on' })}
                />
              </div>
            )}

            <Button size="small" type="text" onClick={() => patch({ format: undefined })}>
              清除格式
            </Button>
          </div>
        )}
      </div>

      <div className="props-section">
        <div className="props-title">排版设置</div>

        <div className="grid grid-cols-2 gap-2">
          <div className="props-row">
            <span className="props-label">字号</span>
            <InputNumber
              size="small"
              min={6}
              max={72}
              precision={1}
              value={style.fontSize ?? 12}
              onChange={(v) => patchStyle({ fontSize: v ?? 12 })}
            />
          </div>
          <div className="props-row">
            <span className="props-label">行高</span>
            <InputNumber
              size="small"
              min={0.8}
              max={4}
              step={0.05}
              precision={2}
              value={style.lineHeight ?? 1.16}
              onChange={(v) => patchStyle({ lineHeight: v ?? 1.16 })}
            />
          </div>
        </div>

        <div className="props-row">
          <span className="props-label">样式</span>
          <div className="flex items-center gap-1">
            <Button size="small" type={isBold ? 'primary' : 'default'} title="加粗" onClick={() => patchStyle({ fontWeight: isBold ? 'normal' : 'bold' })}>
              <b>B</b>
            </Button>
            <Button size="small" type={isItalic ? 'primary' : 'default'} title="斜体" onClick={() => patchStyle({ fontStyle: isItalic ? 'normal' : 'italic' })}>
              <i>I</i>
            </Button>
            <Button size="small" type={isUnderline ? 'primary' : 'default'} title="下划线" onClick={() => patchStyle({ textDecoration: isUnderline ? 'none' : 'underline' })}>
              <u>U</u>
            </Button>
          </div>
        </div>

        <div className="props-row">
          <span className="props-label">对齐</span>
          <Radio.Group
            size="small"
            value={style.textAlign ?? 'left'}
            optionType="button"
            options={[
              { label: '左', value: 'left' },
              { label: '中', value: 'center' },
              { label: '右', value: 'right' },
            ]}
            onChange={(e: RadioChangeEvent) => patchStyle({ textAlign: e.target.value as TextStyle['textAlign'] })}
          />
        </div>

        <div className="props-row">
          <span className="props-label">字体</span>
          <Select
            size="small"
            showSearch
            value={style.fontFamily ?? ''}
            options={fontOptions}
            placeholder="系统默认"
            onChange={(v) => patchStyle({ fontFamily: v || undefined })}
          />
        </div>

        <div className="props-row">
          <span className="props-label">颜色</span>
          <ColorPicker
            size="small"
            value={style.fill ?? '#000000'}
            // antd 6：色板条以 presets 分组承载（等价 Vue 版 swatches）
            presets={[{ label: '常用', colors: SWATCHES, defaultOpen: true }]}
            onChange={(c) => patchStyle({ fill: c.toHexString() })}
          />
        </div>

        <div className="props-row">
          <span className="props-label">字距</span>
          <InputNumber
            size="small"
            step={0.5}
            precision={1}
            value={style.letterSpacing ?? 0}
            onChange={(v) => patchStyle({ letterSpacing: v ?? 0 })}
          />
        </div>
      </div>
    </>
  )
}
