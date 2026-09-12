/**
 * 控件默认工厂（跨框架共享）
 *
 * 从 designer store 中抽出，作为 Vue / React 两端的**单一数据源**：
 * 默认值一旦漂移，跨框架契约测试会立刻失败。
 */
import type { AnyControl, ControlType, RectControl, TableControl } from '@/types/control'
import { seedSummaryTail, syncDataTableHeight } from '@/core/layout-engine/table-cells'
import { genId } from '@/utils/id'

export function createDefaultControl(
  type: ControlType,
  at: { leftMm: number; topMm: number },
): AnyControl | null {
  const id = genId()
  // 坐标兜底：at.leftMm/topMm 可能因上游时序（如拖拽时 viewport 未就绪）为 NaN/undefined，
  // Math.max(0, Math.round(NaN*100)/100) 会得到 NaN，写进 store 后 NInputNumber 会渲染删除线。
  // 这里强制收敛为有限数字，保证几何字段永远是有效数字。
  const safeMm = (v: unknown): number => {
    // 坐标统一收敛到 0.1mm（与属性面板 precision=1、step=0.1 一致）。
    // 关键：Naive UI 的 NInputNumber 设了 step 后会校验值是否为 step 网格（0.1 整数倍），
    // 非倍数会被判 displayedValueInvalid 并画删除线。任意坐标（如 139.82）必须 snap 到
    // 0.1 倍数，否则 XY 一进画布就显示删除线（这就是“默认划横线”的真因，与 NaN 无关）。
    const n = Math.round((typeof v === 'number' && Number.isFinite(v) ? v : 0) * 10) / 10
    return n < 0 ? 0 : n
  }
  const base = {
    id,
    left: safeMm(at.leftMm),
    top: safeMm(at.topMm),
    printable: true,
  }
  switch (type) {
    case 'text':
      return { ...base, type, width: 50, height: 8, contentType: 'fixed', value: '文本', style: { fontSize: 12 } }
    case 'image':
      return { ...base, type, width: 40, height: 25, value: { mode: 'inline', content: '' }, fit: 'contain' }
    case 'table':
      return seedSummaryTail(
        {
          ...base,
          type,
          width: 180,
          height: 60,
          columns: [
            { title: '序号', expression: '{{rowIndex + 1}}', width: 15, align: 'center', headerAlign: 'center' },
            { title: '名称', field: 'items[].name', width: 60 },
            { title: '数量', field: 'items[].qty', width: 25, headerAlign: 'center' },
            { title: '单价', field: 'items[].price', width: 30, headerAlign: 'center' },
            { title: '金额', field: 'items[].amount', width: 30, headerAlign: 'center' },
          ],
          // 自带示例数据：预览 / 打印即可看到填充内容与自动计算的小计
          data: [
            { name: '示例商品 A', qty: 2, price: 12.5, amount: 25 },
            { name: '示例商品 B', qty: 1, price: 36, amount: 36 },
            { name: '示例商品 C', qty: 5, price: 8, amount: 40 },
          ],
          // 默认单元格居中（defaultCellStyle 兜底，列/单元格显式对齐仍可覆盖）
          options: {
            repeatHeader: true,
            repeatFooter: true,
            pageRows: 'auto',
            borders: 'all',
            verticalAlign: 'middle',
            defaultCellStyle: { align: 'center' },
          },
        },
        // 默认植入完整「本页合计 + 总计 + 大写金额」三行尾结构
        { numericColumns: [2, 3, 4], moneyColumn: 4, capital: true },
      )
    case 'barcode':
      // 高度 30mm ≈ 113px：足够容纳 bwip-js 条码条（约 21mm）+ 文字行 + 上下留白，
      // 避免默认 15mm 时文字行被 scaleY 压扁到看不见。
      return { ...base, type, width: 60, height: 30, contentType: 'fixed', format: 'CODE128', showText: true }
    case 'qrcode':
      return { ...base, type, width: 25, height: 25, contentType: 'fixed', errorLevel: 'M' }
    case 'rect':
      return { ...base, type, width: 40, height: 25, fill: 'transparent', stroke: '#000000', strokeWidth: 1 }
    case 'line':
      return { ...base, type, width: 60, height: 0, stroke: '#000000', strokeWidth: 1 }
    case 'zone':
      // zone 由面板显式指定 header/footer，拖入默认 header
      return { ...base, type, width: 210, height: 20, zone: 'header', zoneHeight: 20, repeat: true, children: [] }
    case 'richtext':
      return {
        ...base,
        type,
        width: 80,
        height: 24,
        value: '<h3>标题</h3><p>在这里输入<strong>富文本</strong>内容，支持列表、加粗等排版。</p>',
      }
    case 'chart':
      return {
        ...base,
        type,
        width: 90,
        height: 60,
        kind: 'bar',
        categories: ['一月', '二月', '三月', '四月'],
        series: [
          { name: '销量', data: [120, 200, 150, 80] },
          { name: '退货', data: [20, 35, 15, 10] },
        ],
        options: { showAxis: true, showGrid: true, showLegend: true, valueLabel: false },
      }
    case 'math':
      return {
        ...base,
        type,
        width: 80,
        height: 25,
        latex: 'c = \\pm\\sqrt{a^2 + b^2}',
        displayMode: true,
        fontSize: 16,
        color: '#000000',
      }
    case 'signature':
      return {
        ...base,
        type,
        width: 60,
        height: 30,
        src: '',
        penWidth: 1,
        color: '#000000',
      }
    case 'labelgrid': {
      // 起手是一个**空网格**：列数 / 间距 / 卡片尺寸给合理默认值，内容由用户自行放入
      // （框选一组控件「转为标签网格」，或从控件库拖入后编辑首卡）。标签网格是纯布局组件，
      // 不带数据源——每张卡印什么由放进卡里的其他数据组件决定。
      const cardW = 58
      const cardH = 30
      const cols = 3
      const gap = 3
      const rows = 3
      return {
        ...base,
        type,
        width: cardW * cols + gap * (cols - 1),
        height: cardH * rows + gap * (rows - 1),
        columns: cols,
        gapX: gap,
        gapY: gap,
        cardWidth: cardW,
        cardHeight: cardH,
        showLines: true,
        children: [],
        name: `标签网格（${cols} 列）`,
      }
    }
  }
}
