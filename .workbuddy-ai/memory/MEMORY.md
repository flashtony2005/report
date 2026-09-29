# 项目长期记忆（report）· 核心

引擎：Rust `print-server`（展开 + 导出）+ TS `openprint`（引擎层，designer-react alias 引用）+ `designer-react`（UI）。

> **细节在 `REFERENCE.md`**（验证方法论 / 沙箱 / 硬事实 / 单位换算 / 各特性）。需要时读，别凭记忆。
> **引擎全貌看《报表引擎详解-功能与算法.md》**（结论带 `file:line`）。
> 只放「每个任务都用得上」的，**≤12KB**（超了会被截断）。

## 三个「表格」不是一回事（问「能不能合到 Univer」前先分清）

| 模型 | 结构 | 坐标 | 本质 | 在哪 |
| --- | --- | --- | --- | --- |
| 自由画布 | `AnyControl[]` 控件树 | mm 绝对定位 | 打印版面 | `designer-react/src/canvas/` |
| 表格控件 | `TableCell[][]` 固定行列 | 挂靠控件 | 单据明细 | `openprint/src/types/control.ts` |
| 非线性报表 | `CellTpl[][]` 行列可扩展 | 运行期布局 | 分组/交叉 | `openprint/src/report/grid-report.ts` |

混用这三个词是沟通事故主因。用户说「自由表格」时先确认指哪个。

## Univer 硬约束（实测，别再试）

1. 列宽单位 **px 不是 mm**（打印侧 mm，自己映射）。
2. 同页面只能有一个活 Univer：再 `createUniver()` **不抛异常但完全不渲染**（0 canvas）→ 单例 + 跟随选中切换。
3. 样式通道只有「底色 + 字色」：`bg` `cl` `bl` `it` ✅；`bd` 边框**完全不渲染** ❌；`ul` 下划线会画但**永远用字色**。→ 别设计依赖边框的维度。
4. **单测证明不了 Univer 画得出某样式**（曾带着画不出的边框过 11 条单测）。验渲染只能截图数像素（skill `canvas-pixel-verify`）。
5. 剥公式引擎要连带改四件事，漏一个就静默坏：docs+docs-ui 插件 / CSS（`univer-h-full`）/ `presets: []` / **语言包**（缺了 `LocaleService` 没初始化 → 一改格子就抛错，界面看不出来）。配方见 `univerFormulaFree.ts` 顶部。
6. `FWorksheet` **没有 `getCell`**。`sheet?.getCell?.(r,c)` = `undefined`，TS 不报、运行期不报，整段死代码。调新方法前先核 facade `.d.ts`。

## 报表文件 = ReportDef

存 `print-server/reports/<id>.json`（**配置文件同级**）。**存的是「模板 + 数据源声明 + 渲染选项」，不是数据快照**。

- 五种入口：内置样例 / 分组汇总 / 交叉表 / 画布表格 / 自由模板。前四种是**生成器**，自由模板是**通用表达** → `openReport` 一律 `setMode('free')`。
- 一格 = `CellTpl` 两层：自身 `value` + 合并；`model?: CellModel` 二十余字段分四组（数据绑定 / 展开 / 主格 / 表达式）。
- **主格关系不画进格子**：网格旁常显主格树 `parentTreeOf`，选中点亮 `parentChainOf`。
- 存/开/跑：`PUT /api/reports/save` · `GET /api/reports/:id` → `templateToGrid` · `POST /api/reports/:id/run`。模板**存原样**，`options` 单独存；`withExportFormula`/`withExpandControl` 渲染前才套（自由模板**刻意不套**后者）。
- `id` 白名单 `[A-Za-z0-9_-]` ≤80 是安全边界（直接拼文件名）。样例 `reports/sales-by-region.json`。

## 四条「静默失败」红线（改了必自查）

1. **报表目录跟着 cwd 走**：`store::reports_dir(config_path)` = 配置文件同级的 `reports/`，默认配置路径是**相对**的 `print-server.json`。从仓库根启动 → `/api/reports` 返回 `[]`，**无任何报错**。刻意设计，只披露（横幅/`/health`/响应头）；跨域默认读不到响应头（已 expose），**curl 证明不了浏览器能读**。中文路径 percent 编码（`HeaderValue` 只收可见 ASCII）。
2. **预览与导出是两套口径**：`buildRenderRequest` 前端算 `headerRows`；xlsx 导出在 Rust 侧另算（`header_row_count()`：从头起连续「无 `expand_type=r` 且无 `row_parent`」的行，`row_parent:""` 也算没主格）。**不一致是静默的**。生成器模板首行是**标题**、次行才是列头 → 典型值 **2/2/2/3**（钉子 `sample_template_has_two_header_rows`）。也管 `repeat_header_rows`。
3. **`ReportSource` 是 `rename_all = "camelCase"`** → JSON 里是 **`connId`**。写成 `conn_id` 被 serde 忽略、静默落到第一个连接，报「sqlite 文件不存在: F:\...\data.db」—— 看着像配置没加载，其实是字段名错了。
4. **`page.is_some()` ≠ 开了分页**（页面设置也挂在同一个 `PageConfig` 上）。凡这类分支都要问「**真开分页了吗**」（`rows_per_page > 0`）。踩过两次：`xlsx_header_rows` 不判分页 → 只配纸张就把「2 行表头」静默变「1 行」；`paginate` 没真分页 → 长表印**「第 1/1 页」**（错）。

## 能力边界（**别再说「画布有、服务端没有」**）

图片 / 条码二维码 / 图表格 / 样式 + 条件格式：**两边都有**（服务端全自研）。
导出：客户端 PDF/SVG/图片，服务端 xlsx/docx/HTML/CSV。§六/§十/§十一/§十四

**教训**：判断能力有没有，**先 grep 源码，别先看依赖清单**。

## 数据源现状

sqlite ✅ / postgres ✅ / **odbc ✅（可选 feature，默认不编）**。UI 下拉只这三项（`admin.html:407`）。
手写 `mysql`/`mssql`/`oracle` **明确报错**（`unsupported_engine_name()`）；⚠️ 但 `norm_engine()`
**仍回落 sqlite**，且 `ServerConfig::load()` **不调 `validate()`** → 「静默降级」这条路**还在**，
只是被调用方的显式检查挡在前面。`/print` 只支持 pdf/html。

## 前端三条类型闸（2026-09-23 起两边都是 0 错）

`ts-check.sh`（快查）· `ts-project-check.sh`（designer-react）· `ts-project-check.sh openprint`
（**自动转 `vue-tsc --build`**；openprint 的 tsconfig 是解决方案式，`tsc -p` **假绿**）。
**长期红着的闸 = 没有闸**（曾红 116 条）。修法与坑见 §十七。

**跑闸**：`bash scripts/check-all.sh`（8 道闸；本机 **118s**；`--fast` 前两道 ~4s）。
⚠️ 本机耗时**带 WorkBuddy 会话 shim 会 ×4.3**（511s vs 118s）：它往 `NODE_OPTIONS` 注 `--require`，
vitest 每文件一进程 ⇒ 成本×文件数。**CI 没它**（本机其实更快）。干净数加 `NODE_OPTIONS=""`。§11.6
退出码**三态**：0 通过 / 1 失败 / **2 没跑成（≠ 通过）**。**「没有跑器的闸」比「红的闸」更坏**（绿的 → 虚假信心）。
**已挂 CI**（`.github/workflows/ci.yml`，2026-09-28 **首次真绿** run #4）：**覆盖 = 本脚本覆盖**（20 注入 / 17 探针仍在外；
`verify-ci-workflow.py` 刻意不进，会递归）。**读 CI 用 `--remote`**：公开仓库的 `/actions/runs` 与
`/check-runs/{id}/annotations` **裸 curl 就能读**（只有 job log 要 admin）；红时把**闸名+输出尾部**写成 `::error::`；**绿时也发 `::notice::`（闸数+耗时）**——`job success` 说明不了「闸真的跑了」。
⚠️ **本地全绿 ≠ CI 会绿**（两次「本地 7/7 → 推 → CI 红」）→ **推完必须 `--remote` 复核**。两形态：① 闸引用**未入库**文件
（`fresh_clone_checks()`）；② 测试**依赖宿主可执行文件**（CUPS：macOS 自带 `lpstat`、ubuntu runner 不带）→ **测试只断言契约**。详见 §二十一.13。
`mirror-check.py`：**形状 24 组字段 + 语义 8 条**（§二十一.9），**抽取失败计红**；**仍未闸**：`#RRGGBB` / 表头行数。
闸 7 = designer-react **全部 44 spec / 390 用例**（2026-09-29 去掉 `grid-report-` 过滤，此前只 12 个）；
**闸 8** = openprint 自己的 vitest（70 spec / 915 用例）。

## AI 层（**已有**，别当缺口）

`openprint/src/ai/` + 两个 UI 面板（同 bug 两处）：提示词/few-shot/流式/**校验→回喂→重试**。**只覆盖自由画布**，`ReportDef` 没接。**丢弃必须上报**（`dropped`）。§二十

## 已完成（别再当缺口重复做）· 机制细节在各 §

- **CSV 导出** `POST /api/report/csv`：RFC 4180 + BOM + CRLF；写 `text` 不写 `formula`。**注入（`=cmd|`）刻意不改写**（加 `'` 会改掉 `+86` 手机号）。§十三
- **分页不切合并格** `merge_blocked_boundaries()`。**主格展开出来就是合并格** → 「不在合并格中间切页」==「组内不跨页」。代价：页大小不再严格等于 `rows_per_page`（宁超不切）。§十二
- **格子样式 + 条件格式** `CellModel.style` → xlsx + HTML 都落地（无样式时输出**逐字节不变**）。**刻意不给边框**（Univer 不渲染）；颜色只认 `#RRGGBB`（认不出报 400）。条件格式**无新渲染代码**。§十四/十五
- **格子图片** `CellTpl.image`/`CellModel.image`（两槽都认）→ xlsx 真嵌入 + HTML `<img>`。只收 data URI（收路径＝任意文件读取原语）。§六
- **图表格** `CellTpl.chart`/`CellModel.chart`（两槽都认）→ HTML 内联 SVG + xlsx **原生图表**，声明**模板坐标**。一个声明只画一份 · 空值是空档不是 0 · 是导出那刻的快照。§十
- **条码 / 二维码** `CellTpl.barcode`/`CellModel.barcode` → HTML 内联 SVG + xlsx **1 位灰度位图**（自研 PNG）。QR（**字节模式 + ECC M + v1~10**）+ Code128。**展开行 N 行出 N 个**（**反图表**）。判据收成 `GridCell::graphic()`。§十一
- **ODBC** `db_odbc.rs`，可选 feature。**票据指令** `/print` 的 `esc`/`tsc`/`zpl` 已实现。
- **报表参数** `ReportDef.params` + `RunRequest.values`（按名绑）；与老 `RunRequest.params`（数据集名 → 位置数组）**两条通道**。未知/必填缺失/解析不出值**一律报错**；**未知参数检查必须先于必填**（否则 typo 被报成「region 必填」）。
- **报表页面设置** `PageConfig` 后 5 个 `Option` → HTML `@page` + xlsx `pageSetup`/`pageMargins`/`oddFooter`。**B5 = JIS 182×257**。**背景/水印没做**。§十六
- **Word 导出** `POST /api/report/docx` → `docx.rs` + `zip.rs`（**只写 method 0**）。**本机没 Word/WPS** → 「能打开」**验不了**，只用**四条可判定不变量**替代；**失败全有全无**。§十八
- **覆盖保护两道** `force`→409（授权）+ `?base=<updatedAt>`→412（版本，**`base` 压过 `force`**）。唯一写入口 `save(dir,def,Expect)`。§二十一.12
- **数据文件 / 接口数据集（C 类）** `RenderRequest.datasets` 早通着。`dataset-import.ts`/`dataset-fetch.ts`（URL **前端直连**＝不造 SSRF）/`parseWorkbookFile`（xlsx 必须 **`raw:true`+`cellDates`**，否则货币格读成字符串 → **合计都错**）。§十九

## 局限 / 已知取舍

- **分页不认分组**：`paginate()` 按固定行数切拍平网格，不知哪几行同组 → 一组明细跨页时第二页只有重复表头，**补不出主格**。
- **`GridCell` 字段很少**：`text/pos/rowspan/colspan/raw_number/num_format/formula` + 后补 `style`/`image`/`chart`/`barcode`。设计器里的彩色是**语义高亮**（标角色不标长相）。xlsx 基础样靠导出器写死。
- 不是缺口（已核）：表达式函数全在；`CellModel` 无死字段；分页三配置都生效。
- ⚠️ **5 个已复现缺陷** → `架构评审核验-逐条复现.md`（①②③④ 已修，⑤ 不按原注释实现）。**诊断已分级接进界面**（§二十四，Error 拦导出）。**跨数据集两条红线**：列主格跨数据集 = 拒绝 + `Error`；`join_view` 取组内全部键的**并集**。细节 §二十三。

## 对照积木报表（`引擎差距分析-对照积木报表.md`；细节 §二十五）

对标 `jeecgboot/JimuReport`：**不是一个物种** —— 它做广度，我们做深度。
A 类 5 项**不做**（填报/大屏/AI/权限分享/移动端）；**填报**唯一真会被问，口径是「按只读设计，**不支持回写**」，**不能说「暂未实现」**。
B 类只剩 **B4 超链接**（打印用不上）+ **B5 子报表**不做；数据源**别追数量**（真差距是「没有非 SQL 数据集抽象」，信创库走 ODBC DSN）。
**⚠️ 许可**：补充条款**禁止同类竞争** + 须保留版权标识 → **可读 README 对标功能，不能抄代码 / 兼容其模板格式**。想兼容先找法务。
