import { describe, expect, it } from 'vitest'
import { FONT_CATALOG, findFontFamily } from '@/core/fonts/catalog'
import { builtinFontFaceCss, templateUsedFonts } from '@/core/fonts/loader'
import type { TemplateData } from '@/types/template'
import type { AnyControl } from '@/types/control'

describe('fonts —— 内置字体包', () => {
  it('目录覆盖参考资料 fonts.txt 全部字体族', () => {
    const families = FONT_CATALOG.map((f) => f.family)
    // fonts.txt 定义的名称（中文名/拉丁名）
    expect(families).toContain('思源黑体')
    expect(families).toContain('思源宋体')
    expect(families).toContain('寒蝉正楷体')
    expect(families).toContain('Liberation Serif')
    expect(families).toContain('Hedvig Letters Sans')
    // Liberation Serif 一个族包含 3 个字重/字形
    const lib = FONT_CATALOG.find((f) => f.family === 'Liberation Serif')
    expect(lib?.faces.length).toBe(3)
  })

  it('builtinFontFaceCss 生成合法 @font-face 且含 format', () => {
    const css = builtinFontFaceCss('http://localhost:5173')
    expect(css).toContain('@font-face')
    expect(css).toContain('font-family:"思源黑体"')
    expect(css).toContain('format("woff2")')
    expect(css).toContain('format("truetype")') // 思源宋体 ttf
    expect(css).toContain('http://localhost:5173/fonts/SourceHanSansCN-Normal.woff2')
  })

  it('templateUsedFonts 只提取模板实际用到的字体族', () => {
    const tpl: TemplateData<AnyControl> = {
      version: '1.0',
      document: {
        type: 'report',
        page: { width: 210, height: 297, unit: 'mm', orientation: 'portrait', margin: { top: 10, right: 10, bottom: 10, left: 10 } },
        sections: [
          {
            type: 'body',
            components: [
              { id: 't1', type: 'text', left: 0, top: 0, width: 50, height: 8, value: 'x', style: { fontFamily: '思源黑体' }, printable: true },
              { id: 't2', type: 'text', left: 0, top: 10, width: 50, height: 8, value: 'y', printable: true },
            ],
          },
        ],
      },
    }
    const used = templateUsedFonts(tpl)
    expect(used.map((f) => f.family)).toEqual(['思源黑体'])
  })

  it('findFontFamily 容错带引号的族名', () => {
    expect(findFontFamily('"思源宋体"')?.family).toBe('思源宋体')
    expect(findFontFamily('思源黑体, sans-serif')?.family).toBe('思源黑体')
    expect(findFontFamily(undefined)).toBeUndefined()
  })
})
