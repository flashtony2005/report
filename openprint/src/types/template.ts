/**
 * OpenPrint 模板协议 —— 顶层结构类型
 * 真理源：《OpenPrint-设计方案.md》§5.1 / §13.1
 *
 * 结构：Document → Page → Section → Component
 * page 一律存精确数字尺寸（width + height + unit），不存预设别名。
 */

/** 协议层只接受 mm / in / pt 三种单位（Renderer 内部全部换算成 mm） */
export type PageUnit = 'mm' | 'in' | 'pt'

export interface PageMargin {
  top: number
  bottom: number
  left: number
  right: number
}

export interface PageSetup {
  /** 宽（unit 单位下的精确数字，物理尺寸：横向时宽>高） */
  width: number
  /** 高 */
  height: number
  unit: PageUnit
  /** 方向标志（设计器面板切换方向时已交换 width/height，此处为派生值） */
  orientation: 'portrait' | 'landscape'
  margin: PageMargin
  /** 画布页面背景色（rgba / hex；缺省 = 白底） */
  backgroundColor?: string
  /** 水印配置（缺省 = 无） */
  watermark?: WatermarkConfig
  /** 手动分页下限：物理页数至少为 N（0/缺省 = 完全由内容推导） */
  minPages?: number
}

/**
 * 水印配置（页面级装饰，随模板持久化）
 * - mode 由 `tile` 表示：false = 居中单个水印；true = 全页平铺
 * - fontSize / rotation 单位分别为 mm / 度
 */
export interface WatermarkConfig {
  /** 是否启用 */
  enabled: boolean
  /** 水印文本 */
  text: string
  /** 文本颜色（rgba / hex） */
  color: string
  /** 字号（mm） */
  fontSize: number
  /** 旋转角度（度，默认 45） */
  rotation: number
  /** true = 全页平铺；false = 居中单个 */
  tile: boolean
}

/** 页面装饰（背景 + 水印），渲染/导出管线统一消费 */
export interface PageDecoration {
  backgroundColor?: string
  watermark?: WatermarkConfig
}

/** 页眉 / 页脚区块；body 为正文（唯一且必须存在） */
export type SectionType = 'header' | 'body' | 'footer'

export interface Section<C = unknown> {
  type: SectionType
  /** header/footer 必填，单位与 page.unit 一致 */
  height?: number
  /** 是否每页重复（仅 header/footer 有意义，默认 true） */
  repeat?: boolean
  components: C[]
}

export interface Document<C = unknown> {
  /** 文档类型，当前仅 report */
  type: 'report'
  page: PageSetup
  sections: Section<C>[]
}

export interface TemplateData<C = unknown> {
  version: string
  document: Document<C>
}

/** 画布网格配置（运行时视图状态，辅助设计，不持久化） */
export interface GridConfig {
  /** 是否显示网格线 */
  visible: boolean
  /** 网格间距（mm） */
  sizeMm: number
  /** 网格线颜色（rgba / hex） */
  color: string
}
