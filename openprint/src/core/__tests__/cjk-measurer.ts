import type { TextMeasureOptions, TextMeasurer } from '@/core/layout-engine/measure'

/**
 * 测试用确定性 CJK 估算测量器。
 *
 * 不依赖任何 DOM（happy-dom 不实现真实 CSS 布局），用字符宽度估算，
 * 保证分页单测在 CI / node 下结果稳定、可复现。
 * 估算规则：CJK 字符 ≈ 1em 宽，ASCII ≈ 0.6em 宽；行高 = lineHeight × fontSize(pt→mm)。
 */
export function createCjkMeasurer(): TextMeasurer {
  return {
    measure(text: string, o: TextMeasureOptions) {
      const fsMm = (o.fontSize * 25.4) / 72 // pt → mm
      const lineH = (o.lineHeight ?? 1.35) * fsMm
      const charW = fsMm // CJK 近似 1em
      const asciiW = fsMm * 0.6
      const lines = text.split('\n')
      let totalH = 0
      let lineCount = 0
      for (const ln of lines) {
        let w = 0
        for (const ch of ln) w += /[\x00-\xff]/.test(ch) ? asciiW : charW
        const wrapped =
          o.widthMm > 0 && o.wrap !== false ? Math.max(1, Math.ceil(w / o.widthMm)) : 1
        totalH += wrapped * lineH
        lineCount += wrapped
      }
      return { heightMm: totalH, lines: lineCount }
    },
    dispose() {
      /* 无资源可释放 */
    },
  }
}
