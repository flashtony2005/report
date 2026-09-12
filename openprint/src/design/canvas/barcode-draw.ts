/**
 * @bwip-js/generic → Canvas 2D 适配器
 *
 * 改用官方 toSVG() 生成条码（含人眼可读数字的人体化矢量路径，无字体依赖），
 * 再栅格化到离屏 canvas 供 Fabric 显示。
 * 原先的手写 CanvasDrawing 适配器对人眼可读文字的测量/绘制有缺陷，
 * 导致画布上条码下方的数字不显示（预览走 toSVG 正常，故仅画布有此问题）。
 */
import * as BwipJs from '@bwip-js/generic'

export interface BarcodeDrawOptions {
  /** bwip-js bcid，如 code128 / ean13 */
  format?: string
  text: string
  showText?: boolean
  /** 条码条本身高度（mm）。bwip-js 的 height 选项只管条码条，不含文字行 */
  barHeightMM?: number
  /** 上下留白（mm），给文字行呼吸空间，避免贴边 */
  paddingMM?: number
  /** 目标宽度（mm）：bwip-js 据此调整条码条粗细（module width），宽度可独立控制且不变形。缺省按 scale 自然宽 */
  widthMM?: number
}

/** 把 bwip-js 的 SVG 字符串栅格化到离屏 canvas（人眼可读数字以矢量路径渲染，天然可见） */
function svgToCanvas(svg: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    img.onload = () => {
      const w = img.naturalWidth || parseSvgSize(svg, 'width')
      const h = img.naturalHeight || parseSvgSize(svg, 'height')
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, w)
      canvas.height = Math.max(1, h)
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('no 2d context'))
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas)
    }
    img.onerror = () => reject(new Error('barcode svg decode failed'))
    img.src = url
  })
}

/** SVG 未带 width/height 时从 viewBox 兜底解析 */
function parseSvgSize(svg: string, attr: 'width' | 'height'): number {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
  if (vb) return Number(vb[attr === 'width' ? 1 : 2]) || 1
  const m = new RegExp(`${attr}="(\\d+)"`).exec(svg)
  return m ? Number(m[1]) || 1 : 1
}

/**
 * 渲染条码到离屏 canvas（失败返回 null，由调用方降级为占位）
 *
 * 关键：barHeightMM + paddingMM 让 bwip-js 直接按目标几何渲染，
 * canvas 自然尺寸 ≈ 控件尺寸，调用方 scaleY ≈ 1，文字行不再被压扁。
 * （原先只用 scale:3 生成自然尺寸位图，再被调用方 Y 方向压缩，导致文字看不见。）
 */
export async function drawBarcode(options: BarcodeDrawOptions): Promise<HTMLCanvasElement | null> {
  try {
    const barHeight = options.barHeightMM ?? 10
    const padding = options.paddingMM ?? 2
    const svg = BwipJs.toSVG({
      bcid: (options.format ?? 'code128').toLowerCase(),
      text: options.text || '0123456789',
      scale: 2,
      height: barHeight,
      // 目标宽度（mm）：bwip-js 会据此调整 module width，条码条粗细适配宽度且不变形。
      // 注意 bwip-js 以 72dpi 换算像素，而宿主画布是 96dpi，宽度补偿见调用方。
      ...(options.widthMM ? { width: options.widthMM } : {}),
      paddingtop: padding,
      paddingbottom: padding,
      includetext: options.showText ?? true,
      textxalign: 'center',
      // BWIPP textsize（单位 point，默认 9），调到 12 让人眼可读数字更醒目
      textsize: 12,
    })
    return await svgToCanvas(svg)
  } catch {
    return null
  }
}
