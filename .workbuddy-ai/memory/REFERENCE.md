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

---

## 十四、条件格式 `CellModel.conditional`（2026-09-22 补上）

「数值超标标红」。**核心洞察：不需要任何新渲染代码** —— `CellStyle` 的链路
（`CellModel.style` → `CellInst.style` → `GridCell.style` → xlsx `with_style()`）本来就通，
条件格式只是在**展开期**决定「这一格用哪份样式」塞进同一个槽。
证据：本次改动 **`xlsx.rs` 0 行**。别去开平行渲染通道。

### 声明与语义（每条都是刻意选的）

- 挂在 **`CellModel`** 上（不像 image/chart/barcode 两个槽都认）：它比的是**本格算出来的值**，
  而值只可能来自 `model`（`field` / `value_expr` / `agg`）—— 与同样只挂 model 的
  `style` / `format` / `format_expr` 一致。
- `when` 是 **`String` 不是 enum**：enum 会让 serde 在**解析整份模板**时就失败，
  作者错一个词整张表都出不来；字符串只坏这一条规则（进 `warnings`）。
  与 `CellChart::kind` / `NumFmt::kind` 同一套约定。
- **自上而下，第一条命中的生效** —— 顺序是语义的一部分，设计器显示序号并支持上下移动。
- **空样式的规则在编译期被丢掉 + 告警**：判定是「第一条命中生效」，
  留一条命中却什么也不改的规则会把**后面**真正想生效的规则挡掉，比报错难查得多。
- **非数值一条都不命中**：比较的是 `as_number(inst.value)`（数字格 = `raw_number`；
  `"1,234.5"` 这种文本数值也认）。空值 / 布尔 / 认不出数字的文本 → 全部不命中。
  硬把文本猜成数字会引入「`-` 当 0 用」这类静默错误，而报表里「空着」和「就是 0」是两回事。
  **这是刻意选的语义，不是漏判。**
- `between` 是**闭区间**；上下界写反 → 告警并**自动交换**（否则区间恒空 =
  「规则看着配了、导出后什么都没变」，正是最难查的那类）。
- 命中后是**逐字段覆盖**（`merged_over`），不是整格替换 —— 否则会把作者设的粗体 / 对齐一起抹掉。
- **没有边框**：与 `CellStyle` 同一个理由（Univer 的 `bd` 实测完全不渲染）。
  条件格式最经典的「超标加红框」在这里必须换成底色 / 字色。

### 关键实现点

- 规则按 `(模板行, 模板列)` 索引，**不按 `pos`**：`pos` 可以手写、可以重复，
  而实例的 `tpl_row` / `tpl_col` 精确指向哪一个模板格（`compile_sheet_conditionals`）。
- 告警**每格一次**，不是每行一次。
- 编译函数 `compile_conditionals` 是 `pub` 的，单测直接打它（不必绕整个引擎）。

### 曾经「只在 xlsx 里看得见」—— 2026-09-22 已修（见 §十五）

改之前：全项目**唯一**读 `GridCell.style` 的生产代码是 `xlsx.rs:565`，
`to_html` 完全不消费它 → 条件格式**在 HTML 预览里看不到**，只在导出的 xlsx 里出现。
这不是条件格式引入的 —— `CellStyle` 从做出来那天起就只对 xlsx 生效。
**教训（留着）：「某字段有人写」≠「有人读」**；判断链路通不通要**从产出物往回查消费点**。

### 探针 / 反证

- `scripts/verify-xlsx-conditional.py`：从 **xlsx 产物**验（样式只在导出物里可见，
  所以必须拆包读 `styles.xml`，不能只断言「没报错」）。
- `scripts/fault-inject-conditional.py`：**15 条**（9 条产品注入 + 4 条 UI + 2 条探针自身），
  15/15 让检查变红，还原后复验全绿。

## 十五、HTML 预览画作者样式（2026-09-22 补上，任务 #74）

改之前：`GridCell.style` 的**唯一**生产消费者是 `xlsx.rs:565`，`to_html` 不读它 →
`CellStyle`（以及刚做完的条件格式）在预览里全看不到，只在导出的 xlsx 里出现。
现在：`mod.rs::html_style_attr()` 把它渲染成 `<td style="…">`。

### 字段映射（**顺序即契约**）

`font-weight:bold` · `font-style:italic` · `font-size:{n}pt` · `color` · `background-color`
· `text-align` · `vertical-align`，用 `;` 连接。顺序 = `css.push` 的顺序。
字号不用特意处理整数：Rust 对 `f64` 的 `Display` 取「最短可往返表示」，
`format!("{}", 12.0f64)` 就是 `"12"`（实测）—— 曾写过一个 `fract() == 0.0` 的分支，
注入驱动证明它是**等价死分支**，已删。

### 三条刻意选的口径

1. **`Some(false)` 不写 `font-weight:normal`**。xlsx 侧 `with_style` 只在 `Some(true)` 时
   才 `set_bold()` —— `Some(false)` 是**不表态**（保持基础格式），不是「显式不加粗」。
   这里多写一条 `normal`，同一份模板在预览与导出里就会长得不一样。
   **后果**：`bold: Some(false)` 单独一项时 `CellStyle` 非空却产不出任何 CSS 字段 →
   必须返回**空串**（整格不带 `style=`），不能吐 `style=""`。
2. **`to_html` 现在是 `Result<String, String>`**（原来返回 `String`）。颜色 / 字号在这里
   校验，**文案与 `xlsx::with_style` 逐字一致**（`格子 C2 的 style.color「red」不是 #RRGGBB`）。
   静默丢样式 = 作者改半天看不到变化，比报错难查。
   → **行为变化**：以前预览对坏颜色**不校验、照样 200**（样式被忽略），现在**报错**。
   这不新增失败面（同一模板本来就导不出 xlsx），但**错误出现的时刻提前了**。
3. **比 Univer 多画粗体 / 斜体 / 字号 / 对齐** —— 这是**能力**差别不是口径分叉：
   Univer 只画底色 + 字色，HTML 没这个限制。同一份 `CellStyle` 两边能画的都画。

### 无样式时输出**逐字节不变**

`html_style_attr` 返回空串时 `<td>` 就是 `<td rowspan="1" colspan="1">…</td>`，
与加这个功能之前一模一样（探针第四节专守这条）。

### 分页那条路也走 `to_html`

`pages_html` 是**另一次** `to_html` 调用（逐页）。任何一页样式非法都整体报错 ——
否则会出现「预览报错、分页 HTML 悄悄少样式」这种半截结果。
**既有单测只断言 `pages_html` 里有 `<table`**，抓不住「分页丢样式」→ 靠探针守。

### 副作用：`/api/report/xlsx` 对坏样式的状态码 **500 → 400**（本次改动引入）

同一份模板（`color: "red"`）实测：

| 端点 | 改动前 | 改动后 |
| --- | --- | --- |
| `POST /api/report/render` | 200（样式被静默丢掉） | **400** `格子 C2 的 style.color「red」不是 #RRGGBB` |
| `POST /api/report/xlsx` | **500** | **400**（同一句文案） |

**为什么 xlsx 也变了**：`to_html` 现在会校验，而它在 **`render()` 内部**被调用
（`mod.rs:192`）；`xlsx_handler` 先 `render_with_sources(...)` 再 `to_xlsx(...)`。
于是错误在**更早的一步**就冒出来，被 handler 映射成 `BAD_REQUEST`。
改动前 `to_html` 返回 `String`、不可能失败，所以坏样式一路走到 `to_xlsx` 里的
`with_style()` 才炸，那时只剩 `INTERNAL_SERVER_ERROR` 一个出口。

**评价**：不是回归（还是报错、文案一字不差），而且**更正确** —— 作者写错颜色本来就该是
400 而不是 500；顺带把两个端点统一了。副作用是 `to_xlsx` 里那条样式校验的 500 出口
**变成不可达**（所有样式都已在 render 期验过）。没有任何测试钉住旧状态码（453 条全绿）。

### 探针 / 反证

- `scripts/verify-html-style.py`：真起服务 POST `/api/report/render`，七节 ——
  样式落到正确的格（含**不串格**、**带 style 的标签只有 td/table**）· 条件格式可见 ·
  分页也有 · 无样式逐字节不变 · 与转义共存 · `Some(false)`/`middle` 枚举 · 坏样式 400 点名。
- `scripts/fault-inject-html-style.py`：**14 条**注入，跑**两道门禁**（单测 + 探针）并打印矩阵。
  `--check-anchors` 秒级校验锚点唯一 —— 必须带上函数签名，因为
  `.map(Json)` + `.map_err(|e| (StatusCode::BAD_REQUEST, e))` 在 `mod.rs` 里有 **3 处**。
- **两道门禁覆盖的不是同一批 bug**：`status-500` / `pages-drop-style` **只有探针能抓**
  （单测直接调 `to_html`，看不见 HTTP 状态码与分页接线）→ 这就是「探针不是摆设」的证据。
  反过来 `always-attr` / `bold-normal` / `valign-middle` 一开始**只有单测能抓**，
  补了探针的「六、样式枚举」之后才两道都红。**矩阵本身是结论**，不是过程记录。

## 十六、报表页面设置（纸张 / 方向 / 页边距 / 页码 / 居中，2026-09-23 补上）

**改之前报表路径完全没有这些东西**：`paper` / `orientation` 只存在于
`print_job.rs` 的 `PrintJob`（那是**画布**路径），报表 HTML 只能听浏览器默认纸张。

### 先决约束：页码**只能**服务端烤进 HTML（动手前先确认这条）

`print_job.rs:261-266` 的 PDF 走 Chrome/Edge `--headless=new --print-to-pdf`。
**这个 CLI 吐不出页眉页脚页码**（只有 CDP 的 `Page.printToPDF` 能），
而且 Chrome **完全不支持** CSS `@page` 的 margin box。
→ 所以页码是服务端写进 HTML 的内容；xlsx 侧相反，用的是 Excel **原生页脚**。

### 数据结构

`PageConfig` 原有 3 个分页字段（`rows_per_page` / `repeat_header_rows` /
`repeat_footer_rows`），本轮加 5 个页面设置字段，**全是 `Option` + `serde(default)`**
（老模板照样能解析，有单测 `old_template_json_without_page_setup_still_parses`）：

`paper` · `orientation` · `margin_mm` · `page_number` · `center_horizontally`

### ⚠️ `page.is_some()` ≠ 开了分页（本轮最贵的一条）

页面设置和分页**挂在同一个 `PageConfig` 上**，所以 `page` 变成 `Some` 有**两个原因**。
凡是按 `page.is_some()` 分支的地方，都要改问「**真开分页了吗**」（`rows_per_page > 0`）。
本轮**踩了两次**：

1. `xlsx_handler` 里取 `repeat_header_rows.max(1)` → 只配纸张（`repeat_header_rows` 是 0）
   就把「预览 2 行表头」**静默变成「导出 1 行」** —— 正是那段代码当初要修的 bug。
   抽成 `mod.rs::xlsx_header_rows()` 并加 `.filter(|p| p.rows_per_page > 0)`，
   两个 xlsx handler 都套。
2. `paginate` 在「没真分页」时**原样返回 1 页**，于是代码在长表上印
   **「第 1 / 1 页」**。这是**错的**，比不印更坏（作者会照着错页码去找第 3 页）。
   判据是 `cfg.is_effective(rows.len())`（服务端到底切没切页），
   把 `effective` 透到 `pages_html`，不真分页时传 `page_no: None`（= 承认不知道）。

### HTML 侧：`@page` **只吐作者明写的项**

```rust
if setup.paper.is_some() { decls.push(format!("size:{:.2}mm {:.2}mm", w, h)); }
else if setup.landscape { decls.push("size:landscape".into()); }   // 没写纸张就别钉成 A4
if let Some(m) = setup.margin_mm { decls.push(format!("margin:{}mm {}mm {}mm {}mm", m.top, m.right, m.bottom, m.left)); }
```
**CSS 顺序是 `top right bottom left`**，而 xlsx 的 `set_margins` 是
`left right top bottom` —— 两边顺序不同，写反了只有打印出来才知道。

**页边距是 `Option<PageMargins>`，不填 `DEFAULT_MARGINS`**：
`DEFAULT_MARGINS`（Excel 的 19.05 / 17.78 mm）**只是一份布局假设**，
唯一用途是算页码落在可印区哪里（`body_mm = height_mm - top - bottom`）。
作者没写就两端各用各的默认（浏览器 ≈10mm / Excel 19.05·17.78），
**谁都没冒充作者做选择**。填上它就等于「只配了页码」也顺手把边距钉死了。

### xlsx 侧：`rust_xlsxwriter 0.99.0` 的四个坑（都是读它源码确认的，别凭记忆）

| 坑 | 事实 |
| --- | --- |
| `set_paper_size(u8)` | 收的是 **Excel 数字码**，不是名字 |
| `set_margins(l, r, t, b, header, footer)` | **6 个参数**，单位**英寸**（Excel 默认 0.7/0.7/0.75/0.75/0.3/0.3） |
| `set_footer(s)` | 超过 **255 字符静默丢弃**（`eprintln!` 后 `return self`）→ 已在上游拦成 400 |
| `<pageMargins>` | **无条件写出** → 不调 `set_margins` 与「调它 + Excel 默认值」**逐字节相同** |

纸张码实测表：`1`=Letter · `5`=Legal · `8`=A3 · `9`=A4 · `11`=A5 · **`13`=B5（JIS 182×257）**。
`set_portrait()` 是**空操作**（`write_page_setup` 本来就会写 `orientation`），只在横向时调 `set_landscape()`。

页脚码：`{page}`→`&P`、`{pages}`→`&N`、居中段 `&C`、**字面量 `&` 要翻倍成 `&&`**。
**转义必须在替换之前** —— 反了的话刚写进去的 `&P` 会被翻成 `&&P`，
页脚印出字面量「&P」而**一点报错都没有**。

实际落盘的 XML（拆包读出来的，不是猜的）：
```xml
<pageMargins left="0.2362204724409449" right="0.31496062992125984" top="0.3937007874015748" bottom="0.4724408818897638" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" fitToHeight="0" orientation="landscape" horizontalDpi="200" verticalDpi="200"/>
<oddFooter>&amp;CA&amp;&amp;B 第 &amp;P / &amp;N 页</oddFooter>
<printOptions horizontalCentered="1"/>
```
（`<pageSetup>` 里没有 `fitToWidth` —— `1` 是 XML 默认值，被省略了。）

### B5 = **JIS 182×257**，不是 ISO 176×250（别再当 typo 改回去）

B5 有两个互不相同的标准：ISO = 176×250、JIS = 182×257，而 Excel 纸张码 13
（界面上就写「B5」）是 **JIS** 那个。按 ISO 尺寸去配码 34（Excel 里叫「Envelope B5」）
会出现「HTML 按 176×250 排版、Excel 按 182×257 出纸」的静默不一致。
→ 取 JIS，与 Excel 同口径；**ISO B5 本项目不支持**。
`paper_table_is_pinned` 把整张表钉死，失败文案里写明这是**口径变更**而不是笔误。

### 两条跨端（TS ↔ Rust）契约

1. **纸张名大小写不敏感**：服务端 `paper_mm` / `paper_excel_id` 都是
   `n.eq_ignore_ascii_case(name.trim())`。设计器的预检 `pageSetupProblem`
   原来按大小写敏感比对 → `"a4"` 会被设计器拦下、服务端照样编得出来 = **误报**，
   正是这套预检唯一不该犯的错。现已两边一致，并由探针
   `case_paper_name_is_case_insensitive` 做实物证据。
2. **方向只 trim、不忽略大小写**：服务端 match 的是字面量 `"portrait"` / `"landscape"`，
   `"Landscape"` **会被拒**。这个**不对称**是有意的，别「顺手」放宽 —— 放宽就是
   「设计器放行、服务端 400」。

`pageSetupProblem` **刻意是服务端校验的子集**（「页边距吃掉整张纸」要拿纸张 mm 表才能算，
而那张表只在 Rust 里；在这儿复制一份就是第二个真相源）。
子集只会漏报、不会误报 —— 但**这个保证有前提**：凡在这里判的东西，判据必须与服务端逐字一致。

### 存盘路径：页面设置**不是开关，是模板内容**

`ReportOptions` 里**没有**纸张 / 页码这几个字段（只有分页三项），所以页面设置
必须进 `rawTemplate` 才存得住。而 `withPage` 跑在 `rawTemplate` 快照**之后**
→ 光靠它页面设置**永远到不了存盘文件**。
症状：存了 A3 → 重开显示「不指定」→ 再保存**真把纸张抹掉了**，每一步都不报错。
→ 新增 `withPageSetup`（**只写页面设置**、`rows_per_page` 固定 0），在快照**之前**调用；
`withPage` 保留 0→1 兜底（有既有用例钉着），**只在真开分页时**套。
`GridReportModal` 打开报表时从 `def.template.sheets[0].page` 回填这五项。

### 探针 / 反证（`verify-report-paper.py` 12 节 + `fault-inject-report-paper.py` 16 条）

四道闸：**Rust 单测** · **真机探针**（拆 zip 读 XML）· **TS 引擎**（`ts-test.sh`）·
**TS 设计器**（designer-react 的 `grid-report-request.spec.ts`）。
矩阵会打印「哪道闸抓到的」：

- `set_margins` 参数顺序 / 英寸换算 / 页脚漏 `&C` → **只有探针**（xlsx 内容 deflate 过，单测读不到）
- 页码扁平下标 → **只有单测**（探针那份是单 sheet，看不出来）
- 设计器预检大小写 / 页面设置不进 `rawTemplate` → **只有对应的 TS 闸**

**矩阵真正的用处是暴露「哪道闸是漏的」**：第一次跑完 #13 只被单测抓到。
查下去发现**重复表头（`_xlnm.Print_Titles`）写在 `xl/workbook.xml` 的 `definedNames` 里、
不在 `sheetN.xml`** —— 探针原来只读 sheet XML，**根本验不到**。
补了 `xlsx_workbook()` + `case_page_setup_does_not_drop_repeat_rows` 之后才两道都红。
**「只单测红」要当漏网处理，别当成正常分工。**

### 顺带：前端「真闸」要**用本仓自带的 tsc**（`scripts/ts-project-check.sh`）

借的那份（`admin/demo/web/node_modules/typescript`）**已漂到 6.0.3**，而 TS 6 把
`baseUrl` 判为 deprecated → 整条 `tsc -p` 被一个**与代码无关的配置错误**堵死：
`tsconfig.json(17,5): error TS5101 ... baseUrl is deprecated`（**真实退出码 2**）。
看着像代码类型错了，其实一行都没错。本项目 `package.json` 钉的是 `^5.9.3`，用它跑 **exit 0**。
脚本优先用 `<目标>/node_modules/typescript/bin/tsc`，并**拒绝**解决方案式配置
（`openprint/tsconfig.json` 是 `"files": []` + references，`tsc -p` 对它**什么都不检查却报 OK**
= 假绿；openprint 的真闸是 `vue-tsc --build`）。

## 十七、`openprint` 的类型闸：`vue-tsc --build`（2026-09-23 清零，116 → 0）

### 三条闸的分工（别混）

| 闸 | 覆盖面 | 用法 |
| --- | --- | --- |
| `scripts/ts-check.sh` | `--noResolve` 逐文件查**本文件自己**；跨文件错结构上看不见 | 快，改完随手跑 |
| `scripts/ts-project-check.sh` | `tsc -p` 全项目（别名 / JSX / 跨文件） | **designer-react** 用这个 |
| `scripts/ts-project-check.sh openprint` | 检测到解决方案式配置 → 自动转 **`vue-tsc --build --force`** | **openprint** 用这个 |

`openprint/tsconfig.json` 是**解决方案式**（`"files": []` + `references`）→
`tsc -p` 对它**一个文件都不检查**却打印 OK。**别信那个 OK。**
脚本在 2026-09-23 之前是「检测到就 exit 2 拒跑」，后果是 openprint 没有能一键跑的闸
→ 现改成自动转 `vue-tsc`，并挂上沙箱必需的 preload
（`vite-safe-delete-bypass.cjs` + `broker-mkdir-throttle.cjs`）。

### 为什么必须保持绿的

`noUncheckedIndexedAccess`（来自 `@vue/tsconfig`）下 `g[1][0]` 是
`CellTpl | undefined`。这 108 条错**长期红着**，于是新错误混在里面看不出来
—— **一条长期红着的闸等于没有闸**。清零后每次改动都要能一键复验。

### 批量修 `noUncheckedIndexedAccess` 报错的做法（可复用）

**别手改**，从 `vue-tsc --pretty` 的波浪线取精确 span 再插 `!`：

```sh
cd openprint && NODE_OPTIONS="--require <repo>/scripts/vite-safe-delete-bypass.cjs \
  --require <repo>/scripts/broker-mkdir-throttle.cjs" \
  node node_modules/.bin/vue-tsc --build --force --pretty > /tmp/p.txt
```

⚠️ **`--pretty` 输出带 ANSI 色码**：`grep 'error TS' /tmp/p.txt` **一个数都匹配不到**
（第 N 次踩「grep 说没有 → 先怀疑 grep」）。先
`re.sub(r'\x1b\[[0-9;]*m', '', raw)` 再解析。

解析规则：错误头 `^src/...:(\d+):(\d+) - error (TS\d+):` → 往下找第一个以
`^\d+ ` 开头的**源码行** → 它**下一行**的波浪线给出 `(起始列, 长度)`。
**波浪线的缩进里包含了 pretty 加的「行号 + 空格」前缀**，插点要减掉
`len(str(行号)) + 1`。同一行多个插点**从右往左插**。

**两个必踩的坑**（自动改错，得手工收口）：
1. **span 跨行** → `!` 被插到第一行行尾，类型没修好（如 `(... )!` 换行
   `.sheets.sheet1.mergeData`）。正确位置是 `.sheets.sheet1!`。
2. **`!` 落到类型位置** → `(x): x is string` 被插成 `x is string!` → **TS17019**。
   `!` 只在**表达式**里是断言。

### 证明「改了但没改行为」

比「测试通过」更硬的一条：`!` 编译期擦除、不产生代码，所以只要证明
**diff 的全部内容就是插入的 `!`** 即可：

```python
old = subprocess.run(['git','show','HEAD:'+path], ...).stdout
new = open(path).read()
assert old.replace('!','') == new.replace('!','')   # 逐字节相同
```

再用 `difflib.SequenceMatcher` 逐行核对，唯一允许「不只是加了 `!`」的是手工改动处。

### 闸本身要有牙齿

写完闸先证明它会红：往 `grid-report.ts` 末尾追加
`const __probe: number = "not a number"` → 脚本退出 **2** 报 TS2322；还原 → 退出 **0**。

### 其它

- `!` 能表达的：正则捕获组在 `.exec()` 成功后必然存在（TS 表达不了，只能 `!`，
  注释要写清「为什么必然存在」）。
- TS2677（谓词类型不是参数类型的子类型）：`filter` 回调参数被推导成**字面量联合**
  时，`(x): x is string` 不成立 → 参数显式写 `unknown`。

## 十八、Word 导出 `/api/report/docx`（2026-09-23 补上，差距分析 B6）

### 核心难点：docx 的失败是**全有全无**

Word 遇到结构错（`[Content_Types].xml` 漏声明一个 part、`<w:pPr>` 写在 `<w:r>` 之后、
XML 1.0 非法控制字符）不是「版式差一点」，而是**整个文件打不开**（"unreadable content"）。
而这类错**Rust 单测完全看不见** —— 单测只能断言「写了 N 字节 / 含某个子串」，
真正会拒绝它的是**另一个程序**。

**本机没有 docx oracle**：没装 Word / LibreOffice / WPS（只有 Pages），
`python-docx` 也一开始没有。所以「Word 能不能打开」**本机验不了，不许声称**。

### 用四条**可判定**不变量替代 oracle

| # | 不变量 | 谁来验 |
| --- | --- | --- |
| 1 | 每个 part 都是**良构 XML** | `verify-docx.py` |
| 2 | 每个 part 都在 `[Content_Types].xml` 里声明 | 同上 |
| 3 | 每个 `r:id` 关系都指向**存在的** part（无悬空） | 同上 |
| 4 | 子元素顺序符合 ECMA-376 的 `CT_*` 内容模型 | 同上 |

顺序表**从 `python-docx` 的 `_tag_seq` 抽**（`scripts/docx-order-table.py`），
不是凭记忆写 —— 本项目的记忆式断言**已经被证伪过**（`png.rs`/`barcode.rs` 的 MSRV 假理由）。
python-docx 是**独立来源但不是权威**，手写的条目在输出 JSON 里**明确标注**。

⚠️ **`python-docx` 不能当主 oracle**：它按标签名找元素、**不检查顺序**，
而顺序恰恰是 Word 敏感的东西。它的价值只在于提供**规范衍生的顺序表**。

`docx-order-table.py` **缺 python-docx 就 exit 2**，绝不静默退化成空表。

### zip：只写 method 0（不压缩）

ZIP 允许**存储式条目**（method 0）→ 不需要 deflate 编码器，~120 行够用
（本地头 + 数据 + 中央目录 + EOCD）。代价：文件大 ~5×，这个量级无所谓。

- **CRC-32 与 PNG 块尾是同一条多项式**（CRC-32/ISO-HDLC）→ 从 `png.rs` 提到 `zip.rs`
  共用一份（各写一遍迟早不一致）。已用**两个独立实现**验过 zip：
  Python `zipfile.testzip()` → `None`、BSD `unzip -t` → "No errors detected"。
- **时间戳写死 2020-01-01**（`DOS_DATE`/`DOS_TIME`）：不取当前时间，否则同一份报表
  每次导出字节都不同，探针没法做逐字节比对。`output_is_deterministic` 钉住这条。

### 内容侧四条硬约束

1. **XML 1.0 表示不了 0x00 / 0x0C**（XML 1.1 的 `&#x1;` Word 不认）→ 只能**丢掉**，
   是**刻意的数据丢失**，换「文件能打开」。`is_xml_char()` 就是 Char 产生式。
2. **`w:t` 不认 `\n`** → 换行必须变 `<w:br/>`。
3. **合并语义按轴不同**：
   - 横向（`colspan`）→ 被盖的格**不输出**，由 `gridSpan` 吸收；
   - 纵向（`rowspan`）→ 被盖的格**必须照样输出**成空的 `<w:vMerge/>` 续格，
     否则**整列错位**。
4. **被合并盖住的格，各导出格式都丢掉**：样例模板 `城市小计` 在 r4c1，
   落在 `上海`（rowspan 3）的合并里 —— `/api/report/render` 返回它，
   **xlsx 与 docx 导出都丢**（xlsx 那格是空的 `<c r="B5" s="3"/>`）。
   这不是我定的，是既有跨格式语义，已用 `case_covered_cells_are_dropped_like_xlsx_does` 钉住。

### 单位锚点

**Word 自己的 A4 = 11906 × 16838 twips**（不是我按 mm 四舍五入的 11907 × 16840）。
1 inch = 1440 twips；1 mm = 56.6929 twips。测试以 Word 的值为准。

### 故障注入挖出**两个假绿**（本节最值钱的部分）

第一轮 14 条注入，**5 条没被抓到**，其中 **2 条是真·探针 bug**：

1. **子元素顺序检查是死代码**。`check_child_order` 写成「元素没有 `CT_*` 模型就 return」
   —— 而根节点 `w:document` 本来就没有模型，于是**整棵树被剪掉**。
   这条检查**从来没跑过**，却一直是绿的。
   → 修法：**没有模型也要继续递归**。修完注入 #3/#4 立刻变红。
2. **part 闭合检查太宽**。只要求「有 Default 或 Override 兜住」，而
   `Default Extension="xml"` **能兜住一切 XML** —— 删掉主文档的 `Override` 也照样绿。
   → 修法：显式断言 `Override[@PartName='/word/document.xml']` 且
   ContentType 是 `...document.main+xml`（`Default Extension` 表达不了「这是主文档」）。

另外 3 条是**锚点没匹配上**（Rust 源码的 `\"` 转义、缩进写错）——
**锚点匹配 0 次会伪装成「闸没抓到」**。所以注入脚本**先报告每条锚点匹配几次**，
必须恰好 1 次，否则当场算 miss。

最终矩阵：**14/14 全抓到**。分布 —— 只有探针能抓 4 条（悬空 `r:id`、顺序 ×2、格子文本错）、
只有单测能抓 7 条、两边都能抓 3 条。

### 探针自身的两处判据错（也是我写的）

1. **数 `tc` 个数 ≠ 占的列数**：标题行是一个 `gridSpan=4` 的 tc，一个人占 4 列。
   → 列数判据要**累加 gridSpan**。
2. **合并盖住的格不算「可见文本」** → `visible_texts()` 要排除（见上面第 4 条）。

### 验证入口与数字

```sh
cargo test --bin print-server -- report::docx      # ⚠️ 是 --bin 不是 --lib（print-server 是二进制 crate）
python3 scripts/verify-docx.py                     # 12 条，需服务端在 18888
python3 scripts/fault-inject-docx.py               # 14 条注入 × 2 道闸
```

- Rust 全量 **510 passed / 0 failed / 14 ignored**（+21：zip 6 / docx 15）。
- 探针 **12/12**；注入矩阵 **14/14**；还原后基线复绿。
- `crc32` 搬家后复跑 `verify-barcode` / `verify-xlsx-barcode` / `verify-xlsx-image` /
  `verify-report-paper` 全 OK（无回归）。

### 明确的覆盖缺口（每次都要说）

**「真 Word 能打开」本机未验证。** 只验了四条可判定不变量 + 内容回读。

### v1 刻意不做

`styles.xml` / 具名样式 · 毫米级列宽（现交给 Word 自动适配）· docx 页眉页脚页码 ·
docx 里的图片 / 图表 / 条码 · `.docx` 导入。

## 十九、内联数据集 / 数据文件导入（2026-09-23 起，C 类）

### 通路：**早就通着**，别重复造

| 环节 | 位置 |
| --- | --- |
| 请求体 | `RenderRequest.datasets: Option<BTreeMap<String, DataSet>>`（`mod.rs:40`） |
| 合并 | `render()` 里 `tpl.datasets.extend(ds)`（`mod.rs:114`）—— **`sources` 为空也能渲染** |
| 类型 | `DataRow = BTreeMap<String, JsonValue>`、`DataSet = Vec<DataRow>`（`model.rs:13`） |
| 存盘 | `ReportTemplate.datasets` 被 `store.rs` **原样存进报表文件**（离线/演示报表用） |
| 前端类型 | `RenderRequest.datasets?: Record<string, Record<string, unknown>[]>` |

**所以「文件数据集」的 80% 是前端纯函数**（`openprint/src/report/dataset-import.ts`），
一行 Rust 都不用改。差距分析里写它「最贵」是指**全量**（含 API / 存储过程等）。

### ⚠️ 字符串数字：**合计是对的，导出是错的**（最容易静默的一条）

服务端有**两条**数值通路，口径不同：

| 通路 | 位置 | 对 `Val::Str("42")` / `JsonValue::String("42")` |
| --- | --- | --- |
| 聚合求值 | `Val::as_num()`，`engine.rs:487` | `s.trim().parse::<f64>()` → **当 42** |
| 显示 / 导出 | `display()`，`engine.rs:3545` | `(s.clone(), None)` → **`raw_number: None`** |

而 `xlsx.rs:623` 是
`if let Some(n) = cell.raw_number { write_number } else { write_string }`。

→ **后果**：一份全是字符串的数据集，**求和 / 平均完全正确、预览也正常**，
但导出的 xlsx 里那些数字是**文本格**（不右对齐、不进 Excel 算术、不按数值排序）。
**只有打开导出的文件才看得出来。**

→ **修法**：无类型来源（CSV / xlsx）把数字转成真数字。
判据是**往返一致** `String(Number(t)) === t`，一次挡掉改坏数据的情况：

| 原串 | 转? | 理由 |
| --- | --- | --- |
| `42` `-5` `3.5` `13800138000` | 转 | 无损（f64 < 2^53 精确） |
| `007` | 不转 | 丢前导零（工号 / 邮编） |
| `3.50` | 不转 | 会显示成 `3.5`，改掉作者写法 |
| `+86` | 不转 | 丢 `+`（手机号） |
| 20 位整数 | 不转 | f64 丢精度，往返不一致 |
| `1e5` `.5` `1.` `1,234` | 不转 | 正则只认普通十进制 |

**JSON 不推断** —— 它自带类型，作者写 `"42"` 就是要字符串。有类型的来源去猜是越权。

### 解析层要拦的静默失败

1. **列名重名** → Rust 侧 `BTreeMap` 会**互相覆盖**，后一列静默吃掉前一列 → 加后缀去重。
2. **表头整行空白** → 多半是**文件根本没有表头行**，照常处理会把**第一条数据吃掉**
   （列名变成 `1`/`2`），少一行看不出来 → **报错**。
   （注意：列名**是数字**时判定不了，这条只拦「整行空白」这个明确信号。）
3. **行列数不匹配** → 不静默截断也不静默补空，**报错并给出行号**。
4. **认不出的扩展名 / JSON 里有多个数组字段** → 报错让人选，不猜格式。

### `scripts/ts-test.sh` 的假绿（已修，别再写死）

`FILES` 与 vitest `include` 原先都**写死**成 `grid-report` → 新增 spec
**根本不会被跑到，而退出码仍是 0**。现为「整目录拷 + `*.spec.ts` 通配」。
**判据：测试跑器输出里的文件数 / 用例数要和实际文件对得上**，
只看到「0 failed」不算数。

### xlsx 通路：`raw: false` 对报表是**静默错**（实测 SheetJS 0.18.5）

`parseWorkbookFile()` 用 `raw: true` + `cellDates: true` + **`header: 1`**（要矩阵）。

| 单元格 | `raw: false` | `raw: true` + `cellDates` |
| --- | --- | --- |
| 套了货币格式 `"¥"#,##0.00` 的 1234.5 | `"¥1,234.50"` **字符串** | `1234.5` 数字 |
| 日期格 2024-01-02 | `"1/2/24"`（随 locale 变） | `Date` → `2024-01-02` |
| 文本格 `007` | `"007"` | `"007"` |

- 货币那一行**比普通字符串数字更重**：`"100"` 至少 `as_num()` 能 parse（合计对、只有导出错）；
  `"¥1,234.50"` 连 parse 都失败 → **合计也错**。**预览完全看不出来。**
- **刻意不改** `@/design/utils/data-import` 的 `parseDataFile`（它用 `raw: false`，
  另一个消费者「画布数据表」要的就是字符串）。两处口径不同是**有意的**。
- `header: 1` 让 `rowsFromMatrix` 的全套校验（列数不一致 / 整行空表头 / 重名列 / 空行）
  全部复用，不必为 xlsx 再写一遍。
- 日期判据：**UTC 零点才截成 `YYYY-MM-DD`**，真带时间的输出完整 ISO。
- ⚠️ **不给 `sheet_to_json` 写类型实参**：`ts-check.sh` 带 `--noResolve` →
  `XLSX` 是 `any` → 带类型实参报 **TS2347 假错**。改成返回后 `as` 断言。

### URL 取数：前端直连，**不做后端代取**

`dataset-fetch.ts`。后端代取 = 任意 URL 请求原语（SSRF），与本项目
「图片只收 data URI、不收文件路径」的既有取舍一致。代价（CORS 被挡时
只有 `TypeError: Failed to fetch`）**写进错误文案**并提示改用文件导入。

- 格式判定顺序：**URL 后缀 → `Content-Type` → 报错**（两步都认不出就报错，**不猜**）。
- ⚠️ `fileNameFromUrl` **必须用 `new URL(url).pathname`**：手写 `split('/')`
  会把**主机名**当最后一段（`http://a/` → `a`），而主机名里有点 → 后缀被认成 `com`。
  `fileExtension` 同理要**先取 basename 再找点**（否则 `/api/v1.0/data` → `0/data`）。
- 失败**一律抛错**，绝不返回空表 —— 空表与「接口真的返回 0 行」界面上分不出。

### 数据来源二选一的**三条接线**（UI 侧，最容易静默）

1. **打开报表要重置回 `db` 并清内联数据**：不清的话 `datasets` 同名时盖过 `sources`
   → 新打开的报表渲染的是**上一个文件的数据**（表头是报表的、数字是别人的）。
2. **存盘要提示「内联数据不会被保存」**：报表存的是**数据源声明**不是数据快照，
   而文件 / 接口这条没有可声明的来源 → 存出来是「无数据源」。不提示 = 静默丢数据。
3. **预览的自动刷新是 `doRender(true)`（silent）** → 数据来源的错误**只能靠界面自己的
   Alert** 显示；指望预览报错是等不到的。

**闸**：`designer-react/src/modals/grid-report-inline-source.spec.tsx`（9 条，断言请求体）+
`fault-inject-inline-ui.py`（5 条注入，守的是**接线**而不是纯函数）。

### 测 UI 时的一个帮手坑：antd `Button` 在**两个汉字**之间插空格

`保存` → `保 存`、`取数` → `取 数` → 严格相等匹配永远找不到。
（4 字的 `分组汇总` 不受影响，所以只在 2 字按钮上暴露。）
**按文字找元素一律先去空白再比。**

---

## 二十、AI 层现状与「AI-first」差距（2026-09-24 摸清）

### 1. AI 层**已经存在**（716 行），不是从 0 开始

| 文件 | 干什么 |
| --- | --- |
| `openprint/src/ai/schema.ts` | 提示词 `PROTOCOL_SUMMARY` + 2 组 few-shot（含坐标换算演算）；`buildUserPrompt` 支持三种上下文 |
| `openprint/src/ai/client.ts` | OpenAI 兼容 `/chat/completions` SSE 流式；**兜了「端点忽略 `stream:true`」**；`AiRequestError` 带 status |
| `openprint/src/ai/generate.ts` | 编排：`extractJson`（3 级回退）→ 归一化 → `validateTemplate` → **把结构化 issues 回喂模型重试 1 次** |
| `openprint/src/ai/normalize.ts` | 补 id / 坐标纠偏 / 类型白名单 |
| `openprint/src/config/ai-settings.ts` | baseURL / apiKey / model / enabled，存 `localStorage['openprint:ai:config']`（**明文**，注释自陈「仅本地单用户」） |
| `designer-react/src/modals/AiAssistantModal.tsx` | UI；三模式 新建 / 改当前 / **只改选中**；选区走 diff 应用 |
| `openprint/src/design/ai/shared/ai-assistant-logic.ts` | `diffSelectedControls`（`removedIds = lockedIds - returnedIds`）/ `resolveMode` |

**关键限制：只覆盖「自由画布」`TemplateData`。** `grep -rn 'ReportDef\|CellTpl\|expand_type\|row_parent' openprint/src/ai/` → **0 命中**。非线性报表（本项目的差异化内核）**没有任何 AI 通路**。

### 2. ⚠️ 同一份「控件类型」有**三份声明**，且已漂移（已复现）

| 声明处 | 数量 | 缺 |
| --- | --- | --- |
| `core/spec/template.schema.json`（`definitions.component.type`） | 13 | —（**权威**，与 `types/control.ts:10-23` 的 `ControlType` 一致） |
| `ai/normalize.ts:8-18` `VALID_TYPES` | 9 | `chart` `math` `signature` `labelgrid` |
| `ai/schema.ts:14` 提示词散文 | 8 | `zone` `chart` `math` `signature` `labelgrid` |

**后果（静默删用户的东西，已跑测试复现 4 failed / 2 passed）：**

`normalizeControl` 对不在白名单里的 type **返回 `null`** → 被 `.filter` 丢掉 → `diffSelectedControls` 第 66 行把它算进 `removedIds` → `AiAssistantModal.tsx:250` `s.removeControl(id)` **删掉** → 第 251 行还弹**绿色成功**「已应用到选中控件（改 0 / 加 0 / 删 1）」。

即：**选中画布上的图表控件让 AI 改配色 → 控件消失，界面说成功。**

复现脚本（`normalize.ts` 只有 `import type`，运行期零依赖，可单文件隔离跑）：

```bash
W=/tmp/ai-proof && rm -rf $W && mkdir -p $W
ln -sfn /Users/lushaohui/project/report/openprint/node_modules $W/node_modules
cp /Users/lushaohui/project/report/openprint/src/ai/normalize.ts $W/
cat > $W/proof.spec.ts <<'EOF'
import { describe, it, expect } from 'vitest'
import { normalizeTemplate } from './normalize'
const mk = (type: string) => ({ document: { page: { width: 100, height: 150 },
  sections: [{ type: 'body', components: [{ type, left: 0, top: 0, width: 40, height: 20 }] }] } })
for (const t of ['text', 'zone', 'chart', 'math', 'signature', 'labelgrid']) {
  it(`保留 ${t}`, () => {
    const body = normalizeTemplate(mk(t)).document.sections.find(s => s.type === 'body')!
    expect(body.components!.map(c => c.type)).toEqual([t])
  })
}
EOF
cd $W && node node_modules/vitest/vitest.mjs run     # → text/zone 过，chart/math/signature/labelgrid 返回 []
```

> **通用教训：一份协议有 N 处并行声明 = N 处会漂移，且漂移是静默的。**
> 解法不是「记得同步」，是**写一条断言它们互相一致的闸**（并且证明这条闸能红）。

### 3. AI 的测试不在 `scripts/` 那几条闸里（**但确实被跑到** —— 本节初版写错了，已更正）

`scripts/ts-test.sh` 只拷 `openprint/src/report/*.ts`（脚本注释自己写了「白名单就是上次漏跑新 spec 的原因」）；`grep -rn 'src/ai|ai.spec' scripts/` → **0 命中**。

> ⚠️ **初版据此写了「`ai.spec.ts` 没有任何脚本会跑」—— 错的。** 实测：
>
> ```bash
> cd designer-react && node node_modules/vitest/vitest.mjs run openprint/src/ai
> # → ✓ ../openprint/src/ai/ai.spec.ts (15 tests)   ← 确实在跑
> ```
>
> 因为 `designer-react/vite.config.ts` 的 `test.include` 里有 `../openprint/src/**/*.spec.ts`。
> **判定「某测试有没有被跑到」要读跑器的 include，不是 grep 脚本目录。**
> （顺带：`designer-react/package.json` 有 `test` / `test:app` / `test:engine` 三个脚本，
> `test:engine` 用 `vitest.engine.config.ts` 只跑引擎层。）

**§2 的 bug 能长期存活的真正原因不是「测试没跑」，而是「没有一条断言守那个不变量」** ——
8 条用例全绿，却没有任何一条问过「白名单外的类型有没有被上报」。**测试跑了 ≠ 测到了。**

### 3b. ✅ 已修（2026-09-24）：丢弃必须上报，5 层各有一条注入

用户选「让丢弃出声」而**不**拓宽白名单（理由：拓宽会让模型有机会产出它并不理解载荷的图表控件）。

| 层 | 文件 | 关键改动 |
| --- | --- | --- |
| 1 | `ai/normalize.ts` | `DroppedItem` / `NormalizeResult`；`normalizeControl(raw, dropped)` 的 `dropped` **必填**；`normalizeTemplate` → `{value, dropped}`；整节类型拼错也上报 |
| 2 | `ai/generate.ts` | `GenerateResult.dropped` **必填**；选区路径透出；整模板路径把丢弃并入 `lastIssues` → 走已有的回喂重试；重试后仍不完整则 `ok:false` |
| 3 | `design/ai/shared/ai-assistant-logic.ts` | `diffSelectedControls(controls, lockedIds, dropped)` 第 3 参**必填**（传整个 `DroppedLike[]`，不是 id 数组）；`removedIds` 排除丢弃的 id；新增 `preservedIds`、`unattributedDrops`、`droppedNotice()` |
| 4 | `designer-react/.../AiAssistantModal.tsx` | 卡片显示「AI 处理不了」；`applySelected` 保留原样 + **warning**（非 success） |
| 5 | `openprint/src/design/ai/AiAssistantPanel.vue` | 同上 —— **Vue 侧是同一个 bug 的第二处**，别只修 React |

**第 3 层里还有一个不显眼的洞，一并堵了**：丢掉的东西若**没带 id**（模型没给），
连「是哪一个」都不知道 —— 那时原控件的 id 仍会落进 `removedIds` 被删。
所以 `diffSelectedControls` 加了 `unattributedDrops`：**只要有一件丢弃认不出是哪个，本次一律不删**。
判据是**代价不对称**：少删一个控件是**看得见**的（控件还在，想删再删一次），
多删一个是**看不见**的（静默丢数据）。**保守优先于「猜对」。**

- 闸：`scripts/fault-inject-ai-dropped.py` → **6/6 抓到**，还原后逐字节一致，两个跑器基线全绿。
- **设计要点**：把「丢弃」做成**必填**参数/字段，而不是可选的回调或日志 ——
  这样「忘记处理」在**类型层面**就写不出来（`GenerateResult` 少 `dropped` 直接 TS 报错）。
  这是本项目「让静默失败变响」的通用手法：**先让忽略变得写不出来，再谈文档提醒。**
- **测试写法**：白名单内/外两条用例都由 `VALID_TYPES` **推导**（不硬编码），
  所以将来有意放宽白名单时测试自动适配；另有一条显式清单用例把这个**刻意取舍**钉成文档。
- 已知取舍：`VALID_TYPES` 仍是 9 项，所以选区里有图表控件时 AI 仍处理不了它 ——
  但现在**明确告知且不动它**，而不是删掉还说成功。

### 4. 错误响应：**两套方言**，且没有错误码

```
POST /api/report/render            → 400 text/plain 「模板中没有 sheet」
GET  /api/reports/../../etc/passwd → 404 text/plain 「报表 id 不合法（只允许字母数字、-、_，最长 80）: …」
PUT  /api/reports/save（缺 format） → 422 text/plain 「Failed to deserialize the JSON body into the target type:
                                                 missing field `format` at line 1 column 51」
```

业务错误 = 中文散文（`print-server/src/report/mod.rs` 内 20+ 处 `(StatusCode::X, e)`，`e: String`）；axum `Json` 提取器错误 = **英文 serde 散文 + 422**。**时间格式也不统一**：`/api/reports` 的 `updatedAt` 是 UTC（`…Z`），`/health` 的 `time` 是本地（`+08:00`）。

### 5. 「内层 / 外层」两种形状，端点名只差一点

- `GET /api/report/sample-template` → **内层 `template`**：`{sheets, datasets}`（7 926 B）
- `GET /api/reports/:id` / `PUT /api/reports/save` → **外层 `ReportDef`**，实测 10 键：
  `format` `version` `id` `name` `description` `updatedAt` `template` `sources` `params` `options`

**`ReportDef` 没有 JSON Schema**（唯一的 schema 描述的是自由画布）。`CellModel` 22 字段 / `CellTpl` 11 字段，形状只存在于 Rust 结构体里。

### 6. 仓库里的样例报表**开箱不可跑**

`print-server/reports/sales-by-region.json` 的 `sources[0]` 是 `{engine:"sqlite", database:"/tmp/report-demo.db", table:"sales", where:"region = ?", params:["华东"]}`，而该 db 不在仓库里：

```
POST /api/reports/sales-by-region/run → 400 「数据集「ds1」取数失败：sqlite 文件不存在: /tmp/report-demo.db」
```

### 7. 已有但「默认关 / 是散文」的自检通道（AI-first 的现成地基）

- `RenderResponse.warnings: Option<Vec<String>>`（`mod.rs:103-106`）——注释自己写着「会静默产出错误数据的可疑情况…调用方应当展示给用户」。**是散文，且 `Option`。**
- `dump=true` 返回展开轨迹（`seq | pos | 文本 <- 层次坐标 | 行父 | 列父`）——**agent 最好的自检通道，默认关。**
- `/health` 暴露 `reportsDir` / `odbc`（feature 开关）——**很好的设计，但靠调用方主动去问。**

### 8. `normalize.ts` 的坐标纠偏是启发式（会双向错）

`normalize.ts:87-104`：`minLeft≈margin.left && minTop≈margin.top` 就整体平移。
- **假阴性**：模型只错一个轴 → 不触发 → 整页偏移；
- **假阳性**：合法设计若最左控件恰在 `x=margin.left`、最上恰在 `y=margin.top` → 被无端平移。

提示词里要写加粗的「**坐标铁律**」（`ai/schema.ts:31`）本身就是「模型反复做错」的症状。

### 9. 没有工具面

`grep -rl 'mcp|modelcontextprotocol'`（排除 `node_modules`）→ **0 命中**。`main.rs:183-224` 共 **33** 条 `.route(`，全是给人/前端用的 REST。AI 层是**纯前端**、**不经 `print-server`** → 外部 agent 无法驱动本引擎。

### 10. 结论口径（对外怎么说）

**本项目已经是「AI 可验证」的，但不是「AI 可编写」的。** 可验证＝探针/故障注入/可判定不变量（这是 AI-first 的地基，多数项目没有）；不可编写＝AI 只挂在画布层，内核（`ReportDef`）对 AI 不透明，且三份协议声明已漂移。
完整差距分析与分阶段改进路线：`AI优先-差距分析与改进方案.md`。


## 二十一、架构体检（2026-09-24）

全文：`架构体检-不足与改进方案.md`（仓库根）。**只体检、没改代码。**

### 头条：**验证设施一流，「让验证设施跑起来」是缺的**

13 个 `fault-inject-*.py` + 13 个 `verify-*.py` + `mirror-check.py` = **27 个 .py**
（**体检当时**的数；现已 16 + 13 + 1 = 30），
**没有任何 shell 脚本调用过任何一个**（`grep -rnE 'python3? .*\.py|mirror' scripts/*.sh scripts/*.mjs scripts/*.cjs` → 无输出）；
**无 CI**（无 `.github`）；**无 `check-all`**。

→ 新形态，已进 `silent-failure-hunt` 的族谱：**「没有跑器的闸」比「红的闸」更坏** ——
红闸会喊；没跑器的闸是**绿的**，谁看一眼都得到「契约一致」的信心，而那份信心是空头。

### `mirror-check.py`：**两层** —— 形状 24 组 + 语义 8 条（2026-09-27 起）

> 下面这段「只对形状」是**体检当时（2026-09-26）**的判断，已**部分过时**。
> 现状：语义层已加 8 条，见本节末尾「现状」。

覆盖 24 组 struct/interface 字段 + 纸张名清单（`mirror-check.py:29-54, 152-160`）。实测 24/24 OK + 纸张名 6 项。

**当时不覆盖**的规则体/常量（注释里都写着「改一处要改两处」）：

| 事实 | Rust | TS | 闸（体检时） |
| --- | --- | --- | --- |
| 字节上限 213/48 | `barcode.rs:52,59` | `grid-report.ts:197-202` | **无** |
| 码制别名表 | `barcode.rs:186` | `grid-report.ts:211` | **无** |
| 图表类型白名单 | `chart.rs:30` `KINDS` | `grid-report.ts:301` | **无** |
| 条件运算符 8 个 | `model.rs:163` | `grid-report.ts:417` | 半（`model.rs:1422` 只钉 Rust 数字） |
| 表头行数判据 | `model.rs:1071` | `grid-report.ts:1543` | 半（6 条 Rust 单测） |
| 纸张名 | `model.rs:772-779` | `grid-report.ts:677` | **有**（mirror-check） |
| 页脚 255 上限 | `model.rs:1028` | `grid-report.ts:748` | **无** |
| `#RRGGBB` 校验 | `html_style_attr` | `grid-report.ts` | **无** |

```bash
grep -rnE 'assert_eq!\((PAPERS|KINDS|SYMBOLOGIES)\.len\(\)' print-server/src/report  # No matches
```
⚠️ 这条 grep 的结论「三张表连钉子都没有」**是错的** —— `PAPERS` 有**内容**钉子
（`model.rs:1517` 用 `.to_vec()` 比，不是 `.len()`）→ **grep 说「没有」时先怀疑 grep**。

→ **在 TS 侧加纸张名/图表类型、或改字节上限 → 一条闸都不会红，静默分叉。**
⚠️ **当时没漂**（读了 5 个 `*Problem` 函数体，与 Rust 逐条对齐 —— 连 code128 码集判据顺序、纸张名大小写不敏感、方向只 trim 都对齐）。
缺的是**防将来漂**的闸，不是「已经坏了」。

#### 现状：语义层已加（2026-09-27）

`mirror-check.py` 现在是两层：**A. 形状 24 组**（字段名）+ **B. 语义 8 条**（规则类事实）。
`Fact{label, rust, rust_path, ts, mode, note}`，`mode` 三种方向：

| mode | 含义 | 用在 |
| --- | --- | --- |
| `equal` | **顺序 + 内容**都要一致 | 会被 TS 拿去拼提示文案的清单（`PAPER_NAMES.join(' / ')`） |
| `set_equal` | 集合相等，**顺序不算** | 只做「认不认识」判断的清单（`IssueCode`） |
| `ts_subset` | **TS 不允许比 Rust 宽**，允许更窄 | 别名表 |

8 条事实：纸张名 / 图表类型 / 码制白名单 / 字节上限 / 条件运算符 / **码制别名（`ts_subset`）** /
页脚 255 / 诊断 code 词表（`issue.rs:139-149` ↔ `grid-report.ts:799`）。

**两条设计纪律（踩出来的，别丢）**：

1. **抽取失败必须红，不能静默跳过。** 抽取函数返回 `Optional[list[str]]`，
   **`None` 不是「空」，是「抽取失败」，计为红** —— 静默跳过会让检查退化成
   「永远绿、但根本没在检查」，**比红闸更坏（产出空头的信心）**。
   配套 `_one()` 要求锚点**恰好匹配 1 处**：0 处（改名）与 ≥2 处（正则太松）**都算失败**。
   **≥2 处不是假想的**：`engine.rs` 在 4 个测试函数里各定义了局部 `const KINDS`
   （`:4559 :4803 :4852 :4921`）→ 全仓搜索 + 「取第一个」会**静默取到测试里的表**。
2. **数花括号前先把字符串内容抹掉**（`_blank_strings`，抹成**等长**空格所以索引不漂）。
   `normalise_symbology` 里有 `format!("…{raw}…")` 与 `"{}"` → 字符串里的 `{` 会让
   函数体切错、可能给**假 OK**。三种引号都要处理（Rust/TS 双引号、TS 单引号、TS 模板串）。

**闸**：`scripts/fault-inject-mirror-semantics.py` → **9 条 9/9**，还原逐字节一致、基线全绿。
其中两条是**元性质**注入，比「改了会红」更重要：
**① TS 别名更窄必须仍绿**（对照组 → 证明方向没写反）；
**② 只改 Rust 锚点、不改事实 → 必须报「抽取失败」**（证明这条路真的会走到红，
否则前 7 条全绿也可能只是「锚点还在、正则还松」）。

**仍未覆盖**（别当成已覆盖）：**表头行数判据**（不是「一张表」而是一段判据，正则抽不出）、
**`#RRGGBB`**（两边形态不同）、以及**只覆盖「声明」不覆盖「用法」**
（闸能证明两边声明同一张表，不能证明两边用同一套逻辑 —— 判据顺序 / trim / 大小写敏感度仍靠人工核对）。

### 其余不足（详见报告）

- **引擎层的闸长在被消费方配置里**：`openprint/package.json` **无 `test` 脚本**；70 个 openprint spec 靠
  `designer-react/vite.config.ts` 的 `include` 才跑。4 个被 exclude 的 spec **永久不跑**（Vue 层，已弃用），
  其中 `designer-contract.spec.ts` 是 golden 录制器 → **`designer-v1.json`（49 012 B）自 `8ced46b` 后再未变过，已不可再生**；
  而 `designer-react/src/stores/designer-contract.spec.ts:27` 的失败提示仍指向一条**走不通的路**（openprint 装不出 node_modules）。
- **无 workspace / 构建边界**：无根 `Cargo.toml`/`package.json`/`pnpm-workspace.yaml`；designer-react 靠 vite alias
  **直引 openprint 源码**；`ts-test.sh:38-43` **硬编码仓库外**的借用 node_modules 路径 → 单测依赖本机文件系统布局。
- **报表存盘非原子**：`store.rs:301 std::fs::write`，而**同一仓库** `config.rs:385` 已在用「tmp + `fs::rename`」。
  影响**有界**（`store.rs:234-262` 对坏文件容错 → 只坏一份且可见），但 `load` 不可恢复；
  且 `updated_at` 在写盘**之前**赋好（`store.rs:295`）→ 崩了以后**从列表看不出这次保存失败**。
- **`mod.rs` 7753 = 2200 生产 + 5553 测试（72%）** → 纠正「god module」的含糊指控：主因是**测试与生产同文件**。
  生产里另有 `1545-2201`（~657 行）演示夹具（6 个 `pub` 生成器 + 3 个私有构造器），编译进二进制，
  对应 `main.rs:204-218` 的 **9 条路由**。
- `admin.rs:29 include_str!("admin.html")` → 改管理界面要重编译，且对全部 TS 闸不可见。

### 量「生产 vs 测试」的命令（注意必须 `grep -E`）

```bash
cd print-server/src/report
for f in mod.rs engine.rs model.rs store.rs xlsx.rs barcode.rs chart.rs docx.rs; do
  total=$(wc -l < $f)
  tstart=$(grep -nE '^(mod tests|#\[cfg\(test\)\])' $f | head -1 | cut -d: -f1)
  printf "%-12s total=%-6s prod=%-6s tests=%s\n" "$f" "$total" "$((tstart-1))" "$((total-tstart+1))"
done
```

| 文件 | 总 | 生产 | 测试 | 测试占比 |
| --- | --- | --- | --- | --- |
| `mod.rs` | 7753 | 2200 | 5553 | 72% |
| `engine.rs` | 5094 | 3702 | 1392 | 27% |
| `barcode.rs` | 1644 | 244 | 1400 | **85%** |
| `xlsx.rs` | 1453 | 791 | 662 | 46% |
| `model.rs` | 1729 | 1322 | 407 | 24% |
| `store.rs` | 679 | 429 | 250 | 37% |
| `chart.rs` | 448 | 226 | 222 | 50% |
| `docx.rs` | 572 | 349 | 223 | 39% |

⚠️ `grep '^mod tests\|^#\[cfg(test)\]'`（BRE + `\|`）**静默不匹配** → 会得出「这些文件都没有测试模块」的**错误结论**，
而 `wc -l` 照印总数，看着毫无异常。**第 N 次踩 BSD grep 的 `\|`。必须 `grep -E`。**

### 体量基线

Rust `print-server/src` 29 323 行 · `openprint/src` 53 137（含 `.vue`）· `designer-react/src` 27 128。
spec：openprint 70 个 · designer-react 42 个。

### 确认**不是**问题的（别重查）

`mirror-check.py` 自身不漂 · **TS 侧没有重实现展开**（`grid-report.ts` 零 import，只有显示辅助）·
存盘坏了不连累列表 · 跨框架契约没失效（只是 golden 不可再生）· 纸张名有闸 · 表头行数有 Rust 钉子 ·
`openprint` 的 spec **确实被跑到**（经 designer-react 的 include）。

### 建议（成本四档，详见报告 §4）

1. 加 `scripts/check-all.sh` 串起已有闸（`mirror-check.py` **排第一**，秒级零依赖）＋有 CI 更好。半天。
   → ✅ **2026-09-26 已做**（见 §二十一.6）。
2. 把 `mirror-check.py` 从形状扩到语义（补 `PAPERS`/`KINDS`/`SYMBOLOGIES` 的 Rust 侧内容钉子）。
   **方向必须单向蕴含** —— 「三方相等」那种写法会永久红（本项目已犯过一次，见 §二十.3）。1 天。
   → ✅ **2026-09-27 已做**（8 条事实 + 9 条注入，见本节上方「现状：语义层已加」）。
   ⚠️ 报告里这一条写的是「补 `.len()` 钉子」，**`.len()` 那半是错的**：改名时数量不变 → 毫无反应。
   实做改成了**内容钉子**（`.to_vec()` 比），并由 `fault-inject-table-pins.py` 的两条「改名」注入证明。
3. 给 `openprint` 加 `test` 脚本；给 4 个永久不跑的 spec 明确归宿（删或标废弃）；修正那条走不通的提示语。1 天。
   → ❌ 仍未做。
4. 原子写报表（抄 `config.rs:385`）· 夹具搬出 `mod.rs` · 测试模块拆出 · 加根 workspace。
   → ❌ 仍未做。

### §二十一.6 第 1 档已实施（2026-09-26）

**跑闸就一条命令**：`bash scripts/check-all.sh`。热跑全量 **~36s**（**加第 7 道后实测 195s**），
`--fast` 只跑前两道 **3.5s**。

| # | 闸 | 热跑耗时 |
| --- | --- | --- |
| 1 | `python3 scripts/mirror-check.py`（形状 24 组 + 语义 8 条） | 1s |
| 2 | `bash scripts/ts-check.sh` | 2s |
| 3 | `bash scripts/ts-test.sh` | 5s |
| 4 | `bash scripts/ts-project-check.sh`（designer-react） | 18s |
| 5 | `bash scripts/ts-project-check.sh openprint` | 6s |
| 6 | `cargo test --bin print-server` | 4s 暖 / **1m33s 冷编译** |
| 7 | `bash scripts/ts-test-designer.sh grid-report-`（jsdom，**串行**） | **160s** |

**第 7 道是 2026-09-26 补的，补的是真缺口**：`designer-react` 有 43 spec / 375 用例，
而在此之前**没有任何脚本跑它们**（`ts-test.sh` 只覆盖 `openprint/src/report/*.ts`）→
「改一次 `GridReportModal`，`check-all.sh` 照样全绿」是**真的**。
**⚠️ `--no-file-parallelism` 是正确性要求不是性能选项**：默认文件级并行下
**16 失败 / 359 通过**，同样的文件**单独跑 4/4 全绿**，串行 **375/375 全绿**。
失败形态 `Test timed out` / `expected '' to contain …` = 渲染没跑完就判死，**不是真缺陷**。
**已知缺口**：第 7 道带 `grid-report-` 过滤（11 文件 / 136 用例），
另外 **32 个 spec 仍不在聚合跑器里**（那 346s 太贵）。

**退出码三态（这是本次最重要的设计点）**：
`0 通过` / `1 失败` / **`2 没跑成`（环境缺 tsc/vitest/node/cargo，根本没检查）**。
把「没跑成」算成通过 = 假绿；算成失败 = 假红。汇总里单独列名，末行写「**不等于通过**」。
实测：摘掉 rustup 后跑 → 退出码 2 + `⚠ 没跑成：找不到 cargo` + `通过 5 · 失败 0 · 没跑成 1`。

**表钉子改成了「钉内容」**（不是数量）：`assert_eq!(KINDS.to_vec(), vec!["bar","line","pie"], "…同步 TS 的 …")`。
数量钉子对**改名**毫无反应。新增 `scripts/fault-inject-table-pins.py`：**5 条注入 5/5 抓到**，
其中两条是「改名」注入（专门证明内容钉子 > 数量钉子）。

**该注入脚本防的坑**：`cargo test <过滤名>` **匹配不到用例时仍返回 0** → 打错用例名会伪装成「通过」。
现在数输出里真跑了几条 `... ok` / `... FAILED`，匹配不到报「**没验过**」。

### §二十一.7 ⚠️ 本机 bash 3.2.57 会静默吃掉 `$VAR）` 里的变量值（2026-09-26 实测）

```bash
V=abc; echo "测试 $V）"      # ✗ →「测试 」+乱码；abc 与 ） 的头一字节都没了
V=abc; echo "测试 ${V}）"    # ✓
```

**`$VAR` 紧跟非 ASCII 字符 → 静默吃掉变量的值 + 多字节字第一个字节。**
退出码正常、脚本照跑，只是**打印的数字凭空消失**：
`检查 31 个文件（源码 13 / 测试 18）` 印成 `测试 ）`。

对照表（哪些写法安全）：

| 写法 | 结果 |
| --- | --- |
| `echo "[$V）]"` | ✗ |
| `echo "[${V}）]"` | ✓ |
| `echo "[$V""）]"` | ✓ |
| `echo "[$V ）]"` | ✓（多个空格） |
| `printf '[%s）]\n' "$V"` | ✓ |
| `echo "[$(cmd)）]"` | ✓ **命令替换不受影响** |
| `echo "[（$V]"` | ✓（变量在多字节字**之后**） |

`zsh` **同样中招** → 不是 bash 专属，按 `${VAR}` 写两边都对。
已修 4 处：`ts-check.sh:69`、`ts-project-check.sh:69`、`ts-project-check.sh:76`（2 处）、`check-all.sh:66`。
**排查手法**：搜 `\$[A-Za-z_]\w*(?=[\x80-\xff])`（`\$` 转义的不算）。
**为什么值得单独记**：它出在**闸脚本自己的状态行**上 —— 也就是「本该说真话的那一行」。

### §二十一.8 🔴 更正：`PAPERS` **本来就有**内容钉子

体检报告 §2.2 初版写「纸张/图表/码制三张表都没有钉子」，判据是
`grep -rnE 'assert_eq!\((PAPERS|KINDS|SYMBOLOGIES)\.len\(\)'` → 无匹配。

**纸张那句错了。** `model.rs:1517 paper_table_is_pinned` 用的是
`assert_eq!(PAPERS.to_vec(), expect, …)` —— **内容钉子，比数量钉子更强**。
**我的 grep 只匹配 `.len()` 形式**，静默漏掉 → 错结论。
`KINDS` / `SYMBOLOGIES` 那两句是对的（确实一个钉子都没有，已补）。

**教训（与 BSD grep 的 `\|` 同一族）**：判「有没有闸」**不能只搜一种写法** ——
搜**符号名本身**（`PAPERS`），再逐个看用法。`grep` 说「没有」时先怀疑 grep。

### §二十一.9 第 2 档已实施：`mirror-check.py` 语义层（2026-09-27）

8 条规则类事实进闸（纸张名 / 图表类型 / 码制白名单 / 字节上限 / 条件运算符 /
**码制别名** / 页脚 255 / 诊断 code 词表）。`Fact.mode` 三方向：
`equal`（顺序+内容）/ `set_equal`（顺序不算）/ **`ts_subset`（TS 不许比 Rust 宽）**。
**方向必须逐条定** —— 「三方相等」会永久红（本项目已犯过一次，见 §二十.3）。

**两条设计纪律（踩出来的，别丢）**：

1. **抽取失败必须红。** 抽取函数返回 `Optional[list[str]]` —— **`None` 不是「空」，
   是「抽取失败」，计为红**。静默跳过会让检查退化成「永远绿、但根本没在检查」，
   **比红闸更坏（产出空头的信心）**。配套 `_one()` 要求锚点**恰好匹配 1 处**：
   0 处（改名）与 **≥2 处（正则太松）都算失败**。
   **≥2 处不是假想的**：`engine.rs` 在 4 个测试函数里各定义局部 `const KINDS`
   （`:4559 :4803 :4852 :4921`）→ 全仓搜索 + 「取第一个」会**静默取到测试里的表**。
2. **数花括号前先把字符串内容抹掉**（`_blank_strings`，抹成**等长**空格 → 索引不漂）。
   `normalise_symbology` 里有 `format!("…{raw}…")` 与 `"{}"` → 字符串里的 `{`
   会让函数体切错、可能给**假 OK**。三种引号都要处理（Rust/TS 双引号、TS 单引号、模板串）。

**闸**：`scripts/fault-inject-mirror-semantics.py` → **9 条 9/9**，还原逐字节一致、基线全绿。
其中两条是**元性质**注入，比「改了会红」更重要：
**① TS 别名更窄必须仍绿**（对照组 → 方向没写反）；
**② 只改 Rust 锚点、不改事实 → 必须报「抽取失败」**（证明这条路真会走到红，
否则前 7 条全绿也可能只是「锚点还在、正则还松」= **闸根本没在检查**）。

**仍未覆盖**：表头行数判据（不是「一张表」而是一段判据）· `#RRGGBB`（两边形态不同）·
**只覆盖「声明」不覆盖「用法」**（判据顺序 / trim / 大小写敏感度仍靠人工核对）。

**顺带修的计数漂移**：`check-all.sh` 的 `15 个 fault-inject` → **16**（两处）；
`报表引擎详解` §15.1 同样 `15` → **16**（它已漂过两次）。
**判据：注释里的数字最容易漂 —— 改完脚本记得 `ls scripts/fault-inject-*.py | wc -l` 核一遍。**

---

## 二十二、《报表引擎详解-功能与算法.md》（2026-09-26，仓库根，1738 行）

用户要「详细说明功能及算法」的引擎报告。**纯文档，没动源码。**
**每条算法结论都带 `file:line`**，这是可复核的前提 —— 对不上源码的就是写错了。

### 章节地图（15 节，找东西按这个定位）

定位（三个「表格」之分）→ 代码地图与数据流 → 三层数据模型 +「声明 vs 结果」范式 →
`expand_sheet` **八个阶段**逐段 → 表达式与层次坐标 → 六张缓存 → 数字格式与聚合 →
非文本格子（优先级仲裁 / 图表反查 / 条码编码 / PNG / 图片）→ 条件格式 → 四种导出 →
分页 → 数据源·参数·循环变量 → HTTP API 面（33 条路由）→ 已知边界与取舍 →
验证设施 → 单位换算速查表。

### 写完之后自查出的三处错（都已改）

| 初稿 | 实际 |
| --- | --- |
| `CellInst` 56+ 字段 | **42** 个 pub 字段 |
| `Expr` 12 个变体 | **13** 个 |
| `MIN_COL_WIDTH` 在 `xlsx.rs:251` | 定义在 **`xlsx.rs:718`**（251 是讲理由的注释） |

第三条**又是同一个毛病**：把「注释里提到某名字」当成「定义在那」。
**判据：引常量位置时搜 `const <NAME>`，不要搜裸名字。**

### 之前没记过、但值得单独留的算法事实

- **`span_of` 自底向上算展开范围**（`engine.rs:257`）：叶子 `(0, 自身跨度)`；
  非叶子取自身与所有子格 `(子格号+子 offset, +子 span)` 的并集。
  `collect_spans` 必须覆盖**全部**格子（含无子格的叶子），否则顶层展开格查不到范围。
- **`default_row_parent` 第 ② 步读的是「解析后」的父格**（含推断出来的）→
  这是 `resolve_parents` 必须**按行优先序一次性预扫**的原因。
- **`place` 的「同格冲突让一行」**（`engine.rs:1846-1849`）：第一组子格里有跟父格同列的
  → 整组下移一行，否则上下堆叠的主从（A1 地区 / A2 城市）会把地区名**静默盖掉**。
- **`layout_group` 的 `share_row` 判据**（`engine.rs:1894-1895`）：
  `group.len() > 1 && (col_expand || col_parent.is_some())` —— 列展开的兄弟格共享一行。
- **`merge_down` 不参与布局推进**（`engine.rs:1824-1826`），否则多级表头凭空多一行。
- **`compute_display` 只覆盖文本、不动 `value`**（`engine.rs:2080-2082`）。
- **`coord_prefix_cache` 第一版是错的**（`engine.rs:824-827`）：把逐行的维度塞进缓存键
  → 键逐行不同 → **永不命中** → 8000 行 149 ms 曲线照旧平方。
  正确做法是「把逐行的维度变成**下标**」。
- **`agg_of_numbers` 是六个聚合函数的唯一口径**（`engine.rs:591`），
  但 `"counta"` **刻意不走它**（要 `non_null` 不是 `count`）。
- **xlsx 图表数据写表格下方隐藏列**（`xlsx.rs:375`、`xlsx.rs:430`）：模板坐标展开后可能
  不连续（0/3/6 行），而 Excel 一条序列只能引用**一个连续区域**。
- **`row_pixels(pts) = round(pts × 4/3)`**（`xlsx.rs:108-109`）—— 行高与列宽是两套换算。


---

## 二十三、5 个已复现缺陷（2026-09-26，外部评审驱动）

外部评审（用户贴入）提 7 条架构问题，**全部成立**；其中 5 条我做成了可复现测试。
完整核验见仓库根 **《架构评审核验-逐条复现.md》**。

**复现方式**：`engine.rs` 末尾的 `*_probe` 模块。**四个已全部转成常驻回归测试**，
`#[ignore]` 里不再有缺陷探针。

```bash
# 修 ②① 前：512 passed / 0 failed / 18 ignored
# 修 ②① 后：514 passed / 0 failed / 16 ignored
# 分级诊断后：519 passed / 0 failed / 16 ignored
# 修 ③④ 后：523 passed / 0 failed / 14 ignored
cargo test --manifest-path print-server/Cargo.toml --bin print-server
# 剩下 14 条 = 13 基准（scale::bench_*）+ 1 条码 oracle dump —— **没有缺陷探针**
cargo test --manifest-path print-server/Cargo.toml --bin print-server -- --list --ignored
```

**别再把「ignored」一律当成「缺陷探针」** —— 判据永远是 `--list --ignored` 实测。

| 模块 | 缺陷 | 一句话证据 | 状态 |
| --- | --- | --- | --- |
| `layout_collision_probe` | ① 落位冲突静默覆盖 | 同行两个列展开格 → `实例数=6 落位数=4`，渲染成 `1月 Q1 Q2 Q3`，**2月/3月连同值消失，零告警** | ✅ 已修 |
| `nonconvergence_tests` | ② 强制退出数值落后一轮 | 震荡模板 → **3 行可见但 `C1` 显示 0** | ✅ 已修 |
| `cross_ds_col_parent_probe` | ③ 跨数据集列主格裸行号 | ds1 两行/ds2 三行 → `111 \| 222`，第三行静默消失，零告警 | ✅ 已修 |
| `join_view_first_row_probe` | ④ `join_view` 首行代表整组 | 分组字段≠关联字段 → 组内 100+200 **只取到 100**，零告警 | ✅ 已修 |
| （无需探针） | ⑤ 图表「每组一张图」不成立 | `resolve_charts` 按 `pos` 去重，`engine.rs:1356-1357` 一眼可见 | 不按原注释实现 |

### ②① 的修法（2026-09-26 已落地，故障注入验过）

**② 非收敛**：`evaluate_to_fixpoint` 未收敛时的收尾改成
「清轮缓存 → 重置 `evaluated` → 按**已冻结的最终** `hidden` 重算全部值」。
抽出 `clear_round_caches()` / `reset_evaluated()`；
**`cycle_warned` 刻意不重置**（它是「同一个环只报一次」的闸）。
告警文案从「已按最后一轮结果出表」（**说反了**）改成「结果**不稳定**，不要当作可发布的结果」。

**① 落位冲突**：写入点加占用检查 —— 保留**先创建**者（序号小 = 模板位置靠前，稳定可预测），
后到者标 `dropped`（与「没被 place 过」同义 → 图表解析等自动跳过），
冲突逐条告警（坐标 + 两个 `pos` + 可执行建议），**上限 20 条**，超出只报总数。

**① 刻意不「修好布局」**：两个**独立的**列展开没有合法二维布局，硬排得到的
`1月 Q1 Q2 Q3` **像一张正常交叉表**（每列都有值），比报错更危险；
现在的 `1月 2月 3月 Q3` 一眼能看出是坏的。**代价：输出仍是坏的，只是不再静默。**

**一个决定性实验**：在冲突点插临时 `panic!` 跑全套件 → **513 条既有测试一条都不触发**
（只有探针会，`TEMP-COLLISION A1 vs B1 @(0,1)`）→ 检测是**纯增量**，
没改任何既有模板的落位。（这条回答了核验文档 §8 的「回归风险」担忧。）

**① 的已知边界（别当成已覆盖）**：检查只比**落位点是否相同**，不比 `colspan`/`rowspan`
的**覆盖范围** → 「起点不同但区间相交」（A1 在第 0 列 `colspan=3`、B1 落在第 2 列）
**仍抓不到**。补它要做矩形相交检测，而 `merge_to_end` 让矩形在算之前就依赖别的格子的
列区间，成本不低 —— **刻意没做**。

### ② 的机制（最值得记住）

`evaluate_to_fixpoint`（`engine.rs:1740-1781`）在 `round + 1 == MAX_ROUNDS` 时 `break`，
**不重置 `evaluated`**。于是最后一轮 `changed` 为真时：

| 项 | 用的是哪一轮的 `hidden` |
| --- | --- |
| `insts[..].value` | 第 3 轮（**上一轮**） |
| `insts[..].hidden`（布局按它过滤） | 第 4 轮（最新） |

**附带缺陷**：告警「已按最后一轮结果出表」（`engine.rs:1769`）**与事实相反**——
数值恰恰不是最后一轮的。**一条说反了的告警比没有告警更坏。**

### ① 的机制

`grid[r][c] = Some(..)`（原 `engine.rs:1269`）**无占用检查**。
根因在 `layout_columns`（`engine.rs:1945-1960`）：每个列展开组从**自己的 `tpl_col`**
起占列（`let mut cursor = self.insts[group[0]].tpl_col;`），两组区间重叠**不检测**。

### ③ 的机制

行父格跨数据集**强制要求 `join_on`**（`join_view` `engine.rs:921-929`），
**列父格这条路没有同等检查**：`col_parent_index`（`engine.rs:2560-2579`）
把列主格 `rows` 当**裸行号**索引直接求交。
注意 `debug_assert!`（`engine.rs:1108-1111`）**只守非分桶那条路，分桶路径无保护**——
而分桶是主路径。

### ④ 的机制

`engine.rs:931-937` 注释写「取第一行（**分组格下它们同键**）」——
**括号里那个前提没有任何校验**。分组字段 ≠ 关联字段时立刻出错。

### ⑤ 的机制

```rust
let mut seen: BTreeSet<String> = BTreeSet::new();
decls.retain(|(_, _, pos, _, _)| seen.insert(pos.clone()));   // engine.rs:1356-1357
```
所有分组实例共享同一 `pos` → 只剩第一份；`ChartIndex` 也按 `pos` 收集（1365-1377）。
**所以 `make_insts` 里那句「每组一张图」注释是误导性的。**
（报告初稿沿用了它，已在 §8.2 / §14.6 更正。）

### 两个我**不同意**评审的点（已写进核验文档 §4）

1. **「错误父格应返回模板错误」** —— 诊断对、处方错。失败粒度是**一格**不是整表
   （`compile_conditionals` 注释 `engine.rs:626-628`），直接报错＝一个笔误废掉整张表。
   正解是**结构化错误类型**（`warnings` → 分级 `issues`），让调用方拦住导出。
2. **「零依赖不应成为目标本身」** —— 优先级那半句对；隐含前提（持续投入）无证据，
   且**代码早就划了线**：QR v11+ 不做、Code128 不自动切码集、PNG 非压缩 stored、
   ZIP 只写 method 0、OOXML 只写 4~5 part。**沉没成本，非在途投入。**

### 两条评审低估/漏掉的（让修复更便宜）

- **5 个缺陷全部落在现有 512 条测试覆盖之外**：没有一条是「函数算错了」，
  全是「组合起来才错」。→ **修复第一步是补测试形状，不是改代码。**
- `layer_coordinate`（`engine.rs:2246`）**已经在算** `"A2:0,B3:2"` 形式的实例身份链
  （`dump_text` 在用）→ 评审建议的「输出保留实例上下文」是**透出**而非重写。
  同理 LogicalSheet/PageLayout 分离是既有「声明 vs 结果」约定的延伸。

### 一条可独立先做的性能项

`expr::parse` 在 `ensure_value` 里**每实例每轮都重解析**（`engine.rs:2059`），
**无 AST 缓存**（grep `ast_cache` / `HashMap<String, Expr>` → 无）。
10000 行 × 4 轮 = 解析 4 万次。加 AST 缓存几行代码，**不必等模板编译层**。

### ③④ 的修法（2026-09-26 落地，故障注入验过）

用户顺序 `② → ① → 结构化错误 → ③④` 的**最后一项**。两个缺陷同族（评审 §三.4）。

**③ 跨数据集列主格** —— `col_parent_index` 把列主格的 `rows` 当**裸行号**与当前格
`base` 求交；列主格的 `rows` 是**它自己那份数据集**的行号 → 跨数据集时两套行号没有共同含义。

- 修法：**拒绝 + `Error`**（`cross_ds_col_parent`，本格一格都不建）。
  判据 `insts[cp].ds != cell_ds_name`；**过滤必须在建 `row_to_cp` 之前** ——
  那个索引是直接拿列主格 `rows` 建的，混进跨数据集实例 = 两套行号混进同一张表。
- 行父格有 `join_view` + 强制 `join_on` 兜底；列父格**没有**对应机制
  （列轴上的「反向关联」语义完全不同），所以只能拒绝。

> ### ⚠️ 最重要的发现：**① 修好后，③ 的复现形状被盖住了**
>
> ③ 的原探针里数值格与列头在**同一模板行** → **① 的落位冲突检测先把它拦下**。
> 一度真的怀疑「③ 是不是 ① 的重复」。
>
> **分离办法**：把数值格移到列头的**下一行**（交叉表的正常形状）→ 不撞列、① 完全不响，
> 而裸行号求交**照样静默对齐**。两份数据集**等长**时输出
> `1月|2月|3月` / `111|222|333` —— **零诊断、看着完全正确**，纯属行数巧合。
> 回归测试把子表顺序倒过来（333/222/111）让对齐露馅，并**显式断言该形状里没有
> `layout_collision`** —— 那一句就是「③ 独立于 ①」的判据。
>
> **一般化教训**：一个缺陷的「复现形状」可能被**另一个修复**吃掉。
> 修完 A 要重跑 B 的探针；若 B 的探针不再红，先别宣布 B 已修 ——
> 要问「是 B 修好了，还是 A 把 B 的症状盖住了」。**症状消失 ≠ 根因消失。**

**④ `join_view` 首行** —— 原注释「取第一行（**分组格下它们同键**）」，
括号里的前提**没有任何校验**。分组字段 ≠ 关联字段时组内各行键不同 → 少取数
（华东组内 cust=1/2 的 100/200 只拿到 100）。

- 修法：取组内**全部**键值求**并集**（组关联语义）。
  - **同键**（绝大多数模板）→ 并集退化成单值 → 走**原来那条直接比较**分支，
    O(|子表|)、无额外分配、**逐字节一致**；
  - **多键** → `HashSet` 求并集（线性 `contains` 会退化成 O(|子表| × 组内键数)）；
  - 多键是**语义变化**（作者会看到不同的数）→ 报 `Warning`（`join_key_not_grouped`）。
    **不报就是新的静默行为变化。**
- **已知行为差异（已披露）**：旧代码取 `rows.first()`，若首行恰好没有关联字段而后行有，
  旧行为是「告警 + 空」，新行为取到后行的值。同质数据集不会出现，但确实是差异。

**故障注入（四条，都实测红了再逐字节还原）**

| 注入 | 结果 |
| --- | --- |
| ③ 数据集判据改成恒真（= 恢复旧行为） | **2 条红**，报 `实际第 0 列 = Some(333.0)`（1月配到 333） |
| ④ 键收集改回 `take(1)` | **1 条红**，`Some(100.0)` vs 期望 `Some(300.0)` |
| ④ 给**单键分支**注入多余告警 | 对照组 + **一条既有测试**（`cross_dataset_child_expands_over_joined_rows_only` 的「写了 join_on 就不该告警」）同时红 |
| 临时 `panic!` 量影响半径（两个新分支各一个） | **零触发** → 改动**纯增量**，没有既有模板走到新分支 |

第三条最有价值：说明「不该多报」**本来就有闸守着**，不是只靠新写的对照组。

**对照组（比「多键取并集」更关键）**：`same_key_group_join_is_unchanged_and_silent` ——
`join_on == 分组字段` 时华东 = 10+20 = 30、华南 = 5，且**一条诊断都没有**。
没有它，只能证明「多键时取并集」，证明不了「同键时没碰坏」。

---

## 二十四、分级诊断通道 `Issue`（2026-09-26 落地）

`print-server/src/report/issue.rs`。用户批准的顺序 `② → ① → 结构化错误 → ③④` 的第三步。

```rust
enum IssueLevel { Info, Warning, Error }   // Ord 有意：level >= Warning 就进 warnings
struct Issue { level, code: String, sheet: Option<String>, pos: Option<String>, message }
struct IssueSink<'a>(&'a mut Vec<Issue>);  // 字段级借用包装（见下）
```

### 核心结构决定：`warnings` 是 `issues` 的**派生视图**

老代码把 `[sheet] ` 前缀**拼进消息字符串**（`format!("[{}] {}", sheet, w)`）。
`issues` 若另存一份消息 = 「同一份事实声明两遍」→ 必然漂移。

**改法**：消息不带前缀，归属放 `sheet` 字段，末尾统一派生 `warnings`：

```rust
let warnings: Vec<String> = issues.iter()
    .filter(|i| i.is_warning_or_worse())
    .map(|i| match &i.sheet { Some(s) => format!("[{s}] {}", i.message), None => i.message.clone() })
    .collect();
```

于是「某条告警只进 `warnings`、不进 `issues`」**在结构上不可能发生**。
连带的必要改动：`loop_groups` / `check_paper_consistency` 的签名从
`&mut Vec<String>` → `&mut Vec<Issue>`，否则那几条会**只进 warnings**（又一个静默缺口）。

`RenderResponse`：`warnings` **保留**（前端零改动）+ 增量 `issues`。
TS 镜像 `grid-report.ts` 必须同步（`mirror-check.py` 盯着 `RenderResponse`，不加就红）。

### ⚠️ 借用陷阱：`Engine::warn(&mut self)` 在循环里编不过

`expand_sheet` 里 `for (i, inst) in self.insts.iter().enumerate()` 循环体要记诊断。
`self.warnings.push(..)` 只借**一个字段** → 一直合法；换成 `self.warn(..)`（借整个 `*self`）
→ **6 处 E0502**。

解法：`IssueSink(&mut self.issues)`，循环里用**临时值**形式
（借用只活在那一条语句里）。**这个包装的存在理由是借用粒度，不是抽象。**

### 级别分配

| code | 级别 | 触发 |
| --- | --- | --- |
| `layout_collision` | Error | 落位冲突（缺陷 ①） |
| `nonconvergent` | Error | 4 轮内没稳定（缺陷 ②） |
| `cross_ds_col_parent` | Error | 列主格跨数据集（缺陷 ③）—— 本格拒绝出数 |
| `join_key_not_grouped` | Warning | `join_on` 字段 ≠ 父格分组字段、组内多键（缺陷 ④）—— 已按并集关联 |
| `fixpoint_rounds` | Info | 收敛了但花了 ≥3 轮 |
| `generic` | Warning | 还没细分的旧站点（长期存在，别当错误） |

**每个 `code` 都要有生产者**（不收死字符串）。词表钉子测试在 `issue.rs`，
改了要同步 TS 的 `IssueCode`（`openprint/src/report/grid-report.ts`）。

**`Info` 刻意要有真生产者**（本项目不接受死枚举）。找到的那个是「3 轮才稳定」。

**构造 3 轮收敛模板的坑**：自我引用的条件（如 `COUNTA(B1) <= 1`）**只会震荡**，
必须用**单调链条**才收敛。可用的链：

| 轮 | 发生什么 |
| --- | --- |
| 0 | A1 的 `row_test = $B1 >= 20` 删掉华东(10)；本轮 `C1 = COUNTA(B1)` 还是 3 |
| 1 | `C1` 重算成 2 → D1 的 `row_test = $C1 >= 3` 由真变假 → 删掉 D1 整组 |
| 2 | 无变化 → **收敛，共 3 轮** |

`dump_text` 改成按级分节（`!! 结果不可信` / `!! 告警` / `!! 诊断`）——
`Info` 有**两个**消费方：这个 dump，以及设计器界面（见下）。

### 三处故障注入（都实测红）

| 注入 | 结果 |
| --- | --- |
| `fail_at` 里 `Error` → `Warning` | **3 条红**（含 E2E），「必须是 Error 级，实际：Warning」 |
| `warnings` 派生去掉 `[sheet] ` 前缀 | **3 条红**，含**两条既有测试** |
| `is_warning_or_worse` 恒真 | **2 条红**（Info 漏进 warnings） |

### ✅ 已接进设计器界面（2026-09-26）

`GridReportModal` 三条渲染路径都 `setIssues(data.issues ?? [])`，按级渲染：

| 级别 | 文案 | 表现 |
| --- | --- | --- |
| `error` | 结果不可信 | 红 Alert + **禁用导出按钮** + `blockNotice` |
| `warning` | 告警 | 黄 Alert，不拦 |
| `info` | 提示 | 灰 Alert，不拦 |

- 级别 → 文案**只有一处**（模块级 `ISSUE_LEVEL_LABEL` / `ISSUE_TEXT_TYPE` 两个表）。
- `warnings` 回退分支保留（条件 `issues.length === 0 && warnings.length > 0`）——
  服务端是**独立进程**，「新界面 + 旧服务端」是真会出现的组合。
- **导出两道闸，条件同一个**（`blockingIssues.length > 0`）：按钮 `disabled` + `doExport` 开头守卫。
  ⚠️ **守卫当前从界面走不到** —— `doExport` 唯一调用点就是那个按钮，而按钮同条件禁用。
  它是留给「将来多一个调用点」的保险。**它有没有牙齿只能靠注入证明**。
- 用例：`designer-react/src/modals/grid-report-issues.spec.tsx`（4 条）。
  ⚠️ **断言顺序是有意的**：先断言**契约**（没发出 xlsx）再断言**机制**（按钮 `disabled`）。
  反过来会**短路** —— 实测注入「只拆 `disabled`」时红在 `disabled` 那行、后面断言根本没跑，
  于是「守卫拦不拦得住」永远验不到。
- 注入：`scripts/fault-inject-issues-ui.py` → **5/5 抓到**，还原逐字节一致。
  其中「按钮禁用 + 守卫一起拆」必须红在「结果不可信却把 xlsx 发出去了」上（证明守卫在干活）。

### ⚠️ designer-react 全量套件：**默认并行下有 16 条假红**（不是本次改动造成）

`npm run test:app`（43 文件 / 375 用例）实测：

| 跑法 | 结果 | 耗时 |
| --- | --- | --- |
| 默认（文件级并行） | **16 失败 / 359 通过** | 238s |
| `--no-file-parallelism`（串行） | **0 失败 / 375 通过** | 346s |
| 那 4 个失败文件**各自单跑** | **4/4 全绿** | 各 14~21s |

失败文件：`richtext` / `p42-panels` / `flow-label` / `TopToolbar`。
失败形态：`Test timed out` / `expected '' to contain '标签网格'` ——
「渲染还没跑完就被判死」。那些用例里有真实 `setTimeout`（`flow-label` 有 `setTimeout(900)`）。
→ 判定为**抢 CPU 造成的假红**，与 2026-09-23 那条「这套 UI 用例别和 cargo 并发跑」同源。
→ **`--no-file-parallelism` 是正确性要求，不是性能选项。别把这种红当回归去「修」。**

**所以 `check-all.sh` 不能加全量 `test:app`**（346s 太贵），
但**「改了弹窗没有任何闸」这件事已经堵上了**：新增 `scripts/ts-test-designer.sh`，
作为 `check-all.sh` **第 7 道闸**（带 `grid-report-` 过滤 = 11 文件 / 136 用例 / ~160s；
无参数 = 全量 43 文件）。`ts-test.sh` 覆盖不到 modal —— 它只跑
`openprint/src/report/*.ts`（node 环境、无 DOM），modal 要 jsdom + antd + React。

**已知覆盖缺口（明写）**：第 7 道只覆盖 `grid-report-*`，
`designer-react` 另外那 32 个 spec（canvas / panels / toolbar / stores…）仍不在聚合跑器里。

### 已知边界（仍然成立）

HTTP 层错误（§13.2）**仍然没有错误码** —— 分级只覆盖渲染结果内部的诊断。
`issues.code` 只用于展示与定位，界面**没有**按 code 分支。
