/**
 * 公式-free 的 Univer 实例。
 *
 * 为什么不用 `@univerjs/preset-sheets-core`：那个 preset 把 `engine-formula` /
 * `sheets-formula` / `sheets-formula-ui` 作为硬依赖，而 NopReport 风格的 DSL
 * `=ds1.city` / `=D3[B3:+0].sum()` 不是 Excel 公式，Univer 会按公式解析 →
 * 单元格静默变空（`openprint/src/report/grid-report.ts:922` 注释里有记录）。
 *
 * Univer 的 sheets / sheets-ui 在 preset 里的注册顺序本身就排在 formula 之前，
 * 说明它们不依赖 formula 也能初始化。模板编辑器根本不碰公式路径，所以丢
 * 公式引擎是安全的。
 *
 * 留下七个插件：network / docs / render / ui / docs-ui / sheets / sheets-ui
 * —— 就是把 preset-sheets-core 那张表里的 rpc、engine-formula、
 * sheets-formula(-ui)、sheets-numfmt(-ui) 去掉，其余照抄（顺序也照抄）。
 * 显式 import 各自 facade 的副作用，让 FUniver 上能拿到 `createWorkbook`、
 * `getActiveSheet`、`getRange().setBackgroundColor`、`addEvent` 这些
 * GridReportModal 已经在用的 API（`univerAPI` 那条链路整段没动）。
 *
 * 「`=` 字面量进单元格」这件事分两步：
 *   1. 加载侧（保存的报表 JSON 重新载入）：
 *      给非空单元格带 `t: 4`（= Univer `CellValueType.FORCE_STRING`），
 *      Univer 就不会把 `v: '=ds1.city'` 当公式挪到 `f` 字段。
 *      见 `openprint/src/report/grid-report.ts` 的 `gridToWorkbookData`。
 *   2. 编辑侧（用户在画布里键入）：
 *      `sheets-ui` 的 `getCellDataByInput` 硬编码
 *      `isFormulaString(text)` → `{f: text, v: null}`，单元编辑器走同一路径。
 *      两个**实测过的死路**，别再试：
 *        - 指望剥掉公式引擎解决 → 不行，`isFormulaString` 在 sheets-ui 里；
 *        - `SheetInterceptorService` 的 `BEFORE_CELL_EDIT` → 那是「编辑器打开」
 *          钩子，不是「提交」钩子，装上压根不触发。
 *      能走通的是 mutation 拦截器：`beforeCommandExecuted` 拿到
 *      `sheet.mutation.set-range-values` 的参数（**与真正执行的 params 是同一个
 *      对象引用**），就地把 `{f, v:null}` 改回 `{v:f, f:null, t:4}`。
 *      纯逻辑在 `rescueFormulaString.ts`，可单测。
 */
import { createUniver } from '@univerjs/presets'
import { ICommandService, LocaleType, mergeLocales } from '@univerjs/core'
import UniverDesignZhCN from '@univerjs/design/locale/zh-CN'
import UniverUiZhCN from '@univerjs/ui/locale/zh-CN'
import UniverDocsUiZhCN from '@univerjs/docs-ui/locale/zh-CN'
import UniverSheetsZhCN from '@univerjs/sheets/locale/zh-CN'
import UniverSheetsUiZhCN from '@univerjs/sheets-ui/locale/zh-CN'
import { UniverNetworkPlugin } from '@univerjs/network'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverUIPlugin } from '@univerjs/ui'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import {
  looksLikeCellValue,
  rescueFormulaStringCells,
} from './rescueFormulaString'

/**
 * Univer 的样式**不能省**。
 *
 * 之前以为「preset 的 CSS 只是 chrome 皮肤，关掉 chrome 就不需要了」——错的。
 * Univer 的布局全靠 `univer-h-full` / `univer-flex` 这类原子类，样式表没进来的话
 * 这些类等于不存在，结果就是：DOM 和 canvas 都老老实实建好了，但根节点高度
 * 塌成一行 sheet 标签的高度（实测 22px），画布 0 高，**看不出任何报错**。
 *
 * 自己拼插件就没有 preset 替你 import 这张表，得手动按依赖顺序补齐：
 * design（基础原子类）→ ui → docs-ui → sheets-ui。
 */
import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'

// facade 副作用：把 sheets / sheets-ui 的方法挂到 FUniver。
// preset 里还 import 了 sheets-formula-ui / engine-formula / sheets-numfmt 的 facade，
// 那些一律不要 —— 会把公式/数字格式相关 API 重新带回来。
import '@univerjs/network/lib/facade'
import '@univerjs/sheets/lib/facade'
import '@univerjs/ui/lib/facade'
import '@univerjs/docs-ui/lib/facade'
import '@univerjs/sheets-ui/lib/facade'

/** `SetRangeValuesMutation` 的命令 id —— 画布改值最终都落到这一条上 */
const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'

export interface FormulaFreeUniver {
  /** 同 preset 路径下的 `univerAPI`，API 形状兼容（createWorkbook / addEvent 等都在） */
  univerAPI: any
  /** `=` 拦截器是否真的装上了。装不上就说明上面的假设被 Univer 改掉了 */
  rescueInstalled: boolean
  dispose(): void
}

export function createFormulaFreeUniver(container: HTMLElement): FormulaFreeUniver {
  const { univer, univerAPI } = createUniver({
    // 一个 preset 都不用，全手工注册（presets 在类型上是必填，传空数组）
    presets: [],
    // 语言包**必须自己带**：preset 会捎带一张合并好的表，自己拼插件就没人管了。
    // 少了它不会报错、界面也照画，但 `LocaleService` 没初始化 ——
    // 于是任何走 `syncExecuteCommand` 的命令都会在
    // `SheetPermissionCheckController._getPermissionCheck` 里抛
    // `[LocaleService]: Locale not initialized`（setValue 就是一个）。
    // 表现是「画布看着好好的，一改格子就静默失败」。
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(
        UniverDesignZhCN,
        UniverUiZhCN,
        UniverDocsUiZhCN,
        UniverSheetsZhCN,
        UniverSheetsUiZhCN,
      ),
    },
    plugins: [
      UniverNetworkPlugin,
      // docs / docs-ui **不能省**：sheets-ui 的单元格编辑器依赖
      // `univer.editor.service`（`IEditorService`，定义在 docs-ui）。
      // 少了它 Univer 在渲染时抛 `[redi] Expect 1 dependency item(s) for id
      // "univer.editor.service" but get 0` —— 而且是**异步**抛的，包在
      // try/catch 里也接不到，只会在 window 的 error 事件里冒出来，
      // 表现就是「容器里空空的、控制台之外毫无提示」。
      // 顺序照抄 preset-sheets-core：network → docs → render → ui → docs-ui → sheets → sheets-ui
      UniverDocsPlugin,
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
      UniverDocsUIPlugin,
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

  // ---- `=` 文本拦截器 ----------------------------------------------------
  // 装不上必须让人知道：静默退化 = 用户键入 `=` 表达式后单元格变空，
  // 而控制台一声不响，这种 bug 最难查。
  let rescueInstalled = false
  let unhook: (() => void) | undefined
  try {
    const injector = (univer as { __getInjector?: () => { get: (t: unknown) => any } })
      .__getInjector?.()
    const commandService = injector?.get(ICommandService)
    if (!commandService?.beforeCommandExecuted) {
      console.error('[univer] 拿不到 ICommandService，`=` 文本拦截器没装成')
    } else {
      unhook = commandService.beforeCommandExecuted((info: { id: string; params?: unknown }) => {
        if (info.id !== SET_RANGE_VALUES) return
        const params = info.params as { cellValue?: unknown } | undefined
        const cellValue = params?.cellValue
        if (!cellValue) return
        if (!looksLikeCellValue(cellValue)) {
          // 参数形状变了 = 这套拦截逻辑已经失效，别装作还在工作
          console.warn('[univer] set-range-values 参数形状变了，`=` 拦截可能失效', cellValue)
          return
        }
        rescueFormulaStringCells(cellValue)
      })
      rescueInstalled = true
    }
  } catch (e) {
    console.error('[univer] `=` 文本拦截器注册失败', e)
  }

  return {
    univerAPI,
    rescueInstalled,
    dispose: () => {
      unhook?.()
      ;(univerAPI as { dispose?: () => void }).dispose?.()
    },
  }
}