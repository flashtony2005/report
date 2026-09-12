/**
 * 数据导入的共享类型
 *
 * 放在 types 层而非 design 层：排版引擎（placeholder-scan）需要识别导入列，
 * 但引擎不得反向依赖设计器 UI 层，否则 SDK 打包会把 design 拖进来。
 */
/** 导入数据的列定义 */
export interface ImportColumn {
  /** 数据键（来自原表头；重命名标题不影响数据映射） */
  key: string
  /** 显示标题（默认等于 key，可在弹窗中编辑） */
  title: string
}
