#!/usr/bin/env python3
"""用**真实的** .xlsx 走一遍 POST /api/report/import（就是设计器那个按钮的后端）。

xlsx 用标准库 zipfile 手搓（不引第三方 —— 本环境装不出 openpyxl），格子里写
`=` 方言，验证导入回来的模板：合并、字面量、字段绑定、展开方向、聚合都要到位。

用法（先 `cargo build`）：
    python3 scripts/import-xlsx-e2e.py

跟 multi-ds-e2e.py 一样带「端口必须是本次进程占的」校验 —— 否则会测到
上一次会话留下的旧二进制。
"""
import base64, json, os, subprocess, sys, time, urllib.request, zipfile

XLSX = "/tmp/import_e2e.xlsx"
PORT = os.environ.get("E2E_PORT", "18998")
BASE = f"http://127.0.0.1:{PORT}"
BIN = os.environ.get("PRINT_SERVER_BIN",
                     "/Users/lushaohui/.cargo/target/debug/print-server")

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

def cell(ref, text):
    return (f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>')

sheet = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="{NS}">
<sheetData>
<row r="1">{cell("A1", "订单明细报表")}<c r="B1"/></row>
<row r="2">{cell("A2", "订单号")}{cell("B2", "金额")}</row>
<row r="3">{cell("A3", "=^ds1.order_no")}{cell("B3", "=ds1.amount")}</row>
<row r="4">{cell("A4", "合计")}{cell("B4", "=ds1.amount.sum()")}</row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>'''

parts = {
    "[Content_Types].xml": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>''',
    "_rels/.rels": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="{REL}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''',
    "xl/workbook.xml": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="{NS}" xmlns:r="{REL}">
<sheets><sheet name="订单明细" sheetId="1" r:id="rId1"/></sheets>
</workbook>''',
    "xl/_rels/workbook.xml.rels": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>''',
    "xl/worksheets/sheet1.xml": sheet,
}
with zipfile.ZipFile(XLSX, "w", zipfile.ZIP_DEFLATED) as z:
    for name, body in parts.items():
        z.writestr(name, body)
print(f"造好 xlsx：{os.path.getsize(XLSX)} 字节")

srv = subprocess.Popen([BIN, "--port", PORT],
                       cwd="/Users/lushaohui/project/report/print-server",
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    ok = False
    for _ in range(40):
        if srv.poll() is not None:
            print("服务进程已退出（端口被占？）"); sys.exit(2)
        try:
            urllib.request.urlopen(f"{BASE}/api/config", timeout=1).read(); ok = True; break
        except Exception:
            time.sleep(0.4)
    if not ok:
        print("服务没起来"); sys.exit(2)
    who = subprocess.run(["lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN"],
                         capture_output=True, text=True).stdout
    if str(srv.pid) not in who:
        print(f"端口 {PORT} 不是本次进程占的，拒绝跑：\n{who}"); sys.exit(2)

    b64 = base64.b64encode(open(XLSX, "rb").read()).decode()
    req = urllib.request.Request(f"{BASE}/api/report/import",
                                 data=json.dumps({"base64": b64}).encode(),
                                 headers={"Content-Type": "application/json"})
    tpl = json.loads(urllib.request.urlopen(req, timeout=20).read())
finally:
    srv.terminate(); srv.wait(timeout=5)

print(json.dumps(tpl, ensure_ascii=False, indent=2))

# 断言：这正是设计器拿到的东西，错一点按钮就是坏的
s = tpl["sheets"][0]
rows = s["rows"]
def m(r, c):
    return rows[r]["cells"][c].get("model")
assert s["name"] == "订单明细", s["name"]
assert rows[0]["cells"][0]["value"] == "订单明细报表"
assert rows[0]["cells"][0]["merge_across"] == 1, "A1:B1 合并没带过来"
assert m(1, 0) is None, "表头「订单号」不该被当成绑定"
assert m(2, 0)["field"] == "order_no" and m(2, 0)["expand_type"] == "r"
assert m(2, 1)["field"] == "amount" and m(2, 1).get("expand_type") is None
assert m(3, 1)["agg"] == "sum", m(3, 1)
print("\nOK ✅ 导入结果符合预期（合并 / 字面量 / 字段 / 方向 / 聚合）")
