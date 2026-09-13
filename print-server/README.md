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
  - **odbc**：用 `dsn`（**暂未实现**，会返回明确提示）
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

## 限制与说明

- `/print` 实际打印走 ShellExecute（`print` / `printto` 动词），依赖本机 .pdf 关联程序；
  指定打印机时先试 `printto`，失败回落默认打印机
- `esc/tsc/zpl`（画布 JSON → 票据指令翻译）与 ODBC 引擎暂未实现，返回 ok:false 明确提示
- `svg` 载荷已废弃（与原 Qt 客户端一致），返回 ok:false

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
