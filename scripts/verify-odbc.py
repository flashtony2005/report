#!/usr/bin/env python3
"""
ODBC 引擎的真机探针 —— 走真实 `/api/data/*`，用 sqlite 的 ODBC 驱动做端到端验证。

为什么要真机：`db_odbc.rs` 里大部分逻辑（目录函数、类型解码、模式转义）**单测碰不到**，
单测只能覆盖纯函数。而 ODBC 的行为一大半取决于驱动，只能真连一次才知道。

**自己起停服务**（端口 18899，避开常用的 18888），环境：
    ODBCSYSINI=<tmp>/odbcinst.ini 所在目录
    ODBCINI=<tmp>/odbc.ini
配置用 `--config <tmp>/print-server.json`，不碰仓库里的 print-server.json。

用法：python3 scripts/verify-odbc.py
      python3 scripts/verify-odbc.py --expect-off   # 验证「没编 feature」那条路

`--expect-off` 是给**默认构建**（`cargo build`，不带 `--features odbc`）用的：
那时 odbc 连接必须被**明确拒绝**，而且措辞必须是「没有编进这个构建」而不是
「暂未实现」—— 后者是永久性的说法，会让用户去换驱动，其实只要加个 feature 重编。
两条路各有人守，光测开着 feature 的那条会漏掉这一半。

退出码：0 = 全部通过；1 = 有断言失败。
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"
BIN = Path.home() / ".cargo/target/debug/print-server"
TMP = ROOT / ".odbc-probe"
PORT = 18899
BASE = f"http://127.0.0.1:{PORT}"
DSN = "openprint_probe"
# brew 装的 sqliteodbc；换机器只要改这一行（README 里有装法）
DRIVER_SO = "/opt/homebrew/opt/sqliteodbc/lib/libsqlite3odbc.so"
# 默认构建（不带 --features odbc）用这个模式：断言的是「诚实拒绝」，不是「能连上」
EXPECT_OFF = "--expect-off" in sys.argv

fails: list[str] = []
notes: list[str] = []


def check(cond: bool, label: str, detail: str = "") -> None:
    if cond:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}" + (f" —— {detail}" if detail else ""))
        fails.append(label)


def note(msg: str) -> None:
    print(f"  · {msg}")
    notes.append(msg)


# ------------------------------ 环境 ------------------------------


def setup() -> Path:
    """建 odbcinst.ini / odbc.ini / 测试库 / 配置，返回库路径。

    **整个探针一个文件都不删。** 沙箱对删除有**按轮累计**的拦截
    （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，一轮里超过阈值之后每一次删除都要人工确认），
    而故障注入脚本要连跑十几次探针 —— 用删除清理就会在第 N 次挂掉，
    且报错长得像探针本身坏了。所以：
    - 测试库存在就 `DROP TABLE IF EXISTS` 再建，不删文件；
    - ini / 配置直接覆盖写（`write_text` 自带截断，本来就不需要先删）。
    """
    TMP.mkdir(parents=True, exist_ok=True)
    db = TMP / "probe.db"

    con = sqlite3.connect(db)
    con.executescript(
        """
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS user_name;
        DROP TABLE IF EXISTS userXname;

        CREATE TABLE orders (
            id      INTEGER PRIMARY KEY,
            region  TEXT    NOT NULL,
            amount  REAL,
            qty     INTEGER,
            note    TEXT
        );
        INSERT INTO orders VALUES (1,'华东',10.5,3,'正常');
        INSERT INTO orders VALUES (2,'华东',20.25,7,NULL);
        INSERT INTO orders VALUES (3,'华北',5.0,1,'备注里有分号会被拒; 但这条只是数据');

        -- 名字里带下划线：目录函数的表名参数是「搜索模式」，不转义的话
        -- user_name 会连 userXname 一起匹配出来（而且不报错）
        CREATE TABLE user_name (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL);
        INSERT INTO user_name VALUES (1,'张三');
        CREATE TABLE userXname (id INTEGER PRIMARY KEY, decoy_col TEXT);
        INSERT INTO userXname VALUES (1,'这条字段不该出现在 user_name 的字段表里');
        """
    )
    con.commit()
    con.close()

    (TMP / "odbcinst.ini").write_text(
        f"[OpenPrintProbeSQLite]\n"
        f"Description=SQLite3 ODBC Driver (probe)\n"
        f"Driver={DRIVER_SO}\n"
        f"Setup={DRIVER_SO}\n",
        encoding="utf-8",
    )
    (TMP / "odbc.ini").write_text(
        f"[{DSN}]\nDriver=OpenPrintProbeSQLite\nDatabase={db}\n", encoding="utf-8"
    )
    (TMP / "print-server.json").write_text(
        json.dumps(
            {
                "connections": [
                    {"id": "probe", "engine": "odbc", "label": "ODBC 探针", "dsn": DSN}
                ],
                "spoolDir": str(TMP / "spool"),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return db


def start_server() -> subprocess.Popen:
    env = dict(os.environ)
    env["ODBCSYSINI"] = str(TMP)
    env["ODBCINI"] = str(TMP / "odbc.ini")
    env["RUST_LOG"] = "warn"
    p = subprocess.Popen(
        [str(BIN), "--port", str(PORT), "--config", str(TMP / "print-server.json")],
        cwd=str(SERVER_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=1) as r:
                if r.status == 200:
                    return p
        except Exception:
            time.sleep(0.25)
    out = ""
    try:
        p.terminate()
        out = p.communicate(timeout=5)[0] or ""
    except Exception:
        pass
    raise SystemExit(f"✗ 服务起不来（{BASE}/health 一直不通）\n{out[-2000:]}")


def get(path: str, **params) -> dict:
    q = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    url = f"{BASE}{path}" + (f"?{q}" if q else "")
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read())


def post(path: str, body: dict, admin: bool = False) -> dict:
    headers = {"Content-Type": "application/json"}
    if admin:
        # /api/config/* 要求这个头（CSRF 防护），值不校验、存在即可
        headers["x-openprint-admin"] = "1"
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


# ------------------------------ 断言 ------------------------------


def main() -> int:
    if not EXPECT_OFF and not Path(DRIVER_SO).exists():
        raise SystemExit(
            f"✗ 没找到 sqlite ODBC 驱动 {DRIVER_SO}\n"
            f"  macOS: brew install unixodbc sqliteodbc"
        )
    # --expect-off 下**不检查驱动**：那条路在碰到驱动之前就该拒绝掉，
    # 这正是要验证的性质之一（没编 feature 的构建不该依赖本机装没装 ODBC）。
    setup()
    print(f"起服务（端口 {PORT}，ODBCINI={TMP}/odbc.ini）…")
    p = start_server()
    try:
        if EXPECT_OFF:
            run_checks_feature_off()
        else:
            run_checks()
    finally:
        p.terminate()
        try:
            p.communicate(timeout=5)
        except Exception:
            p.kill()

    print()
    for n in notes:
        print(f"  · {n}")
    if fails:
        print(f"\n✗ {len(fails)} 条断言失败：")
        for f in fails:
            print(f"    - {f}")
        return 1
    print("\n✓ 全部通过")
    return 0


def run_checks_feature_off() -> None:
    """默认构建（`cargo build`，无 feature）下要走的断言。

    验的是**拒绝的方式**，不是「有没有报错」—— 报错谁都会，
    关键是报错得指向「重新编译」而不是「这个功能不存在」。
    """
    print("\n[off-1] /health 如实报告本构建没编入 ODBC")
    h = get("/health")
    check(h.get("odbc") is False, "/health.odbc === false", repr(h.get("odbc")))
    check("reportsDir" in h, "/health 本身仍正常（服务没坏）", str(list(h)))

    print("\n[off-2] 用到 odbc 连接：要说「没编进这个构建」，不能说「暂未实现」")
    t = get("/api/data/tables", connId="probe")
    check(t.get("ok") is False, "列目录被明确拒绝", str(t)[:300])
    msg = str(t.get("message", ""))
    check("没有编进这个构建" in msg, "点名「没编进这个构建」", msg[:300])
    check("暂未实现" not in msg, "不能说成「暂未实现」（那是永久性的说法）", msg[:300])
    check("--features odbc" in msg, "给出可执行的下一步（重编命令）", msg[:300])

    print("\n[off-3] 内联 engine=odbc 同样要明确拒绝")
    t2 = get("/api/data/tables", engine="odbc", database=DSN)
    check(t2.get("ok") is False, "内联路径被拒", str(t2)[:300])
    check("没有编进这个构建" in str(t2.get("message", "")), "内联路径也点名原因", str(t2)[:300])

    print("\n[off-4] 试连（配置页那条路）也要说清原因")
    probe = post("/api/config/test", {"id": "probe", "engine": "odbc", "dsn": DSN}, admin=True)
    check(probe.get("ok") is False, "试连被明确拒绝", str(probe)[:300])
    pmsg = str(probe.get("message", ""))
    check("没有编进这个构建" in pmsg, "试连报错点名原因", pmsg[:300])
    check("暂未实现" not in pmsg, "试连也不说「暂未实现」", pmsg[:300])

    print("\n[off-5] feature 是加法：别的引擎不受影响")
    # 临时配置里只有一条 odbc 连接，所以这里走 sqlite 内联路径验「服务整体没被带坏」
    t3 = get("/api/data/tables", engine="sqlite", database=str(TMP / "probe.db"))
    check(t3.get("ok") is True, "sqlite 内联路径照旧可用", str(t3)[:300])
    tnames = sorted(x["name"] for x in t3.get("tables", []))
    check("orders" in tnames, "sqlite 还能列出表", str(tnames))


def run_checks() -> None:
    print("\n[1] 三条解析路径都要能落到这个 odbc 连接")
    dbs = get("/api/data/databases")
    names = [(d.get("name"), d.get("engine")) for d in dbs.get("databases", [])]
    # ODBC 条目的「库标识」是 DSN（`DbConnection::entry_name`），不是 id —— 前端回传的就是它
    check((DSN, "odbc") in names, "配置里的 odbc 连接出现在库列表里", f"实际 {names}")
    for label, params in [
        ("connId 精确匹配", {"connId": "probe"}),
        ("database 按条目名（DSN）反查", {"database": DSN}),
        ("内联 engine=odbc + DSN", {"engine": "odbc", "database": DSN}),
    ]:
        t = get("/api/data/tables", **params)
        check(t.get("ok") is True, f"{label} 能列出表", str(t)[:200])

    print("\n[2] 表 / 视图列表（走 SQLTables）")
    t = get("/api/data/tables", connId="probe")
    tnames = sorted(x["name"] for x in t.get("tables", []))
    for want in ("orders", "user_name", "userXname"):
        check(want in tnames, f"表 {want} 在列表里", f"实际 {tnames}")

    print("\n[3] 字段元信息（走 SQLColumns + SQLPrimaryKeys）")
    c = get("/api/data/columns", connId="probe", table="orders")
    check(c.get("ok") is True, "columns 返回 ok", str(c)[:300])
    cols = {x["name"]: x for x in c.get("columns", [])}
    check(set(cols) == {"id", "region", "amount", "qty", "note"}, "字段集合正确", str(list(cols)))
    check(cols.get("id", {}).get("key") == "PRI", "id 被认成主键", str(cols.get("id")))
    check(cols.get("region", {}).get("nullable") is False, "region 非空", str(cols.get("region")))
    check(cols.get("note", {}).get("nullable") is True, "note 可空", str(cols.get("note")))

    print("\n[4] 表名里的下划线要被转义（否则会多匹配出 userXname）")
    c2 = get("/api/data/columns", connId="probe", table="user_name")
    names2 = sorted(x["name"] for x in c2.get("columns", []))
    check(
        "decoy_col" not in names2,
        "user_name 的字段里没有 userXname 的 decoy_col",
        f"实际 {names2} —— 表名参数没转义，被当成了搜索模式",
    )
    check(names2 == ["full_name", "id"], "user_name 只有自己的两个字段", str(names2))

    print("\n[5] 取数（走 SQL 游标）")
    r = post("/api/data/rows", {"connId": "probe", "table": "orders", "limit": 10})
    check(r.get("ok") is True, "rows 返回 ok", str(r)[:300])
    check(r.get("total") == 3, "total = 3", str(r.get("total")))
    rows = r.get("rows", [])
    check(len(rows) == 3, "取到 3 行", str(len(rows)))
    if len(rows) == 3:
        check([x["id"] for x in rows] == [1, 2, 3], "行序与主键一致", str([x["id"] for x in rows]))
        check(rows[1]["note"] is None, "NULL 原样成 null（不是空串）", str(rows[1]))
        check(rows[0]["region"] == "华东", "中文原样取回", str(rows[0]))

        print("\n[6] 类型：整数 / 浮点要原生解码，不能一律变字符串")
        # 全变字符串的话报表里的 sum() 会在字符串上静默算错 —— 「看着有数据、其实算错了」
        check(isinstance(rows[0]["id"], int), "id 是数字不是字符串", f"{rows[0]['id']!r}")
        check(isinstance(rows[0]["qty"], int), "qty 是数字", f"{rows[0]['qty']!r}")
        check(isinstance(rows[0]["amount"], float), "amount 是浮点", f"{rows[0]['amount']!r}")
        check(isinstance(rows[0]["region"], str), "region 是字符串", f"{rows[0]['region']!r}")
    else:
        check(False, "取数没拿到行，后面几条断言跳过")

    print("\n[7] limit 生效")
    r2 = post("/api/data/rows", {"connId": "probe", "table": "orders", "limit": 2})
    check(len(r2.get("rows", [])) == 2, "limit=2 只回 2 行", str(len(r2.get("rows", []))))
    check(r2.get("total") == 3, "total 仍是全量 3", str(r2.get("total")))

    print("\n[8] fields 白名单")
    r3 = post(
        "/api/data/rows",
        {"connId": "probe", "table": "orders", "fields": "id,region", "limit": 5},
    )
    check(
        all(set(x) == {"id", "region"} for x in r3.get("rows", [])) and r3.get("rows"),
        "只回选中的两列",
        str(r3.get("rows", [])[:1]),
    )
    bad = post("/api/data/rows", {"connId": "probe", "table": "orders", "fields": "id,nope"})
    check(bad.get("ok") is False, "未知字段被拒", str(bad)[:200])
    check("nope" in str(bad.get("message", "")), "报错点名了那个字段", str(bad)[:200])

    print("\n[9] where + 参数绑定（驱动要把文本参数转成数字才比得上）")
    r4 = post(
        "/api/data/rows",
        {"connId": "probe", "table": "orders", "where": "qty > ?", "params": [5], "limit": 10},
    )
    check(r4.get("ok") is True, "带参 where 能跑", str(r4)[:300])
    got = [x["id"] for x in r4.get("rows", [])]
    check(got == [2], "qty > 5 只剩 id=2", f"实际 {got} —— 文本参数没被驱动转成数字")
    check(r4.get("total") == 1, "带参时 total 也对", str(r4.get("total")))

    print("\n[10] 注入面：where 里的语句分隔符 / 注释必须被拒")
    for bad_where, why in [
        ("1=1; DROP TABLE orders", "分号"),
        ("1=1 -- x", "行注释"),
        ("1=1 /* x */", "块注释"),
    ]:
        resp = post(
            "/api/data/rows",
            {"connId": "probe", "table": "orders", "where": bad_where},
        )
        check(resp.get("ok") is False, f"{why}被拒（{bad_where!r}）", str(resp)[:200])

    print("\n[11] 注入面：表名必须先在目录里验证过")
    bad_t = post(
        "/api/data/rows",
        {"connId": "probe", "table": "orders; DROP TABLE x"},
    )
    check(bad_t.get("ok") is False, "不存在的表名被拒", str(bad_t)[:200])

    print("\n[12] 试连探针（admin 配置页那条路）")
    probe = post(
        "/api/config/test",
        # `ConnPayload` 里 conn 是 `#[serde(flatten)]` 的，字段直接在顶层
        {"id": "probe", "engine": "odbc", "dsn": DSN},
        admin=True,
    )
    check(probe.get("ok") is True, "试连成功", str(probe)[:300])
    check("张表" in str(probe.get("message", "")), "试连摘要里有表数", str(probe.get("message"))[:200])

    print("\n[13] /health 要如实报告本构建编入了 ODBC（配置页靠它显示）")
    # 配置页不再写死「暂未实现」，改成读这个能力位 —— 它错了页面就会说谎
    h = get("/health")
    check(h.get("odbc") is True, "/health.odbc === true", repr(h.get("odbc")))


if __name__ == "__main__":
    sys.exit(main())
