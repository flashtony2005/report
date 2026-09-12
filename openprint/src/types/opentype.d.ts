// opentype.js 自带类型声明缺失，统一声明为 any（仅导出路径在浏览器内按需动态 import，
// 用于把图表 SVG 的 <text> 展开为矢量字形轮廓，无需类型约束）。
declare module 'opentype.js'
