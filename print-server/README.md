# print-server — OpenPrint 本地打印客户端服务（Rust 版）

对齐 Web 设计器协议契约（`openprint/src/core/print-client/types.ts`），监听 **127.0.0.1:18888**，
替代原 Qt 客户端的 HTTP 服务面。

## 启动

```bash
# 开发
cargo run
# 自定义
print-server.exe --host 0.0.0.0 --port 18888 --config print-server.json
```

- `--host 127.0.0.1`（默认，仅本机）；`--lan` 或 `--host 0.0.0.0` 开放局域网
- `--port` 默认 18888
- `--config` 配置文件路径（默认当前目录 `print-server.json`，也可用环境变量 `OPENPRINT_PRINT_SERVER_CONFIG`）
- spool 打印落盘目录默认 `./spool`
- `--list-reports` / `--run-report` / `--help`：报表命令行，**不启服务**，见下方「报表命令行」

设计器侧：「设置 → 本地打印」填 `http://127.0.0.1:18888`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | / | **可视化数据库配置页**（内嵌单页，离线零依赖；同 `/admin`） |
| GET | /health | 健康检查（app/ok/printers/time/uptimeSec/version） |
| GET | /printers | 打印机列表（winspool 枚举，含默认/在线/DPI/双面/彩色/纸盒） |
| POST | /print | 打印任务：`pdf`+base64 直打；`html`+utf8 注入 @page 后经 Edge headless 转 PDF 再打 |
| GET | /api/fonts | 系统字体枚举（解析 TTF/OTF name 表取族名，优先中文名） |
| GET | /api/fonts/data?path=… | 字体字节（严格限制在系统字体目录内） |
| GET | /api/config | 读取当前配置（**密码脱敏**，只回 `passwordSet`） |
| PUT | /api/config | 保存配置（校验 → 备份 → 原子写盘 → 热更新，无需重启） |
| POST | /api/config/test | 试连某条连接（不落盘） |
| GET | /api/config/fs?dir=… | 目录浏览（给 sqlite 路径 / 扫描目录做选择器） |
| GET | /api/data/databases | 数据库列表（配置连接 + 扫描目录发现，sqlite / postgres） |
| GET | /api/data/tables | 表/视图列表（sqlite 只读 / postgres information_schema） |
| GET | /api/data/columns | 字段元信息（type/nullable/PRI/UNI/default） |
| GET/POST | /api/data/rows | 取数（默认 100 行、上限 1000；POST 支持 where + params 参数化） |
| POST | /api/report/render | 网格报表渲染（非线性展开 / 求值都在服务端，前端只做 UI） |
| POST | /api/report/xlsx | 同上，直接回 xlsx |
| GET | /api/report/sample | 内置样例的渲染结果（不开前端也能验证） |
| GET | /api/report/sample.xlsx | 内置样例导出 xlsx |
| GET | /api/report/sample-template | 内置样例模板（设计器「打开样例」用） |
| GET | /api/report/cross-tab-* | 交叉表样例模板：基本 / 带合计 / 双指标 / 双指标带合计 / 多级表头 |
| GET | /api/reports | 报表文件列表（只回元信息，不回模板本体） |
| PUT | /api/reports/save | 保存报表定义（模板 + 数据源 + 渲染选项） |
| GET/DELETE | /api/reports/:id | 读取 / 删除一个报表定义 |
| POST | /api/reports/:id/run | 执行报表定义，回渲染结果 |
| POST | /api/reports/:id/xlsx | 执行并导出 xlsx |

## 报表命令行

存下来的报表定义是纯 JSON，可以直接被 cron / 脚本跑，**不必起前端设计器**。
命中子命令时不启 HTTP 服务，跑完即退。

```bash
print-server --list-reports
print-server --run-report <id>
print-server --run-report <id> --param ds1=华东
print-server --run-report <id> --params '{"ds1":["华东"]}'
print-server --run-report <id> --out 销售.xlsx
print-server --help
```

- `--list-reports`：列出 id / 名称 / 数据源数 / 大小 / 更新时间
- `--run-report <id>`：不给 `--out` 就在终端打印文本表格，给了就导出 xlsx
- 参数两种写法可混用，**后写的覆盖先写的**：
  - `--param k=v`：单个参数，可重复。`v` 先按 JSON 解析（`2026` → 数字），解不动就当字符串
  - `--params '<json>'`：一次给全。值收数组 `{"ds1":["华东"]}`，单个参数也可省成 `{"ds1":"华东"}`
- 参数是**按数据源名**覆盖的；数据源必须写了 `WHERE` 占位符（如 `region = ?`），否则会提前报错
- 退出码：`0` 成功 / `1` 执行失败 / `2` 用法错误（同时打印帮助）

报表默认存在**配置文件同级的 `reports/` 目录**，用 `--config` 换配置文件即换目录。

## 可视化配置数据库（推荐）

启动服务后浏览器打开 **http://127.0.0.1:18888/**（局域网访问用 `http://<本机IP>:18888/`），页面上可以：

- 新增 / 编辑 / 删除连接（sqlite、postgres、odbc），编辑弹窗内可直接 **测试连接**
- sqlite 路径、扫描目录、spool 目录都带 **目录浏览器**（也能粘路径直达，避免手打长路径）
- 「保存配置」= 写回 `print-server.json`（先备份 `.bak`、写 `.tmp` 后原子替换）并**热更新内存**，
  设计器数据源面板立刻生效，**不需要重启服务**
- 密码**只写不读**：读接口不回明文；编辑时留空 = 沿用原密码，点「清空」才会删除
- 页面上还能看到扫描目录里「已存在但未配置」的 sqlite 文件，一键加入连接

> 写操作要求请求头 `X-OpenPrint-Admin: 1`，可挡掉表单类/简单请求式 CSRF，但**不是强安全边界**。
> 服务默认只监听 `127.0.0.1`；用 `--lan` 暴露到局域网时请自行评估风险，并给数据库配**只读账号**。

界面预览：`docs/admin-page.png`、`docs/admin-connection-dialog.png`。
回归检查脚本：`designer-react/scripts/cdp-admin-check.mjs`（需一个 `--remote-debugging-port=9222` 的浏览器）。

## 数据库配置（print-server.json）

```json
{
  "connections": [
    { "id": "byb", "engine": "sqlite", "label": "业务库", "path": "F:/data/byb.db" },
    { "id": "pg", "engine": "postgres", "label": "财政库",
      "host": "127.0.0.1", "port": 5432,
      "user": "readonly", "password": "***", "dbname": "finance",
      "schema": "public" },
    { "id": "pg2", "engine": "postgres", "label": "PG 直连串",
      "url": "postgres://readonly:pwd@127.0.0.1:5432/finance" },
    { "id": "erp", "engine": "odbc", "label": "ERP DSN", "dsn": "erp_dsn" }
  ],
  "scanDirs": ["F:/data/db"],
  "spoolDir": "spool"
}
```

- `connections`：显式连接
  - **sqlite**：用 `path`（文件绝对路径）
  - **postgres**：`url`（完整连接串）或 `host/port/user/password/dbname` 分项；`schema` 可选（缺省 `public`），
    配了就只检索该 schema、表名不带前缀；不配则列出全部非系统 schema，非默认 schema 的表名带 `schema.` 前缀
  - **odbc**：用 `dsn`（ODBC 数据源名）。**可选功能，默认构建不带** —— 见下节「odbc 使用要点」
- `scanDirs`：自动发现 `*.db / *.sqlite / *.sqlite3`，以绝对路径为库名
- 所有 sqlite 打开均为 **只读模式**（SQLITE_OPEN_READ_ONLY），绝不写库
- postgres 连接后立即 `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`，本会话内无法写库；
  生产环境建议直接用**只读角色**
- 表/字段标识符先过 `sqlite_master` / `information_schema` 白名单校验，再双引号转义，防注入

### postgres 使用要点

- 元数据走 `information_schema`，**表与视图都能列出**（业务视图如 `v_export_czdetail` 可直接用）
- 取值类型：`bool / int2 / int4 / int8 / float4 / float8 / text / varchar / char / name` 原生解码；
  其余（`numeric / date / timestamp / uuid / json / bytea / 数组…`）统一 `::text` 转字符串，
  金额等 numeric 会以原始文本返回（如 `"1234.56"`），避免精度丢失
- `where` 占位符支持两种写法：`?`（自动转 `$1..$n`）或原生 `$n`；参数按序放在 `params`
- **仅支持明文连接**（未接 TLS 连接器）。服务端强制 SSL 时，请先用 `stunnel` 本地转发，
  或把需要的数据同步成本地只读副本 / sqlite 快照

### odbc 使用要点

**为什么是可选 feature**：ODBC 要链本机 unixODBC（`libodbc`），这是**原生依赖**。
默认构建保持「零原生依赖」—— CI 和只跑 sqlite / postgres 的机器不受影响。
没编 feature 时用到 odbc 连接会得到明确报错（说清是「没编进这个构建」+ 重编命令），
配置页也会按 `/health` 里的能力位显示，不会谎报「暂未实现」。

```bash
# macOS：驱动管理器 + sqlite 的 ODBC 驱动（探针就用它做端到端）
brew install unixodbc sqliteodbc

# 打开 feature 重编。不需要额外的链接器环境变量：
# odbc-sys 的构建脚本自己会去问 brew --prefix 找 libodbc
cd print-server && cargo build --features odbc
```

然后在 `odbcinst.ini` 注册驱动、`odbc.ini` 配 DSN，`connections[].dsn` 填 **DSN 名**：

```ini
; odbcinst.ini
[MyPGDriver]
Driver=/path/to/psqlodbcw.so

; odbc.ini
[erp_dsn]
Driver=MyPGDriver
Database=erp
Server=127.0.0.1
Port=5432
```

服务端按 **`ODBCINI` 环境变量**找 `odbc.ini`（不设则用系统的默认位置）：

```bash
ODBCINI=/etc/odbc.ini ./print-server
```

- 元数据走 ODBC **目录函数**（`SQLTables` / `SQLColumns` / `SQLPrimaryKeys`），
  所以表与视图能一起列出、主键与可空性都读得到，**不依赖某个驱动的方言**
- 表名 / schema 传给目录函数前会转义 `_ % \` —— 这三个是**搜索模式**元字符，
  不转义的话 `user_name` 会连 `userXname` 一起匹配出来，而且**不报错**
- 取值类型：整数 / 浮点 / 布尔**原生解码**（报表里 `sum()` 才算得对）；
  其余统一按文本取
- `where` 里的 `?` 占位符走**驱动参数绑定**，参数按序放在 `params`
- `where` 里禁止出现 `;` `--` `/*` `*/`，命中即拒；表名必须先在目录里存在

#### ⚠️ 只读保证比 sqlite / postgres **弱一档**

- sqlite 靠 `SQLITE_OPEN_READ_ONLY`（**文件级**）、postgres 靠
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`（**会话级**），
  **ODBC 这两样都做不到**：`odbc-api 29` 没暴露 `SQL_ATTR_ACCESS_MODE`，
  裸连接句柄也拿不到（`Connection::into_handle` 是**消费 self** 的，
  `Environment::allocate_connection` 是私有的），因此设不了连接属性。
- 实际能给的只有**语句级**：① 服务端自己拼的永远只有 `SELECT` / `SELECT COUNT(*)`；
  ② `where` 是唯一的注入面，按上面的规则拒掉分隔符与注释。
- **残余风险**：若驱动允许在表达式里调用有副作用的函数，理论上仍可能触发写操作。
  → **给 ODBC 配只读账号是最稳的做法，这条别省。**

真机探针（用 sqlite 的 ODBC 驱动跑端到端，自己起停服务在 18899 端口）：

```bash
python3 scripts/verify-odbc.py                 # 验开着 feature 的构建：能连上且连对
python3 scripts/verify-odbc.py --expect-off    # 验默认构建：拒绝的措辞对不对
python3 scripts/fault-inject-odbc-probe.py     # 证明上面两个探针真会红（10 条注入，两组各编各的）
node scripts/verify-admin-odbc-display.mjs     # 验配置页三种能力状态各显示什么（自带反向对照）
```

最后一条是给**配置页**的：它原来把「暂未实现」写死在页面上，feature 一开就成了页面在说谎。
现在页面读 `/health.odbc` 三态显示，这个探针在 jsdom 里把三种状态各渲染一遍，
并确认「读不到服务状态」不会被说成「未编入」。

## 限制与说明

- `/print` 实际打印走 ShellExecute（`print` / `printto` 动词），依赖本机 .pdf 关联程序；
  指定打印机时先试 `printto`，失败回落默认打印机
- `esc/tsc/zpl`（画布 JSON → 票据指令）**已实现**（`src/ticket/`，见下节）
- 格子图片（`image`）**已实现**：xlsx 真嵌入、HTML 预览出 `<img>`（见下节）
- ODBC 引擎是**可选 feature**（默认不编，见下节）：默认构建返回 ok:false，
  并说明「**没有编进这个构建**」而不是「暂未实现」—— 前者只要重编，后者像是永远没有
- `svg` 载荷已废弃（与原 Qt 客户端一致），返回 ok:false

### 票据 / 标签指令（`esc` / `tsc` / `zpl`）

载荷是**净化后的画布 JSON**（前端 `raw-sanitize.ts` 已经把颜色 / 字体样式 / 设计器元数据裁掉），
`src/ticket/` 负责翻译成指令字节，再**原样**发给打印机（CUPS 走 `lp -o raw`）。

| 载荷 | 指令 | 定位 | 中文 |
| --- | --- | --- | --- |
| `esc` | ESC/POS（小票机） | 只有「行」：`ESC 3 24` 钉行距 + `ESC d n` 推进 + `ESC $` 绝对 x | GBK |
| `tsc` | TSPL / TSPL2（TSC 标签机） | 真 x/y（点） | UTF-8 下发，靠机型字库 |
| `zpl` | ZPL II（Zebra） | `^FO` 真 x/y（点） | UTF-8（`^CI28`） |

翻不了的控件（`image` / `chart` / `math` / `signature` / `richtext` / `zone` / `labelgrid`）
**不静默丢**：进响应的 `warnings` 数组并指名到控件 id 与坐标，同时 `ok=false`。
数据行驱动的表格也只翻静态 `cells` 网格（`data` 运行期形状没有强约束，猜错比不做好）。

真机探针：`python3 scripts/verify-ticket-print.py`（走真实 `/print`，拆开落盘指令核对
喂行序列 / GBK 字节 / 各段指令长度）。

### 格子里的图片（`image`）

声明写在 `CellTpl.image` 或 `CellModel.image` 上 —— **两处都认**，服务端按
`cell.image.or(model.image)` 合并（设计器面板写的是 `model.image`）：

```json
{ "from": "literal", "src": "data:image/png;base64,iVBORw0KGgo…" }
{ "from": "value",   "src": "" }
```

- `from: "literal"`：`src` 就是图本身
- `from: "value"`：图**逐行不同**，`src` 留空，实际值取该格绑定字段的文本（字段里存的必须是 data URI）

**只收 data URI，刻意不收文件路径。** 模板是用户可编辑、可分享的 JSON，允许路径就等于把
模板变成「任意读本地文件」的原语（导出时把文件内容塞进 xlsx 带走）。要放本地图片，设计器里
选文件后在浏览器端读成 data URI 再存进模板。

白名单四种：`png` / `jpeg`(`jpg`) / `gif` / `bmp` —— 正好是 xlsx 能嵌的那四种。
`webp` / `svg` **指名报错**（而不是笼统的「不支持」），因为静默出一张白图更难查。

取不到图时**不静默**：该格 `text` 变成 `[图片: 原因]` 并进响应 `warnings`，表照常出。

几何全在服务端算，不依赖模板里写死尺寸：按图 DPI 折成显示尺寸（203dpi 的图不会被当成两倍大）、
缩到不超格宽且**不放大**，再撑开所在列的列宽 / 行高（列宽上限 60 字符、行高上限 Excel 的 409.5 磅，
超了 Excel 会直接拒开文件）。合并格按整段算可用空间。图**不占单元格文本**，alt 文本用该格文字
（没文字就用 `图片 A1`）。

真机探针（拆开 xlsx 核对媒体字节 / 锚点 EMU / 列宽行高 / alt / 图片文字没混进 sharedStrings）：

```bash
python3 scripts/verify-xlsx-image.py
```

它自己的正确性由 `python3 scripts/fault-inject-image-probe.py` 反证：往 Rust 注入 6 个已知错误
（不缩图 / 不撑列宽 / 不撑行高 / px→字符用四舍五入 / 忽略 dpi / 列宽不夹上限），**每个都必须让探针变红**。
打单测的那一组是 `python3 print-server/scripts/fault-inject-image.py`（12 条）。
「探针从没红过」等于没测 —— 这两组脚本就是防这个的。


## 构建

需要 MSVC 工具链（Community 14.43 + Windows SDK 10.0.26100.0）：

```cmd
set MSVC=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.43.34808
set SDK=C:\Program Files (x86)\Windows Kits\10
set SDKVER=10.0.26100.0
set INCLUDE=%MSVC%\include;%SDK%\Include\%SDKVER%\ucrt;%SDK%\Include\%SDKVER%\um;%SDK%\Include\%SDKVER%\shared;%SDK%\Include\%SDKVER%\winrt
set LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDKVER%\ucrt\x64;%SDK%\Lib\%SDKVER%\um\x64
cargo build --release
```
