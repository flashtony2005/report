/**
 * 表格样式预设元数据 —— 设计期「样式库」弹窗与属性面板共用的唯一真相源。
 *
 * 每个预设对应 css-generator.ts 里的一组 `.op-table.ts-<key>` 规则；
 * 渲染端（table-design-render.ts / html-renderer.ts）把同名 class 挂在 <table> 上，
 * 因此画布、预览、PDF、样式库预览四端视觉完全一致。
 *
 * 预设不只是"配色"——`borders` 可捆绑边框框线方案（如三线表 / 外框 / 全网格），
 * 点击即同时套用配色与框线，类似 Excel 把"表格样式"与"框线"打包切换。
 */
import type { TableStylePreset } from '@/types/control'

export interface TableStyleMeta {
  /** 对应 <table> 上的 ts-<key> class 与 TableOptions.tableStyle 取值 */
  key: TableStylePreset
  /** 展示名（按钮 / 卡片标题） */
  label: string
  /** 一句话描述，帮助快速区分相近样式 */
  desc: string
  /** 可选：捆绑的边框框线方案；不填则只改配色、保留当前边框 */
  borders?: 'all' | 'none' | 'horizontal' | 'outline' | 'three-line'
}

/** Excel 式表格样式库（按"从简到繁 / 配色 → 框线"排列） */
export const TABLE_STYLE_PRESETS: TableStyleMeta[] = [
  { key: 'none', label: '无样式', desc: '仅边框 + 表头加粗，无任何背景' },
  { key: 'header', label: '表头高亮', desc: '浅灰表头' },
  { key: 'header-dark', label: '深蓝表头', desc: '深蓝底白字' },
  { key: 'header-green', label: '绿色表头', desc: '绿底白字' },
  { key: 'zebra', label: '斑马纹', desc: '浅蓝交替行' },
  { key: 'zebra-blue', label: '蓝纹', desc: '深蓝交替行' },
  { key: 'zebra-gray', label: '灰纹', desc: '灰色交替行' },
  { key: 'three-segment', label: '三段式', desc: '表头 + 合计强调' },
  { key: 'banded-cols', label: '隔列着色', desc: '奇偶列交替底' },
  // —— 框线类（配色 + 边框打包） ——
  { key: 'grid', label: '全网格', desc: '全框线 + 无配色', borders: 'all' },
  { key: 'minimal', label: '极简外框', desc: '仅外框、无内线', borders: 'outline' },
  { key: 'report', label: '三线表', desc: '顶/表头底/底线，无内线（报表风）', borders: 'three-line' },
  { key: 'timetable', label: '课表', desc: '全网格 + 表头高亮（角标斜线见单元格）', borders: 'all' },
]

/** 预设 key → 展示名（未知值回落「无样式」） */
export function tableStyleLabel(key: TableStylePreset | undefined | null): string {
  return TABLE_STYLE_PRESETS.find((p) => p.key === key)?.label ?? '无样式'
}
