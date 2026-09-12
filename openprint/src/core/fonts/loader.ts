/**
 * 字体本地加载（《设计方案》§11.6 @open-print/fonts loader）
 *
 * - `loadBuiltinFonts()`：用 FontFace API 把内置字体注册到浏览器（设计期画布/预览生效），
 *   字体文件来自 public/fonts/ 同源静态资源，零网络依赖。
 * - `builtinFontFaceCss(baseUrl)`：生成 @font-face CSS（预览 iframe 注入用）。
 * - `templateUsedFonts(template)`：提取模板文本控件实际用到的字体族（供导出内联）。
 */
import { FONT_CATALOG, findFontFamily, type FontFamilyDef } from './catalog'
import type { TemplateData } from '@/types/template'
import type { AnyControl, TextControl } from '@/types/control'
import type { FontFaceDef } from '@/core/export-engine/fonts'

/** 浏览器环境是否可用 FontFace API */
function canUseFontFace(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { FontFace?: unknown }).FontFace !== 'undefined'
}

/** 把内置字体注册到 document.fonts（浏览器）；resolve 后返回已加载的族名列表 */
export async function loadBuiltinFonts(defs: FontFamilyDef[] = FONT_CATALOG): Promise<string[]> {
  if (!canUseFontFace() || typeof document === 'undefined' || typeof window === 'undefined') return []
  const FontFaceCtor = (
    window as unknown as {
      FontFace?: new (family: string, source: string | ArrayBuffer, descriptors?: FontFaceDescriptors) => FontFace
    }
  ).FontFace
  if (!FontFaceCtor) return []
  const loaded: string[] = []
  const tasks: Promise<void>[] = []
  for (const def of defs) {
    for (const face of def.faces) {
      try {
        const fontFace = new FontFaceCtor(
          def.family,
          `url(${new URL(face.src, window.location.origin).href})`,
          {
            weight: String(face.weight ?? 'normal'),
            style: face.style ?? 'normal',
          },
        )
        tasks.push(
          fontFace.load().then(() => {
            document.fonts.add(fontFace)
            if (!loaded.includes(def.family)) loaded.push(def.family)
          }),
        )
      } catch {
        /* 单字体失败不阻塞整体 */
      }
    }
  }
  await Promise.allSettled(tasks)
  return loaded
}

/** 生成内置字体的 @font-face CSS 块（baseUrl 用于拼字体绝对/相对路径） */
export function builtinFontFaceCss(baseUrl: string): string {
  return FONT_CATALOG.map((def) =>
    def.faces
      .map((face) => {
        const src = face.src.startsWith('/') ? `${baseUrl.replace(/\/+$/, '')}${face.src}` : face.src
        const ext = src.split('?')[0]?.split('.').pop()?.toLowerCase()
        const format = ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : ext === 'woff' ? 'woff' : 'woff2'
        return (
          `@font-face{font-family:"${def.family}";` +
          `src:url(${src}) format("${format}");` +
          `font-weight:${face.weight ?? 'normal'};font-style:${face.style ?? 'normal'};}`
        )
      })
      .join(''),
  ).join('')
}

/** 提取模板中实际用到的内置字体族（供导出/无头打印内联，避免全量内联） */
export function templateUsedFonts(template: TemplateData<AnyControl>): FontFamilyDef[] {
  const used = new Set<string>()
  const walk = (comps: AnyControl[]): void => {
    for (const c of comps) {
      if (c.type === 'text') {
        const family = (c as TextControl).style?.fontFamily
        const def = findFontFamily(family)
        if (def) used.add(def.family)
      }
      if (c.type === 'zone') walk(c.children)
    }
  }
  for (const section of template.document.sections) walk(section.components as AnyControl[])
  return FONT_CATALOG.filter((f) => used.has(f.family))
}

/** 转为导出引擎的 FontFaceDef（data-URI 内联用） */
export function toExportFontDefs(defs: FontFamilyDef[]): FontFaceDef[] {
  return defs.flatMap((def) =>
    def.faces.map((face) => ({
      family: def.family,
      src: face.src,
      weight: face.weight,
      style: face.style,
    })),
  )
}
