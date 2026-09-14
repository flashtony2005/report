/**
 * 公式-free 的 Univer 实例。
 *
 * 为什么不用 `@univerjs/preset-sheets-core`：那个 preset 把 `engine-formula` /
 * `sheets-formula` / `sheets-formula-ui` 作为硬依赖，而 NopReport 风格的 DSL
 * `=ds1.city` / `=D3[B3:+0].sum()` 不是 Excel 公式，Univer 会按公式解析 → 显示
 * `#NAME?` 或静默清空（`openprint/src/report/grid-report.ts:922` 注释里有记录，
 * 浏览器实测 `=ds1.city` 进 A1 后单元格变空）。
 *
 * Univer 的 sheets / sheets-ui 在 preset 里的注册顺序本身就排在 formula 之前，
 * 说明它们不依赖 formula 也能初始化。运行时如果用户粘了公式进单元格，
 * sheets-ui 调 formula 服务会拿到 null —— 但模板编辑器根本不碰公式路径，
 * 所以丢掉 formula 是安全的。
 *
 * 留下五个插件：network / render / ui / sheets / sheets-ui。
 * 显式 import 各自 facade 的副作用，让 FUniver 上能拿到 `createWorkbook`、
 * `getActiveSheet`、`getRange().setBackgroundColor`、`addEvent` 这些
 * GridReportModal 已经在用的 API（`univerAPI` 那条链路整段没动）。
 */
import { createUniver } from '@univerjs/presets'
import { UniverNetworkPlugin } from '@univerjs/network'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverUIPlugin } from '@univerjs/ui'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'

// facade 副作用：把 sheets / sheets-ui 的方法挂到 FUniver。
// preset 里也 import 了 sheets-formula-ui / engine-formula / sheets-numfmt 的 facade，
// 那些一律不要 —— 会把公式/数字格式相关 API 重新带回来。
import '@univerjs/network/lib/facade'
import '@univerjs/sheets/lib/facade'
import '@univerjs/ui/lib/facade'
import '@univerjs/sheets-ui/lib/facade'

export interface FormulaFreeUniver {
  /** 同 preset 路径下的 `univerAPI`，API 形状兼容（createWorkbook / addEvent 等都在） */
  univerAPI: any
  dispose(): void
}

export function createFormulaFreeUniver(container: HTMLElement): FormulaFreeUniver {
  const { univerAPI } = createUniver({
    plugins: [
      UniverNetworkPlugin,
      UniverRenderEnginePlugin,
      [UniverUIPlugin, {
        container,
        // Univer 自带 header / ribbon / toolbar / 右键菜单都关掉：
        // - 没公式引擎，公式条/公式相关按钮没意义
        // - 设计器自己有「插入行/删除行/复制模板 JSON」等按钮，叠两层会打架
        header: false,
        ribbonType: 0,
        toolbar: false,
        menu: { 'sheets.contextmenu': false },
        contextMenu: { 'sheets': false },
      }],
      UniverSheetsPlugin,
      [UniverSheetsUIPlugin, {
        formulaBar: false,
        footer: false,
        // 没公式引擎时这两个不会触发，但传 true 显式表明意图
        // （防止未来加回 formula 时变成「我以为我关了」）
        disableForceStringAlert: true,
        disableForceStringMark: true,
      }],
    ],
  })

  return {
    univerAPI,
    dispose: () => (univerAPI as any).dispose?.(),
  }
}