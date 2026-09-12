/**
 * printerProbe → dataSource 桥
 *
 * 等价 Vue 版数据源 store 内的 `watch(() => probe.state, …)`：
 * 打印客户端「连接 / 断开」时同步数据库数据源状态 ——
 *   连上且（数据库模式 + 已手动开启）→ 载入库列表；
 *   断开 → 清空已拉取数据，避免预览展示过期行。
 *
 * 放在独立模块是为了可单测（App 只负责在挂载时接一次）。
 */
import { usePrinterProbeStore, type PrinterProbeState } from './printerProbe'
import { useDataSourceStore } from './dataSource'

/**
 * 接上桥接，返回取消函数（供 React useEffect 清理）。
 * - 立即同步一次当前状态（App 挂载时若探测已完成，不等下一次变化）
 * - 仅在 state 真正变化时转发，避免 printers 数组刷新触发重复取数
 */
export function connectPrinterToDataSource(): () => void {
  let last: PrinterProbeState = usePrinterProbeStore.getState().state
  useDataSourceStore.getState().onPrinterStateChange(last)

  return usePrinterProbeStore.subscribe((s) => {
    if (s.state === last) return
    last = s.state
    useDataSourceStore.getState().onPrinterStateChange(s.state)
  })
}
