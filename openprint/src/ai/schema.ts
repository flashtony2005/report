/**
 * AI 助手 —— 前端预设的提示词与 few-shot 示例（无后端、纯常量）。
 *
 * 协议要点（节选自项目《OpenPrint-设计方案》§5）：
 *   TemplateData = { version, document }
 *   document = { type:'report', page, sections:[...] }
 *   page = { width, height, unit:'mm', orientation:'portrait'|'landscape',
 *            margin:{top,bottom,left,right}, backgroundColor?, watermark? }
 *   section = { type:'header'|'body'|'footer', height?, repeat?, components:[...] }
 *   component 公共：{ id?, type, left, top, width, height, angle?, printable?, ... }
 *   坐标系：mm。⚠️ left/top 是相对「内容区（页边距内侧）左上角」的偏移，渲染器会自动叠加页边距——你不要再算 margin 进去。
 */

const PROTOCOL_SUMMARY = `你是 OpenPrint 打印模板设计助手。根据用户用中文描述的排版需求，生成一份「打印模板」JSON。

模板协议（必须遵守）：
- 顶层：{ "version": "1.0.0", "document": { "type": "report", "page": {...}, "sections": [...] } }
- page：{ "width": 数字, "height": 数字, "unit": "mm", "orientation": "portrait"|"landscape", "margin": { "top": 数字, "bottom": 数字, "left": 数字, "right": 数字 }, "backgroundColor"?: "#ffffff" }。横向时 width > height。常用纸张：A4 纵向 210×297、A4 横向 297×210、A5 纵向 148×210。
- sections：数组。必须且只能有一个 type:"body"；可选 type:"header" / "footer"（页眉页脚，带 height）。
- 控件通用字段：type 必填；left/top/width/height 必填（单位 mm，原点 = 内容区左上角，即已扣除页边距）；id 可省略（系统自动补）。
- 控件类型与要点：
  · text：静态文字用 value；如需绑数据用 binding（字段路径）或 expression（如 "{{order.total}}"）。style 可选：{ fontSize(pt), fill(hex), fontWeight:'bold', textAlign:'left'|'center'|'right', lineHeight }。
  · image：{ value:{ mode:'url'|'binding', content } }，fit 可选。
  · table：columns:[{ title, field?, width, align? }]，options 可选（borders/zebra 等），dataSource 留空表示布局网格。
  · barcode：{ value, format:'CODE128'|'EAN13'..., showText? }；qrcode：{ value, errorLevel? }。
  · rect / line：{ fill?, stroke?, strokeWidth?, cornerRadius? }。
  · richtext：{ value: "<p>HTML</p>" }（仅可信静态内容）。

设计原则：
- 间距与对齐要规整（建议控件左/右贴边留白一致，关键元素水平居中）。
- 坐标铁律：left/top 是相对「内容区（页边距内侧）左上角」的 mm，渲染器会再叠加页边距，所以你写的坐标【不要包含 margin】。给定页面 width/height 与 margin 后，内容区宽 = width - margin.left - margin.right、高 = height - margin.top - margin.bottom；占满整行写 left:0, width:内容区宽，水平居中配合 style.textAlign:'center'。严禁出现 left 等于 margin.left、top 等于 margin.top 这类把页边距算进坐标的写法。
- 只输出「一段简要中文说明（不超过 3 句）」+ 一个 \`\`\`json 代码块包裹的完整模板。不要输出其他内容。
- 不依赖真实数据：文字用静态 value；除非用户明确给出字段，否则不要写 binding。
- 颜色用 hex（如 #1677ff、#333333）或 rgba。`

const FEW_SHOT: Array<{ role: 'user' | 'assistant'; content: string }> = [
  {
    role: 'user',
    content: '做一个竖向快递面单，100×150mm，上方标题"快递面单"，中间收件人姓名电话和地址，底部一个条码和右下角一个二维码。',
  },
  {
    role: 'assistant',
    content: `好的，已生成 100×150mm 的竖向快递面单：标题居中、收件信息分区、底部条码 + 右下角二维码。
（坐标均为相对内容区：页面 100×150、四周 margin=8，内容区宽 = 100-8-8 = 84）

\`\`\`json
{
  "version": "1.0.0",
  "document": {
    "type": "report",
    "page": {
      "width": 100, "height": 150, "unit": "mm", "orientation": "portrait",
      "margin": { "top": 8, "bottom": 8, "left": 8, "right": 8 },
      "backgroundColor": "#ffffff"
    },
    "sections": [
      {
        "type": "body",
        "components": [
          { "type": "text", "left": 0, "top": 2, "width": 84, "height": 12, "value": "快递面单", "style": { "fontSize": 20, "fontWeight": "bold", "textAlign": "center" } },
          { "type": "text", "left": 0, "top": 18, "width": 84, "height": 8, "value": "收件人：张三　13800000000", "style": { "fontSize": 11 } },
          { "type": "text", "left": 0, "top": 30, "width": 84, "height": 30, "value": "地址：广东省深圳市南山区科技园路 1 号 XX 大厦 10 层", "style": { "fontSize": 11 } },
          { "type": "text", "left": 0, "top": 64, "width": 84, "height": 8, "value": "托寄物：文件　到付", "style": { "fontSize": 11, "fill": "#555555" } },
          { "type": "barcode", "left": 0, "top": 78, "width": 84, "height": 22, "value": "SF1234567890", "format": "CODE128", "showText": true },
          { "type": "qrcode", "left": 52, "top": 104, "width": 32, "height": 28, "value": "https://example.com/order/SF1234567890" },
          { "type": "text", "left": 0, "top": 104, "width": 48, "height": 28, "value": "请于签收前核对信息", "style": { "fontSize": 10, "fill": "#888888" } }
        ]
      }
    ]
  }
}
\`\`\``,
  },
  {
    role: 'user',
    content: '做一个横向会员卡，90×54mm，左侧品牌名和会员等级，右侧会员姓名和大号卡号，底部一条分割线。',
  },
  {
    role: 'assistant',
    content: `已生成 90×54mm 横向会员卡：左侧品牌与等级、右侧姓名与卡号、底部分割线。
（坐标相对内容区：页面 90×54、四周 margin=6，内容区宽 = 90-6-6 = 78）

\`\`\`json
{
  "version": "1.0.0",
  "document": {
    "type": "report",
    "page": {
      "width": 90, "height": 54, "unit": "mm", "orientation": "landscape",
      "margin": { "top": 6, "bottom": 6, "left": 6, "right": 6 },
      "backgroundColor": "#0c447c"
    },
    "sections": [
      {
        "type": "body",
        "components": [
          { "type": "text", "left": 0, "top": 4, "width": 40, "height": 10, "value": "STAR 会员", "style": { "fontSize": 16, "fontWeight": "bold", "fill": "#ffffff" } },
          { "type": "text", "left": 0, "top": 18, "width": 40, "height": 8, "value": "钻石会员", "style": { "fontSize": 11, "fill": "#9fc3ff" } },
          { "type": "text", "left": 46, "top": 6, "width": 32, "height": 10, "value": "李雷", "style": { "fontSize": 15, "fontWeight": "bold", "fill": "#ffffff", "textAlign": "right" } },
          { "type": "text", "left": 46, "top": 20, "width": 32, "height": 10, "value": "NO. 8821 0043", "style": { "fontSize": 14, "fill": "#ffffff", "textAlign": "right", "letterSpacing": 1 } },
          { "type": "line", "left": 0, "top": 34, "width": 78, "height": 0.4, "stroke": "#ffffff", "strokeWidth": 0.4 }
        ]
      }
    ]
  }
}
\`\`\``,
  },
]

/** 组装 system 提示词 */
export function buildSystemPrompt(): string {
  return PROTOCOL_SUMMARY
}

/** 组装用户提示词（支持「基于当前模板修改」「仅选中控件改写」「数据字段接地」） */
export function buildUserPrompt(opts: {
  prompt: string
  currentTemplate?: unknown
  selectedControls?: unknown[]
  datasourceFields?: string[]
}): string {
  const parts: string[] = []
  if (opts.datasourceFields && opts.datasourceFields.length) {
    parts.push(`可用数据字段（如用户要求绑定真实数据，请优先使用这些路径）：\n${opts.datasourceFields.join('、')}\n`)
  }
  if (opts.selectedControls && opts.selectedControls.length) {
    parts.push(
      `下面是一组「用户当前选中的控件」（坐标 left/top 是相对内容区左上角的 mm）。\n` +
        `请按需求改写这些选中控件并【只输出一个控件 JSON 数组】，要求：\n` +
        `· 必须保留每个原控件的 id（用于原位替换），不要改变其 type；\n` +
        `· 可调整 left/top/width/height/value/style 等，实现重排、对齐、换风格、统一间距等；\n` +
        `· 可新增控件（给新的唯一 id，type 合法），也可删除某些选中控件（不输出即可）；\n` +
        `· 坐标仍是相对内容区（已扣除页边距），不要再加 margin；\n` +
        `· 只输出控件数组，不要包装成完整模板。\n` +
        '```json\n' +
        JSON.stringify(opts.selectedControls, null, 2) +
        '\n```',
    )
  } else if (opts.currentTemplate) {
    parts.push(
      `请在下面这份「当前模板 JSON」的基础上按需求修改，输出完整的新模板（不要只输出 diff）：\n` +
        '```json\n' +
        JSON.stringify(opts.currentTemplate, null, 2) +
        '\n```',
    )
  }
  parts.push(`需求：${opts.prompt}`)
  return parts.join('\n\n')
}

/** few-shot 示例（user/assistant 成对） */
export function getFewShot(): Array<{ role: 'user' | 'assistant'; content: string }> {
  return FEW_SHOT
}
