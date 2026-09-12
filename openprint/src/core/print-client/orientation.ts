/**
 * 打印方向偏好解析 —— 打印弹窗 / 流水标签弹窗共用
 *
 * 模板可设计方向（页面设置），但部分打印机纸张方向"反直觉"（如模板横向、打印机却按
 * 纵向出纸）。故打印面板提供三态：跟随模板（默认）/ 纵向 / 横向 —— 渲染仍按模板方向
 * 出 PDF，打印时由客户端按所选方向旋转，不改文档排版。
 */

/** 方向偏好：auto=跟随模板页面设置，portrait/landscape=打印时强制覆盖 */
export type OrientationPref = 'auto' | 'portrait' | 'landscape'

/**
 * 解析实际打印方向。
 * @param pref 用户选择（auto = 跟随模板）
 * @param templateOrientation 模板页面设置方向（store.pageSetup.orientation）
 */
export function resolvePrintOrientation(
  pref: OrientationPref,
  templateOrientation?: string,
): 'portrait' | 'landscape' {
  if (pref === 'auto') {
    return templateOrientation === 'landscape' ? 'landscape' : 'portrait'
  }
  return pref
}
