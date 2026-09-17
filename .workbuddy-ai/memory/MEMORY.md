# 项目长期记忆（report）

引擎：Rust `print-server`（非线性报表展开）+ TS `openprint`（引擎层，被 React 版 alias 引用）+ `designer-react`（UI）。

## 三个「表格」不是一回事（问「能不能合到 Univer」前先分清）

| 模型 | 结构 | 坐标 | 本质 | 在哪 |
| --- | --- | --- | --- | --- |
| 自由画布 | `AnyControl[]` 控件树 | mm 绝对定位 | 打印版面 | `designer-react/src/canvas/` |
| 表格控件 | `TableCell[][]` 固定行列 | 挂靠控件 | 单据明细 | `openprint/src/types/control.ts` |
| 非线性报表 | `CellTpl[][]` 行列可扩展 | 运行期布局 | 分组/交叉 | `openprint/src/report/grid-report.ts` |

混用这三个词是沟通事故的主要来源。用户说「自由表格」时先确认指哪个。

## Univer 硬约束（实测，别再试）

1. 列宽单位 **px 不是 mm**（`setColumnWidths` 文档明写）。打印侧 mm，要自己映射。
2. 同页面只能有一个活 Univer：再 `createUniver()` **不抛异常但完全不渲染**（0 canvas）。
   → 只能单例 + 跟随选中切换，不能每个表格各嵌一个。
3. 样式通道只有「底色 + 字色」能画：`bg` `cl` `bl` `it` ✅；`bd` 边框 **完全不渲染** ❌；
   `ul` 下划線会画但**永远用字色**（`ITextDecoration.c` 缺省 TRUE，写 `c:0` 也无效）。
   → 别设计依赖边框/下划线的第三个视觉维度。
4. **单测证明不了 Univer 画得出某样式**（曾带着画不出的橙色边框过了 11 条单测并提交）。
   要验渲染只能截图数像素：`scripts/verify-semantic-colors.py`。
5. 剥公式引擎要连带改四件事，漏一个就静默坏：
   docs+docs-ui 插件不能省（sheets-ui 编辑器依赖 `univer.editor.service`，
   异步抛 `[redi] Expect 1 ... but get 0`，**try/catch 接不到**）；CSS 不能省
   （原子类 `univer-h-full`，没 CSS 根塌成 22px）；`presets: []` 占位；
   **语言包要自己带**（否则 `LocaleService` 没初始化 → 一改格子就在
   `SheetPermissionCheckController` 抛错，界面完全看不出来）。
   配方见 `univerFormulaFree.ts` 顶部注释。
6. `FWorksheet` **没有 `getCell`**。`sheet?.getCell?.(r,c)` 可选链 + 不存在的方法 =
   `undefined`，TS 不报、运行期不报，整段死代码。调新方法前先核 facade `.d.ts`。

## 报表文件 = ReportDef（架构速查）

存 `print-server/reports/<id>.json`（**配置文件同级**，见下条）。
顶层 `format version id name description updatedAt template sources options`。
**存的是「模板 + 数据源声明 + 渲染选项」，不是数据快照**，打开/执行时按 sources 现查。

- 五种定义入口（`GridReportModal` 的 Segmented）：内置样例 / 分组汇总 / 交叉表 /
  画布表格 / 自由模板。前四种是**生成器**；自由模板是**通用表达**。
  → 单向漏斗：`openReport` 一律 `setMode('free')`。
- 一格 = `CellTpl` 两层：自身 `value` + 合并；`model?: CellModel` 二十余字段分四组
  （数据绑定 / 展开 / 主格关系 / 表达式）。
- **主格关系不画进格子**（没有第三个样式通道）：网格旁常显主格树 `parentTreeOf`，
  选中点亮整条链 `parentChainOf`。
- 存/开/跑：`PUT /api/reports/save` · `GET /api/reports/:id` → `templateToGrid`
  · `POST /api/reports/:id/run`。模板**存原样**，`options` 单独存；
  `withExportFormula`/`withExpandControl` 渲染前才套，且自由模板**刻意不套**
  withExpandControl（它按最内/最外层猜层级，会覆盖手工主格）。
- `id` 白名单 `[A-Za-z0-9_-]` ≤80 是安全边界（直接拼文件名）。
- 样例：`print-server/reports/sales-by-region.json`（A3 region → B3 city → C3 salesman；
  小计 `D3[B3:+0].sum()`、合计 `D3.sum()`）。

## 报表目录跟着 cwd 走（起服务必须 `cd print-server/`）

`store::reports_dir(config_path)` = 配置文件同级的 `reports/`，默认配置路径是**相对**的
`print-server.json`。从仓库根启动 → `/api/reports` 返回 `[]`，**没有任何报错**。
目录跟着配置文件走是刻意设计，只做披露（启动横幅 / `/health.reportsDir` /
`x-reports-dir` 响应头 / 设计器行内提示）。
自定义响应头跨域下默认读不到，需服务端 expose（本项目 `CorsLayer::permissive()` 自带）。
**curl 证明不了浏览器能读**，必须页面里 `fetch().then(r=>r.headers.get())` 才算验过。
`HeaderValue` 只收可见 ASCII → 中文路径要 percent 编码（`store::header_safe`）。

## 写断言的规矩

- **位置相关的断言，断言整条序列**。反例：只断言 `grid[1].last()=="行合计"`，
  注入 bug 后变成 `["地区","1月","行合计"]`（2月被挤掉），`last()` 依然绿。
  → 「目标元素还在」抓不住「旁边元素被挤掉/吞掉」。
- **只查「有属性」的，别忘了「没属性」的那种**：xlsx 边框校验脚本只查带 `s` 属性的格，
  去掉边框后无格式的格压根不写 `s`，脚本反而变绿。是故障注入探针暴露的。
- 写完检查脚本**必须注入已知错误反向验证**，确认它真能红。
- xlsx 是 zip，Rust 断言读不到内容 → 用 `scripts/verify-xlsx-export.py` 解压校验。
  `fitToWidth="1"` 是 XML **默认值会被省掉**，真正的开关是 `pageSetUpPr fitToPage="1"`
  + `fitToHeight="0"`。

## 沙箱 / 环境

- npm / vite 两个绕行脚本**已入库**，别再写 /tmp（上一版被系统清掉，vite 起不来）：
  `scripts/broker-mkdir-throttle.cjs`（fs broker 是**并发**限流 ~120，不是数量配额）、
  `scripts/vite-safe-delete-bypass.cjs`（必须在 **setImmediate** 里装，
  同步段装会让 shim 捕获 wrapper → 无限递归）。
- 起 vite：`cd designer-react && NODE_OPTIONS="--require .../scripts/vite-safe-delete-bypass.cjs $NODE_OPTIONS" npx vite --host 127.0.0.1 --port 5200 --strictPort`。
  必须 `run_in_background=true`（`(cmd &)` / `nohup &` 随 shell 一起死）；
  日志写 `scripts/.vite-dev.log`；curl 加 `--noproxy '*'`。
- **浏览器 harness 在沙箱里跑不动键盘 E2E**：CDP `Input.insertText` 对多字符串报
  `Invalid 'text' parameter`（`hello` 控制实验也失败，确认是 harness 问题）。
  应对：逻辑抽纯函数 + 单测 + 探针；**画到脸上的那一步走右侧面板 `agent-browser fill`**
  （antd `Input` 上能用，不像 canvas 击键），再 eval 读多个相关字段确认模型。
- **本仓库 `tsc --noEmit` 不是干净的**（`designer-react` 有 6 处既有报错，
  且 package.json 里没有 typecheck 脚本）。判断类型错是不是自己引入的：
  `git stash push -- <文件>` → 重跑 → `git stash pop`，对比错误集合与行号偏移。

## 预览与导出是两套口径 —— 预览算出来的东西，导出要么复用要么移植

`buildRenderRequest` 在前端算出 `headerRows`（`headerRowCount`，TS 纯函数）；
xlsx 导出在 Rust 侧另算一遍。**两边一旦不一致是静默的**：预览 2 行表头、
导出只有标题行有表头样式、打印时列头不跨页重复，界面上完全看不出来。

现已把 `headerRowCount` 移植成 `ReportTemplate::header_row_count()`
（判据：从第一行起，连续「既没有 `expand_type=r` 也没有 `row_parent」的行；
`row_parent: ""` 也算没主格）。生成器产出的模板第一行是**标题**、第二行才是列头，
所以典型值 **2 / 2 / 2 / 3**（双指标交叉表 3）。
→ 改任一侧都要同步另一侧；`sample_template_has_two_header_rows` 是那颗钉子。

**配套教训（真机探针要按 handler 分别覆盖）**：把 `xlsx_handler` 改回写死 1 后，
POST 探针如期变红（`$1:$1`），但 **sample 探针仍然绿** —— 它走的是
`sample_xlsx_handler`，另一条路。别以为一个探针守住了全部导出路径。

## print-server（Rust 侧）硬事实

- 默认端口 **18888**；binary 在 `~/.cargo/target/debug/print-server`（项目里**没有** `target/`）。
- **不是 rustfmt-clean**（`cargo fmt --check` 有 4483 行差异）→ **千万别 `cargo fmt`**，
  手改保持局部风格。
- `ReportSource` 是 `rename_all = "camelCase"` → JSON 里是 **`connId`**。写成 `conn_id`
  被 serde 忽略、静默落到第一个连接，报「sqlite 文件不存在: F:\...\data.db」——
  看着像配置没加载，其实是字段名错了。
- 渲染输出的格子字段是 **`text`**（`GridCell.text`）；`value` 是模板侧 `CellTpl` 的。
  拿 `value` 读渲染结果会一片空，容易误判成「渲染坏了」。
- `SheetTpl` **不在** mirror-check 的 `CAMEL_CASED` 白名单里（白名单是
  ReportSource/ReportDef/ReportOptions/ReportSummary）→ 新字段两端都用 snake_case。
- 批量给 struct 加字段：正则要排除 `-> Foo {`（长得和结构体字面量一样），
  用 `(?<!-> )SheetTpl\s*\{`。改完**插入数要和编译器报的错数对得上**，多出来就是误伤。

## 前端 UI 测试（antd v6 + jsdom，实测可用）

`designer-react` 有 5+ 个 modal 规格，用 `createRoot` + `act` 挂载，模式见
`p55-modals.spec.tsx` / `data-import.spec.tsx`。**antd Select 在 jsdom 里能正常驱动**，
但有两个坑：
1. 触发器是 **`.ant-select-content`**（v6），不是 v5 的 `.ant-select-selector`。
   开下拉：`mousedown`（bubbles）→ 等一拍 → 点 `.ant-select-item-option`。
2. **上一个下拉不会从 DOM 摘掉**，只加 `-hidden` 类。在 `document` 里搜选项会点到
   上一个 Select 的项去。必须只在「最后一个未 hidden 的 `.ant-select-dropdown`」里找。
   （踩过：分组字段选完 city，再选数值字段时点中的还是分组字段的下拉，
   `valueField` 一直空、请求一直发不出去，且不报错。）
3. `data-testid` 落哪层随组件而异（InputNumber 可能在 input 本身也可能在外层 div），
   查询要 `matches('input') ?? querySelector('input') ?? parentElement.querySelector`。
4. 受控输入用原生 setter 触发（绕过 React valueTracker）。
5. **预览有 400ms 去抖**，等请求要轮询到 6s；去抖靠 `doRender` 身份变化触发，
   所以「state 变了但没进依赖数组」= 请求根本不发。

**UI 层用例要断言请求体，不是「没报错」** —— 见 `grid-report-paging.spec.tsx`
（分页开关接线；四个用例各自做了故障注入验证）。
纯函数 `buildRenderRequest` 的用例在 `grid-report-request.spec.ts`，
它测不到 state → 入参 → 依赖数组那段接线，两层都要有。
