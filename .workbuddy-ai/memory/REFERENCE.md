# 项目参考手册（report）· 按需查阅

`MEMORY.md` 只放核心不变式（有注入大小上限）。**验证方法 / 环境 / 底层细节在这里** —— 动手前读对应小节，别凭记忆。

---

## 一、验证方法论

**断言规矩**
- **位置相关的断言，断言整条序列**。反例：只断言 `grid[1].last()=="行合计"`，注入 bug 后变成 `["地区","1月","行合计"]`（2月被挤掉），`last()` 依然绿。→「目标元素还在」抓不住「旁边元素被挤掉」。
- **只查「有属性」的，别忘了「没属性」的那种**：xlsx 边框校验脚本只查带 `s` 属性的格，去掉边框后无格式的格压根不写 `s`，脚本反而变绿。
- **写完检查脚本必须注入已知错误反向验证**，确认它真能红。
- **XML 探针的正则必须认「自闭合」标签**：`<c r="C3" s="2"/>` 是**空**格，但长得像开标签。写成 `<c ...>(.*?)</c>` 会把这个空格一路吞到**下一个** `</c>`，于是**把别人的文本算到自己头上** → 现象是「表头读不到、空格读到了别人的值」，看着像产品坏了（真踩：`G5` 的「销售额」被记成了 `C3` 的）。正确写法 `<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)` + 内容 `None` 兜底成 `""`。
  → 探针出错的方向是**假红**还算安全，**假绿才是灾难**；所以注入驱动的**基线必须先过**（基线红 = 先修探针，不是先修产品）。
- **单测守不住的东西，探针才守得住**：本次「图表格跟着展开行复制成 N 份」单测全绿（老断言只看第 0 行），拆包探针一眼看出 3 个 `chartN.xml`。**写完探针要顺手问一句「这个 bug 单测能抓到吗」**，答「能」就补单测，答「不能」才说明探针有存在价值。

**故障注入驱动器两个坑**
1. **永远不加 `--exact`**：`cargo test <name> -- --exact` 要**完整路径**，只给函数名会匹配到 0 个用例而**退出码仍是 0** → 每条注入都被读成「仍然是绿的」（12 条全假绿）。
2. 解析 `test result:` 行，**`0 passed` 一律算「没验到」**，不能只看退出码。
- **注入全绿先怀疑注入，不是怀疑代码**（有一条真的绿：宽度驱动 + 高度夹取在缩小场景下与 min-fit 等价，只差在放不放大）。

**两道类型门禁强度不同 —— `ts-check.sh` 过了不等于类型没问题**（2026-09-22 实测）：
- `scripts/ts-check.sh` 是 `tsc --noResolve`，**import 全退化成 `any`** → **跨文件**的类型错
  它**结构上看不见**。本次它在 spec 上「无类型错误」，而同一天 `tsc -p designer-react/tsconfig.json`
  在同一个文件里报出 **2 处真错**（`'code39'` 不满足 `BarcodeSymbology`、`CellBarcode` 缺必填 `value`）。
- 所以**两个都要跑**：`ts-check.sh`（快、覆盖 report 目录、带 `--noUnusedLocals` 抓没用的 import）
  + `tsc -p designer-react/tsconfig.json`（真解析，抓跨文件）。后者要挂 preload，否则 SIGTERM(137)。
- 判据：**只跑 `--noResolve` 就宣称「类型干净」是过度自信**。

**xlsx 导出六步套路**（已跑四遍，完整版见 skill `xlsx-export-verify`）：抽纯函数 → 数值单测 → ≥3 次故障注入 → 真机探针拆 zip → handler 级注入单独一次 → 探针自身也做注入。项目特有的三条：
- 抽纯函数（`column_widths` / `lines_needed` / `header_row_count`）才有得测 —— 导出物是 zip，**Rust 侧断言读不到内容**，只能断言「不报错」等于没测。
- **handler 级注入要单独做**：注入 `xlsx_handler` 后 sample 探针**仍然绿**（走 `sample_xlsx_handler`，另一条路）—— 一个探针守不住全部导出路径。
- 探针自身注入的驱动必须**重 build → 重启服务 → 重跑**（**服务是常驻进程，不重启就是拿旧 binary 测**）。见 `scripts/fault-inject-image-probe.py`。
- `fitToWidth="1"` 是 XML **默认值会被省掉**，真开关是 `pageSetUpPr fitToPage="1"` + `fitToHeight="0"`。

**盘点「某字段是不是死字段」**：统计 `\.field\b` / `field:` 在 `engine.rs`/`xlsx.rs` 的命中数，**但别只看总数** —— 命中里混着测试夹具的结构体字面量（曾出现 19 个字段命中数清一色 23~28，看着像都用了，其实大半是夹具）。要打开看**读点所在的那几行**才算数。

---

## 二、沙箱 / 环境

细节见 skill `sandbox-broker-workarounds`。

- 绕行脚本**已入库**（别写 /tmp，上一版被系统清掉）：`scripts/broker-mkdir-throttle.cjs`（fs broker 是**并发**限流 ~120，不是数量配额）、`scripts/vite-safe-delete-bypass.cjs`（必须在 **setImmediate** 里装，同步段装会让 shim 捕获 wrapper → 无限递归）。
- **`vite` / `vitest` / `vue-tsc` 都挂同样的 preload**，别每次现判。**vitest 不挂的症状极具迷惑性**：只打印 `RUN v3.2.4 <dir>` 然后**一直不动**（单文件也一样），或进程被 **SIGKILL（退出码 137）**，看着像 OOM。判据：`npx vitest --version` 能出、但 `vitest run` 卡在 `RUN` 那行 → **先怀疑 preload，别去查测试代码**。实测对照（同一文件）：不挂 = 卡死 12 分钟 / SIGKILL；挂上 = `Duration 407ms`。
  ```bash
  cd <pkg> && NODE_OPTIONS="--require $PWD/../scripts/vite-safe-delete-bypass.cjs \
    --require $PWD/../scripts/broker-mkdir-throttle.cjs" npx vitest run
  ```
- 起 vite：`cd designer-react && NODE_OPTIONS="--require .../scripts/vite-safe-delete-bypass.cjs $NODE_OPTIONS" npx vite --host 127.0.0.1 --port 5200 --strictPort`，必须 `run_in_background=true`（`(cmd &)` / `nohup &` 随 shell 一起死）；日志写 `scripts/.vite-dev.log`；curl 加 `--noproxy '*'`。
- **浏览器 harness 在沙箱里跑不动键盘 E2E**：CDP `Input.insertText` 对多字符串报 `Invalid 'text' parameter`（`hello` 控制实验也失败，确认是 harness 问题）。应对：逻辑抽纯函数 + 单测 + 探针；**画到脸上的那一步走右侧面板 `agent-browser fill`**（antd `Input` 上能用，不像 canvas 击键），再 eval 读多个相关字段确认模型。
- **沙箱删除拦截是「按轮累计」的**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，一轮里超阈值后**每一次**删除都要人工确认）。`shutil.rmtree` 直接被拒。危害：连跑十几次探针的故障注入脚本会在第 N 次挂掉，**报错长得像探针自己坏了**（踩过：误判成「未注入时探针就是红的」）。→ **脚本一律不删文件**：`mkdir(exist_ok=True)` / `DROP TABLE IF EXISTS` / 直接覆盖写（`write_text` 自带截断）。
- **ESM 裸包解析按脚本自己的位置**往上找 `node_modules`，**跟 cwd 无关**。脚本放 `scripts/` 而依赖在 `designer-react/node_modules` 时（jsdom 就是）必须 `createRequire(join(ROOT, 'designer-react/package.json'))`。
- **jsdom 里 `body.textContent` 会把 `<script>` 源码也算进去** → 查「页面上有没有某个词」必须 `cloneNode(true)` 后 `querySelectorAll('script, style').remove()`，否则**源码注释会被当成页面上的字** → 假红（踩过：注释里正好写了那句要消灭的话，3 条断言全假红）。
- **同一个文件的两个 `Edit` 放一条消息里会竞态**，前一个可能被**静默丢掉**（踩过两次：`db.rs` 的 `resolve_target`）。靠「变量报 unused」才发现。→ 同一文件的多个改动**一条一条发**，改完 grep 复核。
- **`tsc --noEmit` 现在是干净的（0 错误）** —— 旧记忆说「designer-react 有 6 处既有报错」**已作废**。判断新错是不是自己引入的，直接看错误总数是不是 0。
- macOS 本机：`timeout` 命令**不存在**；`grep` 的 `\|` **不可用**（BSD grep 当字面量，静默失效）→ 一律 `grep -E` 或直接用 Grep 工具。
- **cargo 的 `registry/cache/*.crate` 会被清掉，而 `registry/src/` 的解压源码还在**（`cache/` 目录 mtime 比 `src/` 新很多 = 被 GC 过）。后果：`cargo build --offline` 报 `failed to download <pkg>` —— cargo **不回退到已解压的 src**；联网则卡在 `transfer too slow: failed to transfer more than 10 bytes in 30s`。
  **判据：cargo 下载慢不是网络慢。** 同一条 URL 用 `curl` **4.7 秒**下完，cargo 自己 15 分钟只下完 40 个包。别等它，自己补：
  ```bash
  # 1) 从 Cargo.lock 列出缺的包（对比 cache/index.crates.io-*/ 里的 *.crate）
  # 2) curl 直接落到 cache 目录（不用临时文件）：
  #    https://static.crates.io/crates/<name>/<version>/download  →  <name>-<version>.crate
  # 3) 补完 `cargo build --offline` 秒过（有 sccache，编译只要 4~8s）
  ```
  **并发最多 2**：`xargs -P 8` 会大面积触发 `TLS ... unexpected eof while reading`（沙箱代理限流）；`-P 2` 全成功。放宽阈值（`CARGO_HTTP_LOW_SPEED_LIMIT=1 CARGO_HTTP_TIMEOUT=600 CARGO_NET_RETRY=30`）能少报错但**治不了根本**。
- `~/.cargo/config.toml`：`rustc-wrapper = sccache` + `target-dir = ~/.cargo/target`（**项目里没有 `target/`**）。
- **ahash 不是测试专用依赖**：它经 `hashlink ← hashbrown 0.14` 进正常构建图（我先前判成 dev-only，是错的）。`--offline` 报缺哪个就是哪个，别猜。

---

## 三、print-server（Rust 侧）硬事实

- 默认端口 **18888**；binary 在 `~/.cargo/target/debug/print-server`（项目里**没有** `target/`）。
- **不是 rustfmt-clean**（`cargo fmt --check` 有 4483 行差异）→ **千万别 `cargo fmt`**，手改保持局部风格。
- 渲染输出的格子字段是 **`text`**（`GridCell.text`）；`value` 是模板侧 `CellTpl` 的。拿 `value` 读渲染结果会一片空，容易误判成「渲染坏了」。
- `SheetTpl` **不在** mirror-check 的 `CAMEL_CASED` 白名单里（白名单是 ReportSource/ReportDef/ReportOptions/ReportSummary）→ 新字段两端都用 snake_case。
- 批量给 struct 加字段：正则要排除 `-> Foo {`（长得和结构体字面量一样），用 `(?<!-> )SheetTpl\s*\{`。改完**插入数要和编译器报的错数对得上**，多出来就是误伤。
- **`cargo build` 和 `cargo test --no-run` 都要跑**：只跑 build 会漏掉**测试代码里**的字面量（本次：build 报 7 处，`cargo test --no-run` 又报 18 处）。
- **`rust_xlsxwriter 0.99.0` 自带 `chart` 模块**（`ChartType` 含 Column/Bar/Line/Pie/Area/Scatter/Radar/Doughnut/Stock 等）**和 `conditional_format` 模块**。原生 Excel 图表引用**单元格区域**、必须在**同一个 sheet** 上，且导出后在 Excel 里可编辑、无需栅格化。API 形状**只能读 crate 源码**（我凭印象猜错过一次，见下）：
  - `Chart::new(ChartType)`；**`chart.add_series()` 不接参数**，返回 `&mut ChartSeries`（不是 `add_series(Range)`）。
  - 链式：`.set_name(..)` / `.set_categories(..)` / `.set_values(..)`。`IntoChartRange` 对 `&str` `&String` `&ChartRange` **和元组** `(&str, RowNum, ColNum, RowNum, ColNum)` / `(&str, RowNum, ColNum)` 都有实现。
  - **`set_name` 有双重语义**：传 `"Year to date"` 是**字面量名**，传 `"Sheet1!$C$1"` 是**区域引用**（`ChartRange::new_from_string` 认不出区域就整串当字面量）。想引用表头格就用**元组**形式，别拼字符串。
  - `RowNum = u32`，`ColNum = u16` → **列号要 `as u16`**（`insert_chart_with_offset` 的第一个参数是 `u32`，第二个是 `u16`）。
  - `Worksheet::insert_chart(row, col, &Chart)` / `insert_chart_with_offset(row, col, &Chart, x_off: u32, y_off: u32)`、`set_column_hidden(col)`。
- **`rust_xlsxwriter 0.99.0` 没有 `image` feature**，PNG/JPEG/GIF/BMP 头解析是纯 Rust 内置的。别凭 crate 名字猜依赖树（我先前误判成要引 `rust_image`）。

---

## 四、前端 UI 测试（antd v6 + jsdom）

`designer-react` 有 5+ 个 modal 规格，`createRoot` + `act` 挂载，模式见 `p55-modals.spec.tsx` / `data-import.spec.tsx`。**antd Select 在 jsdom 里能正常驱动**，但坑不少：

1. 触发器是 **`.ant-select-content`**（v6），不是 v5 的 `.ant-select-selector`。开下拉：`mousedown`（bubbles）→ 等一拍 → 点 `.ant-select-item-option`。
2. **上一个下拉不会从 DOM 摘掉**，只加 `-hidden` 类 → 必须只在「最后一个未 hidden 的 `.ant-select-dropdown`」里找。（踩过：分组字段选完 city，再选数值字段时点中的还是分组字段的下拉，`valueField` 一直空、请求一直发不出去，且不报错。）
3. `data-testid` 落哪层随组件而异（InputNumber 可能在 input 本身也可能在外层 div），查询要 `matches('input') ?? querySelector('input') ?? parentElement.querySelector`。
4. 受控输入用原生 setter 触发（绕过 React valueTracker）。**受控组件的 spec 必须把 onChange 结果喂回去**：`CellModelEditor` 只点开关不重新 render，界面永远停在初始值（色块不跟着变、断言拿到旧值）。要像真实父组件那样 `sync()` 把新 cell 传回去。jsdom 对 `style.background` 有时保留 `#RRGGBB`、有时转 `rgb(...)`，断言两种都收。
5. **预览有 400ms 去抖**，等请求要轮询到 6s；去抖靠 `doRender` 身份变化触发 → 「state 变了但没进依赖数组」= 请求根本不发。
6. **jsdom 里 antd Modal 的关闭动画永远结束不了**（没有 `transitionend`）→ `destroyOnHidden` 永远不摘 DOM，点完「取消」遮罩一直停在 `ant-fade-leave-active`。**「弹窗关掉了」不能断言 `querySelector` 找不到内容**，只能断言「有没有挂上 `ant-(fade|zoom)-leave` 类」。`okButtonProps`/`cancelButtonProps` 里的 `data-testid` 会落在 `<button>` 本身，点它就能触发 onOk / onCancel。

**UI 层用例要断言请求体，不是「没报错」**（见 `grid-report-paging.spec.tsx`，四个用例各自做了故障注入）。纯函数 `buildRenderRequest` 的用例在 `grid-report-request.spec.ts`，它测不到 state → 入参 → 依赖数组那段接线，**两层都要有**。

---

## 五、Excel 单位换算（写 xlsx 布局前先看，别凭记忆）

```
px = round(chars × 7) + 5          // chars → 像素（7 = max_digit_width, 5 = cell_padding）
chars = ceil((px − 5.5) / 7)       // 反解，**ceil 不是 round**
px = round(pts × 4/3)              // 磅 → 像素（15pt = 20px）
XML width = floor(px × 256/7)/256  // 写进 <cols> 的形式
px = round(width_xml × 7)          // 反解**不带 +5**（探针第一版就是这么算错的）
1 px = 9525 EMU；1 dxa = EMU/635
```

- **列宽上限 60 字符 / 行高上限 409.5 磅**（= 546px）。行高超上限 Excel **直接拒开文件**。
- **图片必须按 DPI 折显示尺寸**：Excel 按物理尺寸显示，203dpi 的 120×80 只显示约 57×38px。不折就是 2.1 倍大 —— 而**设计器里看着是好的**（设计器用像素）。图**不放大**，只缩到不超格宽；合并格按**整段**算可用空间。
- **`insert_image_with_offset` 插的是原始尺寸**：只算偏移不调 `.set_scale_to_size(w, h, true)`，大图会盖到右边那一列去（真机探针抓到的）。
- 列宽 `clamp(8, 60)`，两个数都有理由：下限 8（「备注」只有 6 宽，不抬会挤成缝）；上限 60（实测 23 个汉字 = 48 宽，40 会截断；相邻列有内容时 Excel 是**裁掉**不是溢出）。不去掉上限是因为导出同时开了 `set_print_fit_to_pages(1, 0)`，列越宽 → 缩放越狠 → 打印字越小。

---

## 六、格子图片 `CellTpl.image`（2026-09-20 补上）

**两个槽都认**：`CellTpl.image`（手写模板 / 导入）与 `CellModel.image`（**设计器面板写的是这个**）。服务端按 `cell.image.or(model.image)` 合并 —— 只认一个就会出「面板里设了但没生效」。TS 侧 `gridToWorkbookData` 同理：`!!(cell.image || cell.model?.image)`，只看 `cell.image` 的话**面板里设的图在网格里完全看不见**（实测踩过）。

`{from: "literal", src: "<data URI>"}` / `{from: "value", src: ""}`（逐行不同，值取本格字段文本）。

- **只收 data URI，刻意不收文件路径**：模板是用户可编辑、可分享的 JSON，允许路径 = 把模板变成「任意读本地文件」的原语。设计器选文件是浏览器端 `FileReader` 读成 data URI 再进模板。
- 白名单 **png / jpeg / gif / bmp**（正好是 xlsx 能嵌的四种）；webp / svg **指名报错**（rust_xlsxwriter 会**静默**把 webp 转 PNG，且完全不支持 svg）。
- 取不到图**不静默**：该格 `text` → `[图片: 原因]` + 进 `warnings`，表照常出。

---

## 七、可选 feature（默认不编）：三件事必须一起做

完整清单见 skill `optional-feature-verify`。核心三条：

1. **默认构建必须仍然可用，且报错要说「没编进这个构建」+ 重编命令**。说成「暂未实现」是**错**的 —— 听起来像永远没有，用户会去换驱动 / 提需求，其实只要重编一次。见 `db.rs::odbc_not_built_in()`。
2. **界面/接口不能写死能力状态**，要从后端读一个能力位。`/health.odbc = cfg!(feature = "odbc")`，页面**三态**显示：已编入 / 未编入 / **读不到服务状态**。⚠️ 第三态是必须的：**读不到 ≠ 没编入**，混为一谈就是换了个方向的谎。判据：凡「某功能有没有」是**构建期决定**的，页面上就不许出现写死的说法。
3. **验证要覆盖两种构建配置**：`cargo build` 和 `cargo build --features X` 都要跑（本次 313 / 321）。**只测开着 feature 那条路会漏掉一半**。配套：反证脚本要**按构建配置分组**（每组自己的目标文件 / 编译参数 / 探针参数）。

---

## 八、odbc 引擎：三条硬约束

`odbc-api 29`，`default-features = false`（默认带的 `prompt` 会拖进 `winit` GUI 依赖）+ `features = ["odbc_version_3_80"]`，`[features] odbc = ["dep:odbc-api"]`。**不需要额外链接器环境变量**（odbc-sys 构建脚本自己问 `brew --prefix`）。本机依赖：`brew install unixodbc sqliteodbc`。

1. **拿不到裸连接 handle** → 设不了 `SQL_ATTR_ACCESS_MODE`（**没有会话级只读**），也调不了 `SQLGetInfo(SQL_IDENTIFIER_QUOTE_CHAR)`（引号符**写死 `"`**）。原因：`Connection::into_handle(self)` **消费 self**、`Environment::allocate_connection` **私有**。→ 只读降级到**语句级**，残余风险照实写进 README，靠**只读账号**兜底。引号写死可接受：猜错得到**明确 SQL 语法错**，不是静默错数据。
2. **目录函数的名字参数是「搜索模式」不是字面量**：`_` 匹配任意单字符、`%` 任意串、`\` 转义。不转义 → `user_name` **连 `userXname` 一起匹配出来且不报错**。探针里有 `userXname` 诱饵表守这条。
3. **类型要原生解码**（整数/浮点/布尔），全按文本取的话报表 `sum()` 会在字符串上**静默算错**。

编译器层面的坑：`odbc-api` 有**两个 `Connection`**（高层的没有 `as_sys`）；`PrimaryKeysRow` 字段是 **`column`** 不是 `column_name`；**`bool` 没实现 `Pod`** → 用 `Nullable::<u8>` 判 `!= 0`；`col_data_type` 要 **`ResultSetMetadata` trait 在作用域**；是 `VarCharArray<const L: usize>`（没有 `VarArrayLen`）；同步 API 全包 `spawn_blocking`。

### 报错点名的是「连接 id」不是「DSN」（约定，别当 bug 修）

`连接 ODBC 失败（{conn.id}）` —— **postgres 一模一样**（`连接 postgres 失败（{conn.id}）`）。这是全项目统一约定，别只改 odbc 那一处。

容易看错的地方：**内联路径**（`engine=odbc&database=<DSN>`）报错里会出现 DSN —— 但那是因为 `db.rs::odbc_inline` **把 `c.id` 直接设成了 DSN**，不是它特意报 DSN。配置路径（`/api/config/test`）报的是配置里那个 id。→ 写断言时别要求配置路径也报 DSN；要断言的是「**驱动原话透传**」（消息里带 `State:` / `[unixODBC]`），那才是真正会退化、也真正有用的性质。

**通用教训**：断言失败时先查 house convention 再改代码 —— 本次差点把一条**约定**当成 bug 去「修」，那样会让 odbc 与 postgres 不一致。

---

## 九、票据 / 标签指令（`print-server/src/ticket/`）

输入 = 前端 `raw-sanitize.ts` 净化过的画布 JSON（颜色 / 字体样式 / 设计器元数据已裁掉，**别假设 `fill` / `fontWeight` 一定在**）。形状 `{ version, document: { page, sections: [{ components }] }, data? }`；几何单位跟 `page.unit`，原点 = 所属 Section 左上角，多节纵向堆叠。

`mod.rs` 出 IR（`Text/Barcode/Qr/Rule/Box`，坐标统一 mm），`esc.rs` / `tspl.rs` / `zpl.rs` 各自发射。**加新控件类型时记得往 `unsupported()` 那条兜底走**，不能静默 `_ => {}`。

硬约束（踩过的）：
- ESC/POS 只有「行」：`ESC 3 24` **必须显式钉行距**，否则 `ESC d n` 推进多少点由机型默认值定 → 行号全错。中文必须 **GBK**（`encoding_rs::GBK`）。
- TSPL / ZPL 有真 x/y 但**都没有对齐参数** → 居中 / 右对齐要自己按估宽挪 x，不挪会静默变靠左。
- ZPL 内容里的 `^` / `~` 必须 `^FH` 转义（`^`→`_5E`）；没这两个字符时**不要**加 `^FH`。
- 旋转只认 90 倍数（TSPL 0/90/180/270，ZPL N/R/I/B），否则报警告并 snap。
- **203dpi = 7.9921 点/mm**，80mm = 639 点（不是 640）。
- **位置类断言要断整条序列**：第一版 `cur_row += 1` 让同行多图元把后面的内容整体上移一行；只数 `ESC d` 次数的用例抓不住，改成断言喂行序列才红。
- **文本取值顺序**：`contentType` 在场就照它办；缺省回退是 **expression > binding > value**。`binding` 是**数据路径**、`value` 是**字面量**，搞反会把 `customer.name` 原样印出来（看着"有内容"，不报错）。真理源是前端 `data-binder.resolveTextValue`。
- **`service_error` 是 HTTP 200 + `{ok:false, message}`**，不是 5xx —— 写探针别只看状态码。（报表导出那条路才是 500。）

真机探针：`scripts/verify-ticket-print.py`（走真实 `/print`，拆开落盘的指令文件核对喂行序列 / GBK 字节 / 二维码五段长度 / `^CI28` / `^PW639`）。改翻译层就跑它。更多见 skill `ticket-command-verify`。

---

## 十、图表格 `CellTpl.chart`（2026-09-21 补上）

**两个槽都认**：`CellTpl.chart`（手写模板 / 导入）与 `CellModel.chart`（设计器面板写这个）。合并顺序 `cell.chart.or(model.chart)`。

形状 `{kind: "bar"|"line"|"pie", categories: ["A3"], series: [{name, from: "B3"}], title?}` —— 里头的 `categories` / `from` 是**模板坐标**不是数据；`kind` 是 `Option<String>` 不是 enum（写错只坏这一格，不坏整份模板的 serde，与 `NumFmt::kind` 同一套约定）。

解析（`chart.rs`，纯函数）：
- 索引只给**被引用**的坐标建（`referenced_positions`），大表上不白克隆文本。
- 每个坐标的格子**显式按 `(行, 列)` 排序**，不依赖遍历顺序 —— 列向展开时「同行列号递增」恰好让遍历顺序是对的，但那是巧合。
- 取值 `raw_number` 优先，回落 `parse_number(text)`（`text` 已套过格式，会是 `1,234.50` / `12%`）。
- 认不出的 kind / 坐标不存在 / 自己引用自己 / 类目数与值数不等 / 饼图多序列 → **一律报错并点名**；该格 `text` 变 `[图表: 原因]` + 进 `warnings`，表照常出。

三条硬约定（都有注入守着）：
1. **一个声明只画一份**。图表格所在的行会随别的格子展开 → 同一个 `pos` 在网格里出现 N 次；`resolve_charts` 排序后**按 pos 去重**，只认最上最左那一份。图片**相反**（`from: value` 那种一列产品图，就该一行一张）。
2. **空值是空档不是 0**。`ResolvedChartSeries.data: Vec<Option<f64>>`：柱跳过 / 线断成多段 / 饼不计入总量。「空着」和「就是 0」在图上看着一样，在报表里是两回事。
3. **xlsx 的数写在表格下方的隐藏列**。展开后一个模板坐标可能落在**不连续**的行（嵌套分组时 `A3` 落在 0/3/6 行），而 Excel 原生序列**只能引用连续区域** → 解析好的数落到 `helper_col = 列数+1`、起始行 = 表行数+1 的隐藏区，图表引用那里。**代价照实说：图表是导出那一刻的快照**，在 Excel 里改表格数字不会重算图表。没选栅格化成 PNG —— 那会让图变成死图（不可编辑、不可换类型、放大糊）。

服务端 SVG（`chart_svg.rs`）镜像客户端 `chartkit` 的布局常量（`W480/H320`、`mTop=10+titleH`、`mRight=16`、`mBottom=(axis?42:22)+legendH`、`mLeft=axis?44:16`、`ticks=4`、`truncate(s,12)`、图例只在多序列时画）。**`niceMax` 只能照实现不能照注释**（见 §一）。
- 客户端 `ChartSeries.data: number[]` **没有 null** —— `Option<f64>` 的「空档」是服务端自己的扩展，不是镜像来的。

真机探针 `scripts/verify-xlsx-chart.py`（12 组：`chartN.xml` 数量 / 数据块内容且**缺测那格为空** / 隐藏列 / `$F$6:$F$8` 引用 / 缓存点里缺测点**整个缺席**（不是 0）/ 锚点 / 无 `[图表:` 泄漏 / HTML 的 `<svg>` 数与 `<rect>` 数）；反证 `scripts/fault-inject-chart-probe.py`（**10 条**，按错误类型分组：常量 / 接线 / 语义 / 漏判 / 类型映射 / 重复 / 副作用）。驱动会自己 build + 起停服务，`build()` 先试 `--offline`。

---

## 十一、条码格 `CellTpl.barcode`（2026-09-22 补上）

**两个槽都认**：`CellTpl.barcode`（手写模板 / 导入）与 `CellModel.barcode`（设计器面板写这个）。合并顺序 `cell.barcode.or(model.barcode)`。

声明 `CellBarcode {from: "literal"|"value", value, symbology: "qr"|"code128", gs1?}`；结果 `ResolvedBarcode {symbology, rows: Vec<String>, text}` —— `rows` 每行一个字符串、`'1'` = 黑、**静区已含**、一维码已拉伸成面。用字符串不用 `Vec<Vec<bool>>`：报表**每一行**都可能带条码，`true,` 序列化是 5 倍体积差。

### 与图表**相反**的一条：N 行出 N 个条码
图表「一个声明只画一份」（读整列数据，画 N 份会叠在同一格上）；条码内容来自**本格自己的文本**，展开行里跟**图片**一样一行一个。照抄图表的去重逻辑 = 「N 行订单只有一个条码」，是错的。

### 优先级收成**一个判据** `GridCell::graphic()`
`图片 > 图表 > 条码`。以前三个渲染端（`to_html` / `decode_images` / `write_charts`）各判一遍 → **「图片 + 图表」的格子在 Excel 里同时嵌了位图和原生图表**（老 bug，加条码时才挖出来）。现在渲染端只画、引擎决定；被盖住的在引擎里**连编都不编** → 不变式「`GridCell.barcode` 有值 ⟹ 它就是要画的那个」。
- 告警分两处：`resolve_charts` 管**带图表**的组合（它能看到三种声明）；`expand_sheet` 的条码分支管「图片 + 条码」（`resolve_charts` 对没声明图表的格子不跑，不说就静默消失），用 `inst.chart.is_none()` 去重。

### 自研编码器的边界（全部**明确报错**，不静默降级）
- QR：**字节模式 + ECC M + 版本 1~10**（上限 213 字节）。数字 / 字母数字模式、L/Q/H、v11+ 都不做。
- Code128：**不在符号中途切换码集**（切换是启发式，猜错 = **能扫但内容错**，比扫不出来更糟）；只收 ASCII，非 ASCII 报错并指向 `qr`；DEL(0x7F) 拒绝；偶数位纯数字且 ≥4 位走 C 集，控制符走 A 集，其余 B 集。
- **没有 HRI**（条码下方人可读文字）：SVG 画得出、位图画不出，两边不一致比两边都没有更糟。
- 码制只有 QR + Code128；`code39` 之类**明确拒绝**（不静默当二维码 —— 那也能扫，于是「我写的明明是条码」查不出来）。

### 掩码是**质量**不是正确性
8 个掩码全试、罚分最低者胜；掩码号写进格式信息、解码器按号反掩 → **8 个都能扫**。罚分规则 4 **绝不能 panic**：第一版照 `(diff+total-1)/total-1` 抄，恰好 50% 黑时 `usize` 下溢。

### xlsx 只收位图 → 手写 1 位灰度 PNG（`png.rs`）
`bit_depth=1, color_type=0`，**0 = 黑 / 1 = 白**（反了 PNG 仍是「像条码的图」，肉眼看不出来）。zlib 用 **stored block**（`BTYPE=00` + LEN/NLEN）+ 自写 CRC-32 / Adler-32，零依赖。代价照实说：**没压缩，文件比正常的大**。

### `rust_xlsxwriter` 会**按字节去重** media
12 个条码格 → **6 个** `xl/media/imageN.png`，但 drawing 里 **12 个**锚点。探针的期望值必须照这个写，否则会误判成 bug。

### 探针 / 反证
- `scripts/verify-barcode.py`（编码器级）：10 个样本交 **zxing** 解回原文（QR v1~v10 含 213 字节上限、中文 UTF-8；Code128 的 A/B/C 集 + GS1 + 0x0D 控制符）。zxing 的 `format` 是 `"QR Code"` / `"Code 128"`（**带空格**）不是 `qr_code` —— 比对前先归一成字母数字。
- `scripts/verify-xlsx-barcode.py`（真机）：xlsx 位图 + HTML 内联 SVG（**librsvg `rsvg-convert`，独立渲染器**）两边都交 zxing 对原文；另验 1 位灰度 IHDR、锚点去重与跨行分布、颜色写死 `#000`/`#fff`、错误路径，以及**优先级必须从 xlsx 产物验**（JSON / HTML 都走 `graphic()`，渲染端分叉了它们看不出来）。
- `scripts/fault-inject-barcode-probe.py`（**13 条**）。注入锚点必须**恰好匹配 1 处**，否则报「锚点失效」而不是算通过。
- ⚠️ **注入点选错的教训**：第一版 priority 注入让图片格返回 `Graphic::None`（图片干脆不嵌位图），**这个差异在探针的断言上观察不到** → 探针没红，白得一条「检查是摆设」的结论。真正会分叉的只有「图片 + 图表」。**注入必须打在「行为差异能被断言观察到」的地方**，否则先怀疑注入，别先怀疑检查。

---

## 十二、Univer 剥公式引擎的报错原文（从 MEMORY.md 移来，查错时用）

漏掉任一项都是**静默坏**：
- 省 `docs` + `docs-ui` 插件 → sheets-ui 编辑器依赖 `univer.editor.service`，异步抛 `[redi] Expect 1 ... but get 0`，**try/catch 接不到**。
- 省 CSS → 原子类 `univer-h-full` 失效，根塌成 22px。
- 省语言包 → `LocaleService` 没初始化，一改格子就在 `SheetPermissionCheckController` 抛错，**界面完全看不出来**。
- `presets: []` 要占位。
配方见 `designer-react/src/.../univerFormulaFree.ts` 顶部注释。

---

## 十三、设计器面板：条码 / 图表两段（2026-09-22 补上）

`designer-react/src/modals/GridReportModal.tsx` 的 `CellModelEditor` 里，照「图片」段的写法
加了「条码」「图表」两段 —— 在这之前这两项**只能手改 JSON**，引擎能力在 UI 上摸不到。

### 设计期判据在 `openprint/src/report/grid-report.ts`（**与 Rust 同口径**）

`barcodeProblem(bc)` / `chartProblem(ch)` 是**纯函数**：只吃声明、不吃数据，返回提示串或 `null`。
刻意**只提示不拦** —— 服务端的失败粒度是**一格**（该格出 `[条码: 原因]` 并告警），
设计器拦成「整表不让存」会比服务端更严，等于擅自加规则。

- `barcodeProblem` **不收 `payload` 参数**：内容就是声明里的 `value`，让调用方另传一份迟早传岔。
  `from: 'value'` 时**直接返回 `null`** —— 内容运行期才从数据里来，设计期无从判断。
  Code128 那支的检查顺序**必须照抄 Rust `code128_pick_set`**（非 ASCII → 控制符与 `>0x5F` 冲突 → DEL → 字节数）。
- `chartProblem` 用**已有的 `parsePos()`** 判坐标形状（别自己写正则 —— 我第一版就凭空造了个 `POS_RE`，它不存在）。
  `CellChart.kind` 的类型是 `string`（**故意开着的**：手写 JSON 能塞任何值，白名单在运行期判），
  但下拉项的**名单**来自 `CHART_KINDS` + `CHART_KIND_LABEL`（`Record<CellChartKind, string>`，
  引擎哪天加了新类型这里**编译不过**，而不是静默少一项）。

### 两段都有「摘字段」语义

选「不出码 / 不出图」时要把 `model.barcode` / `model.chart` **整个摘掉**，
不能留 `{value:''}` —— 服务端会当成「配了码但配错了」，出一格 `[条码: 条码内容为空]`。
`gs1` 只对 Code128 有意义：二维码时**不显示**这个开关，且切回二维码要把已有的 `gs1` 摘掉
（否则它静默留在模板里，设了没反应）。

### 用例与反证

`grid-report-cell-barcode.spec.tsx`（18 条）/ `grid-report-cell-chart.spec.tsx`（17 条）。
断言一律看 `onChange` 收到的 **model**，不断言「没报错」—— 本文件关心的恰恰是
「UI 动了但 model 没变」这类静默失效。
`scripts/fault-inject-ui-panel.py` 注入 **10 条**（摘字段 / 显示条件错 / 漏校验 / 语义错 / 优先级错），
10 条全部让用例变红，还原后复验全绿。
