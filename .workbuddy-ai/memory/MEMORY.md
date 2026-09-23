# 项目长期记忆（report）· 核心

引擎：Rust `print-server`（展开 + 服务端导出）+ TS `openprint`（引擎层，被 designer-react alias 引用）+ `designer-react`（UI）。

> **细节在 `REFERENCE.md`**（验证方法论 / 沙箱 / 硬事实 / UI 测试 / 单位换算 / 图片·图表·条码·条件格式·docx·票据）。需要时读，别凭记忆。
> 本文件只放「几乎每个任务都用得上」的，**必须 ≤12KB** —— 超了注入时会被截断。

## 三个「表格」不是一回事（问「能不能合到 Univer」前先分清）

| 模型 | 结构 | 坐标 | 本质 | 在哪 |
| --- | --- | --- | --- | --- |
| 自由画布 | `AnyControl[]` 控件树 | mm 绝对定位 | 打印版面 | `designer-react/src/canvas/` |
| 表格控件 | `TableCell[][]` 固定行列 | 挂靠控件 | 单据明细 | `openprint/src/types/control.ts` |
| 非线性报表 | `CellTpl[][]` 行列可扩展 | 运行期布局 | 分组/交叉 | `openprint/src/report/grid-report.ts` |

混用这三个词是沟通事故的主要来源。用户说「自由表格」时先确认指哪个。

## Univer 硬约束（实测，别再试）

1. 列宽单位 **px 不是 mm**（打印侧 mm，自己映射）。
2. 同页面只能有一个活 Univer：再 `createUniver()` **不抛异常但完全不渲染**（0 canvas）→ 单例 + 跟随选中切换。
3. 样式通道只有「底色 + 字色」：`bg` `cl` `bl` `it` ✅；`bd` 边框**完全不渲染** ❌；`ul` 下划线会画但**永远用字色**。→ 别设计依赖边框的维度。
4. **单测证明不了 Univer 画得出某样式**（曾带着画不出的橙色边框过了 11 条单测）。验渲染只能截图数像素（skill `canvas-pixel-verify`）。
5. 剥公式引擎要连带改四件事，漏一个就静默坏：docs+docs-ui 插件 / CSS（原子类 `univer-h-full`）/ `presets: []` / **语言包**（缺了 `LocaleService` 没初始化 → 一改格子就抛错，界面看不出来）。配方见 `univerFormulaFree.ts` 顶部注释。
6. `FWorksheet` **没有 `getCell`**。`sheet?.getCell?.(r,c)` = `undefined`，TS 不报、运行期不报，整段死代码。调新方法前先核 facade `.d.ts`。

## 报表文件 = ReportDef

存 `print-server/reports/<id>.json`（**配置文件同级**）。顶层 `format` … `options` 共 10 个字段。**存的是「模板 + 数据源声明 + 渲染选项」，不是数据快照**。

- 五种入口：内置样例 / 分组汇总 / 交叉表 / 画布表格 / 自由模板。前四种是**生成器**，自由模板是**通用表达** → `openReport` 一律 `setMode('free')`。
- 一格 = `CellTpl` 两层：自身 `value` + 合并；`model?: CellModel` 二十余字段分四组（数据绑定 / 展开 / 主格 / 表达式）。
- **主格关系不画进格子**：网格旁常显主格树 `parentTreeOf`，选中点亮 `parentChainOf`。
- 存/开/跑：`PUT /api/reports/save` · `GET /api/reports/:id` → `templateToGrid` · `POST /api/reports/:id/run`。模板**存原样**，`options` 单独存；`withExportFormula`/`withExpandControl` 渲染前才套（自由模板**刻意不套**后者）。
- `id` 白名单 `[A-Za-z0-9_-]` ≤80 是安全边界（直接拼文件名）。
- 样例：`print-server/reports/sales-by-region.json`。

## 三条「静默失败」红线（改了必自查）

1. **报表目录跟着 cwd 走**：`store::reports_dir(config_path)` = 配置文件同级的 `reports/`，默认配置路径是**相对**的 `print-server.json`。从仓库根启动 → `/api/reports` 返回 `[]`，**无任何报错**。刻意设计，只做披露（横幅 / `/health` / 响应头）。响应头跨域默认读不到（`CorsLayer::permissive()` 已 expose）；**curl 证明不了浏览器能读**，要页面里 `fetch()` 读。`HeaderValue` 只收可见 ASCII → 中文路径 percent 编码。
2. **预览与导出是两套口径**：`buildRenderRequest` 前端算 `headerRows`；xlsx 导出在 Rust 侧另算（`ReportTemplate::header_row_count()`，判据：从第一行起连续「既无 `expand_type=r` 也无 `row_parent」的行；`row_parent: ""` 也算没主格）。**不一致是静默的**。生成器模板第一行是**标题**、第二行才是列头 → 典型值 **2 / 2 / 2 / 3**。改一侧要同步另一侧；`sample_template_has_two_header_rows` 是钉子。**这条也管 `repeat_header_rows`**，见红线 4。
3. **`ReportSource` 是 `rename_all = "camelCase"`** → JSON 里是 **`connId`**。写成 `conn_id` 被 serde 忽略、静默落到第一个连接，报「sqlite 文件不存在: F:\...\data.db」—— 看着像配置没加载，其实是字段名错了。
4. **`page.is_some()` ≠ 开了分页**（页面设置也挂在同一个 `PageConfig` 上）。凡这类分支都要改问「**真开分页了吗**」（`rows_per_page > 0`）。踩过两次：`xlsx_header_rows` 不判分页 → 只配纸张就把「2 行表头」静默变「1 行」；`paginate` 没真分页时返回 1 页 → 长表印**「第 1 / 1 页」**（错的，比不印更坏）。

## 能力边界：画布有、服务端报表没有的东西

| 能力 | 自由画布 | 服务端报表（`CellTpl`） |
| --- | --- | --- |
| 图片 / 条码 / 二维码 | 有 | **有**（`image` / `barcode`，均自研） |
| 样式 + 条件格式 | 有 | **有**（`style` / `conditional`） |
| 图表 | 有（自研 `chartkit`，零依赖） | **有**（`chart`，声明**模板坐标**；xlsx 嵌原生图表） |
| 导出 | 客户端 PDF/SVG/图片 | 服务端 xlsx / docx / HTML / CSV |

**教训**：判断某能力有没有，**先 grep 源码，别先看依赖清单**。

## 数据源现状

sqlite ✅ / postgres ✅ / **odbc ✅（可选 feature，默认不编）**。MySQL **归一成 sqlite**，但 UI 下拉只有三项（`admin.html:407`），**手改配置才会踩**。`/print` 只支持 pdf/html。

## 前端三条类型闸（2026-09-23 起两边都是 0 错）

`ts-check.sh`（快查）· `ts-project-check.sh`（designer-react）· `ts-project-check.sh openprint`
（**自动转 `vue-tsc --build`**；openprint 的 tsconfig 是解决方案式，`tsc -p` **假绿**）。
**长期红着的闸 = 没有闸**（曾红 116 条）。修法与坑见 §十七。

## 已完成（别再当缺口重复做）

- **CSV 导出**：`POST /api/report/csv` + `GET /api/report/sample.csv`。RFC 4180 + UTF-8 BOM + CRLF。写 `text` 不写 `formula`。**CSV 注入（`=cmd|`）刻意不改写**（加 `'` 会改掉 `+86` 手机号）。
- **分页不切合并格**：`merge_blocked_boundaries()`。**关键洞察：主格展开出来就是合并格** → 「不在合并格中间切页」==「组内不跨页」。代价：页大小不再严格等于 `rows_per_page`（宁超不切）。
- **格子样式 + 条件格式**：`CellModel.style` → `GridCell.style` → xlsx `with_style()` + HTML `<td style>`。**刻意不给边框**（Univer 不渲染）。颜色只认 `#RRGGBB`，认不出**两端点都报 400**。条件格式（第一条命中生效）**无新渲染代码**。细节 §十四/§十五。
- **HTML 预览画样式（#74）**：`to_html` 原来**不读** `GridCell.style` → 样式/条件格式预览里全看不到。现由 `html_style_attr()` 渲成 `<td style>`，`to_html` **返回 `Result`**（校验文案与 xlsx 逐字一致）。无样式时输出**逐字节不变**；坏样式在 xlsx 端点 **500 → 400**。细节 §十五。
- **MySQL / MariaDB / SQL Server / Oracle 明确报错**：`unsupported_engine_name()`。注意 `ServerConfig::load()` **不调 `validate()`**（只有保存/试连调），手改配置写 mysql 会报误导性的「sqlite 文件不存在」。
- **格子图片**：`CellTpl.image` / `CellModel.image`（**两槽都认**）→ `GridCell.image` → xlsx 真嵌入 + HTML `<img>`。只收 data URI（不做文件路径：模板可分享，读本地文件 = 任意文件读取原语）。探针 + 反证 6 条。
- **图表格**：`CellTpl.chart` / `CellModel.chart`（两槽都认）→ `GridCell.chart` → HTML 内联 SVG + xlsx **原生图表**。声明**模板坐标**。三条硬约定：**一个声明只画一份**（图片/条码相反）· **空值是空档不是 0** · xlsx 数写在**表格下方隐藏列** → 图表是**导出那一刻的快照**。细节 §十。
- **条码 / 二维码**：`CellTpl.barcode` / `CellModel.barcode`（两槽都认）→ `GridCell.barcode` → HTML 内联 SVG + xlsx **1 位灰度位图**（自研 PNG 编码器）。QR（**字节模式 + ECC M + v1~10**）+ Code128 全表。**展开行 N 行出 N 个**（同图片，**反图表**）。优先级 `图片 > 图表 > 条码` 收成**一个判据** `GridCell::graphic()`。设计器面板已接上（判据与 Rust 同口径）。细节 §十一。
- **ODBC 引擎**：`db_odbc.rs`，可选 feature。**票据指令**：`/print` 的 `esc` / `tsc` / `zpl` 已实现。
- **报表参数**：`ReportDef.params` + `RunRequest.values`（按名绑）；与老 `RunRequest.params`（数据集名 → 位置数组）是两条通道。未知 / 必填缺失 / 引用解析不出值**一律报错**，且**未知参数检查必须先于必填检查**（否则 typo 被报成「region 必填」）。
- **报表页面设置**（纸张/方向/边距/页码/居中）：`PageConfig` 后 5 个 `Option` 字段 → HTML `@page`（**只吐作者明写的项**）+ xlsx 每 sheet 的 `pageSetup`/`pageMargins`/`oddFooter`。**页码只能服务端烤进 HTML**（PDF 走 Chrome CLI，吐不出页眉页脚）。**B5 = JIS 182×257**（Excel 码 13）。**背景 / 水印没做**。细节 §十六。
- **Word 导出（B6）**：`POST /api/report/docx` → `docx.rs` + `zip.rs`（**只写 method 0**；CRC-32 与 PNG 共用）。**本机没 Word/WPS** → 「Word 能打开」**验不了**，只能用**四条可判定不变量**（良构 XML / part 闭合 / `r:id` 闭合 / 子元素顺序）替代；**失败是全有全无**。细节 §十八。

## 局限 / 已知取舍

- **分页不认分组**：`paginate()`（`mod.rs:319`）按固定行数切拍平网格，不知道哪几行同组 → 一组明细跨页时第二页只有重复表头，**补不出主格**。（「组内不跨页」靠合并格边界实现。）
- **`GridCell` 字段很少**：`text / pos / rowspan / colspan / raw_number / num_format / formula` + 后补的 `style` / `image` / `chart` / `barcode`。设计器里的彩色是**语义高亮** —— 标的是「这格什么角色」不是「长什么样」。xlsx 基础样靠导出器写死。
- **`GridCell.pos` 保留模板坐标** → 可反查展开后的输出范围（服务端画图表的前提）。
- 已核对**不是**缺口的：表达式函数集（11 官方 + MAP/FILTER/REDUCE/FLATMAP）全在；`CellModel` 无死字段；分页三配置都生效；多 sheet 导出支持。

## 对照积木报表的差距分析（`引擎差距分析-对照积木报表.md`）

对标 `jeecgboot/JimuReport`。**结论：不是一个物种** —— 它做广度（填报 / 大屏 / AI / 权限 / 移动端），我们做深度（打印版面 + 非线性内核）。

1. **A 类 5 项明确不做**：填报回写 / 大屏 / AI / 权限分享 / 移动端。**填报**是唯一业务上真会被问的 —— 三个引擎只读，是**架构取舍**；对外口径必须是「按只读设计，不支持回写」，**不能说「暂未实现」**。
2. **B 类 6 项才是真该补的**。图表 / **条码二维码** / **条件格式** / **B6 Word 导出** ✅（前三者同根因：`CellTpl` 缺「非文本格子」通道）。剩 **B4 超链接**（打印用不上）/ **C 文件·API 数据集**（**最便宜的 80% 不动 Rust**：`RenderRequest.datasets` 已存在）。**B5 子报表：不做**。
3. **数据源别追数量**（3 vs 30+）。真差距是「没有非 SQL 数据集抽象」；信创库走 ODBC DSN，别逐个写适配。
4. **⚠️ 许可**：其补充条款**禁止同类竞争** + 必须保留版权标识。本项目就是报表引擎，属同类 → **可读 README 对标功能，不能抄代码 / 兼容其模板格式**。想兼容先找法务。
