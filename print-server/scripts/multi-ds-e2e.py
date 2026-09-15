#!/usr/bin/env python3
"""多数据集 E2E：两个**独立数据源**（各一条 SQL），靠 join_on 在报表里关联。

数据故意倾斜：ds1 三行、ds2 四行，且「李四 0 单」插在中间 ——
按行号硬凑的话，李四会拿到张三的第二单、王五会拿到第三单，一眼能看出来。

用法（先 `cargo build`）：
    python3 scripts/multi-ds-e2e.py

两个坑，都是真踩过的，脚本里已经挡掉：
1. **端口必须自己占**。第一次跑时 18888 上还挂着上一次会话留下的旧进程，
   新进程绑定失败直接退出，而「/api/config 通了」的探活照样成功 ——
   于是测的是旧二进制，结论是假的。现在会比对 lsof 里的 PID，对不上就拒绝跑。
2. **`--port` 要真的传**。改了脚本里的 PORT 却没传给二进制，一样白等 16 秒。
"""
import json, os, sqlite3, subprocess, sys, time, urllib.request

DB = "/tmp/multi_ds_e2e.db"
PORT = os.environ.get("E2E_PORT", "18999")
BIN = os.environ.get("PRINT_SERVER_BIN",
                     "/Users/lushaohui/.cargo/target/debug/print-server")
BASE = f"http://127.0.0.1:{PORT}"

if os.path.exists(DB):
    os.remove(DB)
c = sqlite3.connect(DB)
c.executescript("""
CREATE TABLE customers (cust_id INTEGER, name TEXT);
CREATE TABLE orders (cust_id INTEGER, order_no TEXT, amount REAL);
INSERT INTO customers VALUES (1,'张三'),(2,'李四'),(3,'王五');
-- 张三 3 单、李四 0 单、王五 1 单
INSERT INTO orders VALUES (1,'SO-1',100),(1,'SO-2',200),(1,'SO-3',300),(3,'SO-9',900);
""")
c.commit(); c.close()

def cell(pos, ds, field, expand=None, row_parent=None, join_on=None):
    m = {"ds": ds, "field": field}
    if expand: m["expand_type"] = expand
    if row_parent: m["row_parent"] = row_parent
    if join_on: m["join_on"] = join_on
    return {"pos": pos, "value": None, "model": m}

tpl = {"sheets": [{
    "name": "客户订单",
    "rows": [{"cells": [
        cell("A1", "ds1", "name", "r"),
        cell("B1", "ds2", "order_no", "r", "A1", "cust_id"),
        cell("C1", "ds2", "amount", None, "B1"),
    ]}],
}], "datasets": {}}

body = {
    "template": tpl,
    "sources": [
        {"name": "ds1", "engine": "sqlite", "database": DB,
         "table": "customers", "fields": "cust_id,name"},
        {"name": "ds2", "engine": "sqlite", "database": DB,
         "table": "orders", "fields": "cust_id,order_no,amount"},
    ],
    "dump": True,
}

srv = subprocess.Popen(
    [BIN, "--port", PORT],
    cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    ok = False
    for _ in range(40):
        if srv.poll() is not None:
            print("服务进程已退出（多半是端口被占/绑定失败）"); sys.exit(2)
        try:
            urllib.request.urlopen(f"{BASE}/api/config", timeout=1).read()
            ok = True; break
        except Exception:
            time.sleep(0.4)
    if not ok:
        print("服务没起来"); sys.exit(2)
    # 必须确认端口是这个进程占的，否则会测到「上一次会话留下的旧二进制」
    who = subprocess.run(["lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN"],
                         capture_output=True, text=True).stdout
    if str(srv.pid) not in who:
        print(f"端口 {PORT} 不是本次进程占的，拒绝跑：\n{who}"); sys.exit(2)

    req = urllib.request.Request(f"{BASE}/api/report/render",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=20).read())
finally:
    srv.terminate(); srv.wait(timeout=5)

print("warnings:", resp.get("warnings") or "（无）")
for sh in resp["sheets"]:
    print(f"\n=== {sh['name']} ===")
    for r in sh["rows"]:
        print("  " + " | ".join(x["text"] for x in r))
d = resp.get("dump")
if d:
    print("\n--- dump ---")
    print(d if isinstance(d, str) else json.dumps(d, ensure_ascii=False, indent=2))
