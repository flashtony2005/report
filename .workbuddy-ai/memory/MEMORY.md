# 项目长期记忆（report）· 核心

引擎：Rust `print-server`（非线性报表展开 + 服务端导出）+ TS `openprint`（引擎层，被 designer-react alias 引用）+ `designer-react`（UI）。

> **细节在 `REFERENCE.md`**（验证方法论 / 沙箱 / 硬事实 / UI 测试配方 / Excel 单位 / 图片·图表·条码·odbc·票据）。需要时读它，别凭记忆。
> 本文件只放「几乎每个任务都用得上」的，**必须 ≤12KB** —— 超了注入时会被截断，等于后半段不存在。

## 三个「表格」不是一回事（问「能不能合到 Univer」前先分清）

| 模型 | 结构 | 坐标 | 本质 | 在哪 |
| --- | --- | --- | --- | --- |
| 自由画布 | `AnyControl[]` 控件树 | mm 绝对定位 | 打印版面 | `designer-react/src/canvas/` |
| 表格控件 | `TableCell[][]` 固定行列 | 挂靠控件 | 单据明细 | `openprint/src/types/control.ts` |
| 非线性报表 | `CellTpl[][]` 行列可扩展 | 运行期布局 | 分组/交叉 | `openprint/src/report/grid-report.ts` |

混用这三个词是沟通事故的主要来源。用户说「自由表格」时先确认指哪个。

## Univer 硬约束（实测，别再试）

1. 列宽单位 **px 不是 mm**（打印侧 mm，要自己映射）。
2. 同页面只能有一个活 Univer：再 `createUniver()` **不抛异常但完全不渲染**（0 canvas）→ 只能单例 + 跟随选中切换。
3. 样式通道只有「底色 + 字色」：`bg` `cl` `bl` `it` ✅；`bd` 边框**完全不渲染** ❌；`ul` 下划线会画但**永远用字色**。→ 别设计依赖边框的第三个视觉维度。
4. **单测证明不了 Univer 画得出某样式**（曾带着画不出的橙色边框过了 11 条单测并提交）。验渲染只能截图数像素（skill `canvas-pixel-verify`）。
5. 剥公式引擎要连带改四件事，漏一个就静默坏：docs+docs-ui 插件 / CSS（原子类 `univer-h-full`）/ `presets: []` / **语言包**（缺了 `LocaleService` 没初始化 → 一改格子就抛错，且界面完全看不出来）。配方与报错原文见 `univerFormulaFree.ts` 顶部注释 + REFERENCE.md。
6. `FWorksheet` **没有 `getCell`**。`sheet?.getCell?.(r,c)` = `undefined`，TS 不报、运行期不报，整段死代码。调新方法前先核 facade `.d.ts`。

## 报表文件 = ReportDef

存 `print-server/reports/<id>.json`（**配置文件同级**）。顶层 `format version id name description updatedAt template sources options`。**存的是「模板 + 数据源声明 + 渲染选项」，不是数据快照**，打开/执行时按 sources 现查。

- 五种定义入口（`GridReportModal` Segmented）：内置样例 / 分组汇总 / 交叉表 / 画布表格 / 自由模板。前四种是**生成器**，自由模板是**通用表达** → `openReport` 一律 `setMode('free')`。
- 一格 = `CellTpl` 两层：自身 `value` + 合并；`model?: CellModel` 二十余字段分四组（数据绑定 / 展开 / 主格关系 / 表达式）。
- **主格关系不画进格子**：网格旁常显主格树 `parentTreeOf`，选中点亮 `parentChainOf`。
- 存/开/跑：`PUT /api/reports/save` · `GET /api/reports/:id` → `templateToGrid` · `POST /api/reports/:id/run`。模板**存原样**，`options` 单独存；`withExportFormula`/`withExpandControl` 渲染前才套，自由模板**刻意不套** withExpandControl。
- `id` 白名单 `[A-Za-z0-9_-]` ≤80 是安全边界（直接拼文件名）。
- 样例：`print-server/reports/sales-by-region.json`。

## 三条「静默失败」红线（改了必自查）

1. **报表目录跟着 cwd 走**：`store::reports_dir(config_path)` = 配置文件同级的 `reports/`，默认配置路径是**相对**的 `print-server.json`。从仓库根启动 → `/api/reports` 返回 `[]`，**没有任何报错**。刻意设计，只做披露（启动横幅 / `/health.reportsDir` / `x-reports-dir` 响应头）。自定义响应头跨域下默认读不到，需服务端 expose（`CorsLayer::permissive()` 自带）；**curl 证明不了浏览器能读**，必须页面里 `fetch()` 读。`HeaderValue` 只收可见 ASCII → 中文路径 percent 编码。
2. **预览与导出是两套口径**：`buildRenderRequest` 在前端算 `headerRows`（TS `headerRowCount`）；xlsx 导出在 Rust 侧另算一遍（`ReportTemplate::header_row_count()`，判据：从第一行起连续「既没有 `expand_type=r` 也没有 `row_parent」的行；`row_parent: ""` 也算没主格）。**不一致是静默的**：预览 2 行表头、导出只有标题行有表头样式、打印列头不跨页重复，界面完全看不出来。生成器产出的模板第一行是**标题**、第二行才是列头 → 典型值 **2 / 2 / 2 / 3**。改任一侧都要同步另一侧；`sample_template_has_two_header_rows` 是那颗钉子。
3. **`ReportSource` 是 `rename_all = "camelCase"`** → JSON 里是 **`connId`**。写成 `conn_id` 被 serde 忽略、静默落到第一个连接，报「sqlite 文件不存在: F:\...\data.db」—— 看着像配置没加载，其实是字段名错了。

## 能力边界：画布有、服务端报表没有的东西

| 能力 | 自由画布 | 服务端非线性报表（`CellTpl`） |
| --- | --- | --- |
| 图片 | 有 | **有**（`CellTpl.image` / `CellModel.image`，只收 data URI） |
| 样式（字色/底色/粗斜/字号/对齐） | 有 | **有**（`CellStyle`） |
| 条码 / 二维码 | 有（`PrintQrcode`、`data-binder` barcode） | **有**（`CellTpl.barcode`；自研 QR + Code128 编码器） |
| 图表 | 有，**自研** `openprint/src/core/chartkit`（bar/line/pie，纯函数出 SVG、零第三方依赖） | **有**（`CellTpl.chart`；声明**模板坐标**不是数据；xlsx 嵌**原生可编辑**图表） |
| 导出 | 客户端 `export-engine/`（PDF/SVG/图片） | 服务端 xlsx / HTML / CSV |

**教训**：判断某能力有没有，**先 grep 源码，别先看依赖清单**（没第三方图表库 ≠ 没有图表能力 —— 是自己写的）。

## 数据源现状

sqlite ✅ / postgres ✅ / **odbc ✅（可选 feature，默认不编）**。MySQL **归一成 sqlite**（`normalizeDbEngine('mysql')==='sqlite'`，有测试钉住），但 UI 下拉只有 sqlite/postgres/odbc 三项（`admin.html:407`），**手改配置才会踩**。`/print` 只支持 pdf/html。

## 已完成（别再当缺口重复做）

- **CSV 导出**：`POST /api/report/csv` + `GET /api/report/sample.csv`。RFC 4180 + UTF-8 BOM + CRLF。写 `text` 不写 `formula`。**CSV 注入（`=cmd|`）刻意不改写**：加 `'` 前缀会把 `+86` 手机号也改掉，拿正确性换安全不值。
- **分页不切合并格**：`merge_blocked_boundaries()`。**关键洞察：主格展开出来就是合并格** → 「不许在合并格中间切页」==「组内不跨页」，不用引入润乾 9 类带区模型。代价：页大小不再严格等于 `rows_per_page`，组超过一页时那页必然超（宁超不切）。
- **格子样式 `CellStyle`**：bold / italic / font_size / color / bg / h_align / v_align，链路 `CellModel.style` → `CellInst.style` → `GridCell.style` → xlsx `with_style()`（**叠加**在基础格式上）。**刻意不给边框**（Univer 不渲染 = 静默失败）。**颜色只认 `#RRGGBB`，认不出来报 HTTP 500**（点名哪格哪个值）。
- **MySQL / MariaDB / SQL Server / Oracle 明确报错**：`unsupported_engine_name()`。注意 `ServerConfig::load()` **不调 `validate()`**（只有保存/试连调），手改配置写 mysql 会报误导性的「sqlite 文件不存在」。
- **格子图片**：`CellTpl.image` / `CellModel.image`（**两个槽都认**）→ `GridCell.image` → xlsx 真嵌入 + HTML `<img>`。只收 data URI（不做文件路径：模板可被导入分享，读本地文件 = 任意文件读取原语）。探针 `verify-xlsx-image.py` + 反证 `fault-inject-image-probe.py`（6 条）。
- **图表格**：`CellTpl.chart` / `CellModel.chart`（两个槽都认）→ `GridCell.chart` → HTML 内联 SVG + xlsx **原生图表**。声明的是**模板坐标**（`categories: ["A3"]`），整个网格填完后才解析。三条硬约定：**一个声明只画一份**（行展开会复制，**图片 / 条码相反**）· **空值是空档不是 0** · xlsx 的数写在**表格下方的隐藏列** → 图表是**导出那一刻的快照**。细节 §十。探针 `verify-xlsx-chart.py` + 反证（10 条）。
- **条码 / 二维码**（B2 收口）：`CellTpl.barcode` / `CellModel.barcode`（两个槽都认）→ `GridCell.barcode` → HTML 内联 SVG + xlsx **1 位灰度位图**（xlsx 只收位图 → 手写了零依赖 PNG 编码器）。编码器自研：QR（**字节模式 + ECC M + v1~10**，上限 213 字节）+ Code128 全表。**展开行里 N 行出 N 个**（同图片，**反图表**）。优先级 `图片 > 图表 > 条码` 收成**一个判据** `GridCell::graphic()`。细节 §十一。探针 `verify-barcode.py` / `verify-xlsx-barcode.py` + 反证（13 条）。**设计器面板已接上**（`CellModelEditor`「条码」「图表」两段；判据 `barcodeProblem`/`chartProblem` 与 Rust 同口径，改一处要改两处）。
- **ODBC 引擎**（八项缺口最后一项，至此全清）：`db_odbc.rs`，可选 feature。
- **票据 / 标签指令**：`/print` 的 `esc` / `tsc` / `zpl` 已实现。
- **报表参数**：`ReportDef.params` + `RunRequest.values`（按名字绑）；与老 `RunRequest.params`（数据集名 → 位置参数数组）是两条通道。未知 / 必填缺失 / 引用解析不出值**一律报错**，且**未知参数检查必须先于必填检查**（否则 typo 被报成「region 必填」）。

## 局限 / 已知取舍

- **分页不认分组**：`paginate()`（`mod.rs:319`）是渲染完后按固定行数切拍平网格，不知道哪几行同组 → 一组明细跨页时第二页只有重复表头，**补不出主格**。（「组内不跨页」是靠合并格边界实现的。）
- **`GridCell` 字段很少**：`text / pos / rowspan / colspan / raw_number / num_format / formula` + 后补的 `style` / `image` / `chart` / `barcode`。设计器里的彩色是**语义高亮**（`grid-report.ts:661-666`：纵向扩展黄、横向扩展绿、字段蓝、表达式紫斜体 + 表头/选中/主格高亮）—— 标的是「这格什么角色」，不是「这格长什么样」。xlsx 的基础样靠导出器写死。
- **`GridCell.pos` 保留模板坐标** → 模板坐标可反查它展开后的输出范围。这是「服务端画图表」能成立的关键前提。
- 已核对**不是**缺口的：表达式函数集（官方 11 个 + MAP/FILTER/REDUCE/FLATMAP）全在；`CellModel` 字段**无死字段**；分页三配置都生效；多 sheet 导出支持（`xlsx.rs:37`）；行/列测试已有设计器入口。

## 对照积木报表的差距分析（`引擎差距分析-对照积木报表.md`）

对标 `jeecgboot/JimuReport`（Java 在线报表平台）。**结论：不是一个物种** —— 它做广度（填报 / 大屏 / AI / 权限 / 移动端），我们做深度（打印版面 + 非线性内核）。

1. **A 类 5 项建议明确不做**：填报回写 / 大屏 / AI / 权限分享 / 移动端。其中**填报**是唯一业务上真会被问的 —— 我们三个引擎全只读打开，是**架构取舍**。对外口径必须是「按只读设计，不支持回写」，**不能说「暂未实现」**。
2. **B 类 6 项才是真该补的**。图表 ✅、**条码 / 二维码 ✅**（两项同根因：`CellTpl` 缺「非文本格子」通道，现已补齐）。剩 **B3 条件格式 / B4 超链接·钻取 / B5 子报表 / B6 Word 导出 / C 文件·API 数据集**。
3. **数据源 3 vs 30+ 别追数量**。真差距是「没有非 SQL 数据集抽象」；信创库用 ODBC DSN 接就行，别逐个写适配。
4. **⚠️ 许可**：它的补充条款**禁止同类竞争** + 必须保留版权标识。本项目就是报表引擎，属同类 → **可以读 README 对标功能，不能抄代码 / 兼容它的模板格式**。想兼容先找法务，别自己判断。

写「条件格式」前先看 Univer 硬约束 #3：边框画不出来，别设计依赖边框的条件格式。
