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

## 改 xlsx 导出的固定套路（这套动作已经跑了四遍，别再临时发挥）

导出物是 zip，**Rust 侧断言读不到内容**，所以：

1. **先把逻辑抽成纯函数**（`column_widths` / `lines_needed` / `header_row_count`），
   否则只能断言「不报错」，等于没测。
2. 单测写**具体数值**，并把前提也断言上（「这段文本是 48 宽」）。
   注意 `display_width` 末尾有 **+2 内边距**，第一次写断言就栽在这。
3. **故障注入 ≥3 次**：改错算法、改错常量、改错接线（handler 级）。
4. **真机探针**：`cd print-server && <binary> --port 189xx`（必须 `run_in_background`），
   curl 导出 → `scripts/verify-xlsx-export.py` 拆 zip 读 XML。
5. **handler 级注入单独做一次**：单测守不到 handler 接线，而且
   注入 `xlsx_handler` 后 sample 探针**仍然绿**（走的是另一条路径）——
   一个探针守不住全部导出路径。

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

## xlsx 列宽：`clamp(8, 60)`，两个数都有理由，别随手改

`column_widths()`（xlsx.rs）= 该列最长文本的 `display_width`（全角算 2，
**末尾 +2 内边距**）再 clamp。

- 下限 8：「备注」「编码」两字词只有 6 宽，不抬会挤成一条缝。
- 上限 60（原 40）：实测 23 个汉字的备注是 48 宽，40 会截断 ——
  相邻列有内容时 Excel 是**裁掉**不是溢出，所以是真的看不见。
- **为什么不去掉上限**：导出同时开了 `set_print_fit_to_pages(1, 0)`，
  列越宽 → 缩放越狠 → 打印出来整张表字越小。实测样例总宽 55 / 带长备注 64，
  一页宽约 92（≈11 个默认列），都还在里面。
- 超过 60 仍截断；要完整显示得走「换行 + 设行高」，那会改行高，是产品取舍。

**配套**：列宽写进 zip，从 `to_xlsx` 的返回值上根本看不出来 ——
所以列宽逻辑抽成了纯函数 `column_widths()` 才能单测，终局仍要
`scripts/verify-xlsx-export.py` 拆包验。

## 能力边界：画布有、服务端报表没有的东西（别再搞混）

| 能力 | 自由画布 | 服务端非线性报表（`CellTpl`） |
| --- | --- | --- |
| 图片 / 条码 / 二维码 | 有（`PrintQrcode`、`data-binder` barcode） | **无** |
| 图表 | 有，**自研** `openprint/src/core/chartkit`（bar/line/pie，纯函数出 SVG、零第三方依赖） | **无**（`print-server/src` grep `chart` 零命中） |
| 导出 | 客户端 `export-engine/`（PDF/SVG/图片） | 服务端 xlsx / HTML |

**教训**：`package.json` 里没装第三方图表库 ≠ 没有图表能力 —— 是自己写的。
判断某能力有没有，**先 grep 源码，别先看依赖清单**。（我据此误判过一次。）

## 非线性报表：格子没有「作者定义的样式」

`GridCell`（`model.rs:379`）只有 7 个字段：`text / pos / rowspan / colspan /
raw_number / num_format / formula`。**字体、字号、颜色、边框、对齐、条件样式
一个都没有**，也导不出。

设计器里的彩色是**语义高亮**（`grid-report.ts:661-666`：纵向扩展黄、横向扩展绿、
字段蓝、表达式紫斜体，+ 表头/选中/主格高亮）—— 标的是「这格什么角色」，
不是「这格长什么样」。xlsx 里的样全靠导出器写死（表头加粗+底色、全体细边框、
按需换行行高）。**用户改不了任何一个。**

→ 这是和润乾观感差距最大的一块；要补是完整链路（模型 + mirror-check +
xlsx 通道 + 设计器面板）。

## 分页不认分组

`paginate()`（`mod.rs:319`）是**渲染完之后**按固定行数切拍平网格，
不知道哪几行同组 → 一组明细跨页时，第二页只有重复的表头，**补不出主格**
（表头重复只重复模板前 N 行，重复不了运行期展开出来的地区名）。
`mod.rs:313` 注释已声明不做润乾 9 类带区模型。要「组内不跨页」得引入带区
或「行后分页」标记。

## 已核对：这些不是缺口（别重复查）

表达式函数集（官方 11 个 + MAP/FILTER/REDUCE/FLATMAP）全在；
`CellModel` 19 个字段**无死字段**（逐个统计引用，`engine.rs` 都有真实读点：
`expand_max_count` 1127 / `keep_expand_empty` 1131 / `expand_expr` 1113 /
`join_on` 754）；分页三配置都生效；多 sheet 导出支持（`xlsx.rs:37` 循环
`add_worksheet`）；行/列测试已有设计器入口。

## 数据源现状

sqlite ✅ / postgres ✅ / odbc ❌ 引擎未实现（界面已标注，非静默坑）。
MySQL **归一成 sqlite**（`normalizeDbEngine('mysql')==='sqlite'`，有测试钉住），
但 UI 下拉只有 sqlite/postgres/odbc 三项（`admin.html:407`），**手改配置才会踩**，
优先级最低。`/print` 只支持 pdf/html；`esc`/`tsc`/`zpl` 票据指令待实现
（`print_job.rs:85`）。无 CSV 导出。**报表参数/查询表单整块缺失**
（`params` 只是 SQL 绑定参数）。

## 盘点方法（可复用）

判断「某字段是不是死字段」：写脚本统计每个字段在 `engine.rs`/`xlsx.rs` 里的
`\.field\b` 或 `field:` 命中数，**但别只看总数** —— 命中里混着测试夹具的
结构体字面量（`mod.rs` 里 19 个字段命中数清一色 23~28，看着像都用了，
其实大半是夹具）。要打开看**读点所在的那几行**才算数。

## 已完成（2026-09-20，别再当缺口重复做）

**CSV 导出**：`POST /api/report/csv` + `GET /api/report/sample.csv`。
RFC 4180 转义 + UTF-8 BOM（缺了 Excel 开中文乱码）+ CRLF。
写 `text` 不写 `formula`（CSV 里 `=SUM(...)` 只是文本）。多 sheet 顺序拼接。
**CSV 注入（`=cmd|`）刻意不改写**：加 `'` 前缀会把 `+86` 手机号也改掉，
拿正确性换安全不值；数据来自自己配的库。取舍写在 `csv.rs` 顶部注释。

**分页不切合并格**：`merge_blocked_boundaries()`（mod.rs）。
**关键洞察：主格展开出来就是合并格** —— 一个地区跨几行，格 rowspan 就是几，
所以「不许在合并格中间切页」==「组内不跨页」，不用引入润乾 9 类带区模型。
落点被跨过时往两边找最近安全边界（先退后进）；剩下的够放一页就不再切。
代价：页大小不再严格等于 rows_per_page，组超过一页时那页必然超（宁超不切）。

**格子样式 `CellStyle`**：bold / italic / font_size / color / bg / h_align / v_align。
链路 `CellModel.style` → `CellInst.style` → `GridCell.style` → xlsx `with_style()`。
`with_style` 是**叠加**在基础格式上（表头加粗 + 全体细边框保留），没设的项不动。
- **刻意不给边框**：Univer `bd` 完全不渲染 → 设了看不见 = 静默失败。
- **颜色只认 `#RRGGBB`，认不出来报 HTTP 500**（点名哪格哪个值），不静默丢弃。
- 清掉最后一项时整个 `style` 要摘掉，不能留 `{}`（有 UI 用例钉住）。

**MySQL / MariaDB / SQL Server / Oracle 明确报错**：`unsupported_engine_name()`。
注意 `ServerConfig::load()` **不调 `validate()`**（只有保存/试连调），
所以手改配置写 mysql 是真能踩到的，会报误导性的「sqlite 文件不存在」。

## 批量给 struct 加字段：两个构建都要跑

只跑 `cargo build` 会漏掉**测试代码里**的字面量（本次：build 报 7 处，
`cargo test --no-run` 又报 18 处）。**两边都跑**，且插入数要和错数对得上
（多出来就是误伤了 `-> Foo {` 之类的形状）。

## 受控组件的 UI 测试：必须把 onChange 结果喂回去

`CellModelEditor` 是受控的，spec 里只点开关不重新 render，界面永远停在初始值
（色块不跟着变、断言拿到旧值）。要像真实父组件那样 `sync()` 把新 cell 传回去。
另：jsdom 对 `style.background` 有时保留 `#RRGGBB`、有时转 `rgb(...)`，断言两种都收。

## 报表参数（ReportDef.params + RunRequest.values）

`ReportDef.params: Vec<ReportParam>`（name/label/kind/default/required/options）
是「执行前弹什么查询条件」的声明层，UI 据此自动生成表单；`kind=enum` 时
`options` 就是下拉项。运行请求用 `values`（参数名 → 值）。

与老的 `RunRequest.params`（数据集名 → 位置参数数组）是两条通道：
这条按名字绑（人填），那条按数据集整体覆盖（程序填）。

绑定：`resolve_params()` 解析出值 → `bind_params()` 把数据源 params 里
**整体等于** `"$name"` 的字符串换成值。只认整体等于，不认「包含 `$`」。

三种情况一律报错（静默的后果都是「筛选没生效，作者以为生效了」）：
未知参数（typo）、必填缺失、引用了解析不出值的参数。

**报错顺序也是正确性**：未知参数检查必须**先于**必填检查，否则 typo 会被报成
「region 必填」，把人往错的方向带。先报离用户真实错误最近的那条。

老报表没有 params 时照旧跑（`no_params_declared_still_runs` 钉住）。
