/**
 * Headless 字体加载器
 *
 * - re-export `export-engine/fonts` 的嵌字工具（让栅格化 / 打印文档用上自定义字体）
 * - `loadFonts`：用 FontFace API 把同源字体注册到**当前文档**，
 *   供设计器预览 / 浏览器打印的同源文档（iframe srcdoc）使用。
 *
 * 注意：`loadFonts` 注册的是「文档级」字体，预览/打印文档只要同源就能用；
 * 而栅格化（SVG `<img>`）是隔离上下文，必须用 `embedFontsInSvg` 把字体写进 SVG 本身。
 */
export {
  type FontFaceDef,
  embedFontsInSvg,
  embedFontsInHtml,
} from '@/core/export-engine/fonts'

/** 把同源字体注册到当前文档（供同源预览 / 打印使用）。返回反注册函数。 */
export async function loadFonts(defs: import('@/core/export-engine/fonts').FontFaceDef[]): Promise<() => void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return () => {}
  const fontsApi = (document as unknown as { fonts: { add(f: FontFace): void; delete(f: FontFace): void } }).fonts
  const faces: FontFace[] = []
  for (const d of defs) {
    const ff = new FontFace(d.family, `url(${d.src})`, {
      weight: d.weight !== undefined ? String(d.weight) : 'normal',
      style: d.style ?? 'normal',
    })
    await ff.load()
    fontsApi.add(ff)
    faces.push(ff)
  }
  return () => {
    for (const ff of faces) fontsApi.delete(ff)
  }
}
