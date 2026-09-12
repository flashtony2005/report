#!/usr/bin/env python3
"""报表服务 HTTP 冒烟：起服务后跑一遍全链路，断言关键格的值。

用法：
    python3 scripts/report-smoke.py [--base http://127.0.0.1:18888]

覆盖的能力点（每个都在此前真实出过 bug）：
  - 主格自动认定（模板里不写 row_parent，靠「左侧最近的展开格」推断）
  - dict 字典翻译（挂在**展开格**上，验证 make_insts 两条分支都拷了字段）
  - row_test_expr 整行删除，且被删的行**不进合计**
  - `$` 运算符 + `{}` 条件表达式
  - 分页（pages / pages_html）
  - dump 展开轨迹 + warnings 告警

为什么要单独跑 HTTP：`cargo test` 的 harness 会替换 main，路由不可达、
死代码被 strip，测不出「二进制根本编不出来」这类问题。
"""
import argparse
import json
import sys
import urllib.request

TEMPLATE = {
    "dump": True,
    "template": {
        "sheets": [{
            "name": "冒烟",
            "page": {"rows_per_page": 2, "repeat_header_rows": 1, "repeat_footer_rows": 1},
            "rows": [
                {"cells": [
                    {"pos": "A1", "value": "月份"},
                    {"pos": "B1", "value": "区域"},
                    {"pos": "C1", "value": "金额"},
                    {"pos": "D1", "value": "月小计"},
                ]},
                {"cells": [
                    # dict 挂在展开格上：1月 → 一月
                    {"pos": "A2", "model": {"ds": "ds", "field": "month", "expand_type": "r",
                                            "dict": {"1月": "一月", "2月": "二月"}}},
                    # 不写 row_parent，靠自动认定挂到 A2；row_test 删掉华南
                    {"pos": "B2", "model": {"ds": "ds", "field": "region", "expand_type": "r",
                                            "row_test_expr": 'value != "华南"'}},
                    {"pos": "C2", "model": {"ds": "ds", "field": "amount", "agg": "sum"}},
                    # $B2 = 当前格的主格（区域），裸格名才是候选格的主格
                    {"pos": "D2", "model": {"value_expr": 'C2[A2:+0]{$B2 != "华南"}.sum()'}},
                    # 指向不存在的父格，应当告警
                    {"pos": "E2", "model": {"ds": "ds", "field": "amount", "row_parent": "Z9"}},
                ]},
                {"cells": [
                    {"pos": "A3", "value": "页脚合计"},
                    # export_formula：导出 xlsx 时落成 Excel 公式而不是写死的值
                    {"pos": "C3", "model": {"value_expr": "C2.sum()", "export_formula": True}},
                ]},
            ],
        }],
        "datasets": {"ds": [
            {"month": "1月", "region": "华东", "amount": 100},
            {"month": "1月", "region": "华南", "amount": 150},
            {"month": "1月", "region": "华北", "amount": 200},
            {"month": "2月", "region": "华东", "amount": 300},
            {"month": "2月", "region": "华南", "amount": 350},
            {"month": "2月", "region": "华北", "amount": 400},
        ]},
    },
}

# 期望的网格文本：华南两行被删，合计应等于可见行之和（1000），不是全量 1500
EXPECTED = [
    ["月份", "区域", "金额", "月小计", ""],
    ["一月", "华东", "100", "300", "100"],
    ["", "华北", "200", "300", ""],
    ["二月", "华东", "300", "700", ""],
    ["", "华北", "400", "700", ""],
    ["页脚合计", "1,000", "", "", ""],
]
EXPECTED_PAGES = 2


def post(base: str, path: str, payload: dict) -> dict:
    return json.loads(post_raw(base, path, payload))


def post_raw(base: str, path: str, payload: dict) -> bytes:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18888")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    fails = []
    try:
        resp = post(base, "/api/report/render", TEMPLATE)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL 请求失败：{e}\n     服务起了吗？cargo run -- --port 18888")
        return 1

    cells = resp["sheets"][0]["rows"]
    grid = [[c["text"] for c in row] for row in cells]
    if grid != EXPECTED:
        fails.append("网格与期望不符：")
        for got, want in zip(grid, EXPECTED):
            mark = "  " if got == want else ">>"
            print(f"   {mark} 实际 {got}")
            print(f"   {'  ' if got == want else '  '} 期望 {want}")

    pages = resp.get("pages") or []
    if len(pages) != EXPECTED_PAGES:
        fails.append(f"页数应为 {EXPECTED_PAGES}，实际 {len(pages)}")

    warns = resp.get("warnings") or []
    if not any("Z9" in w for w in warns):
        fails.append(f"缺少 row_parent 告警，实际: {warns}")

    if not resp.get("dump"):
        fails.append("dump 为空（请求带了 dump=true）")

    # export_formula：合计格带公式；带 {} 条件的格翻不出来，应回落写值
    if cells[5][1].get("formula") != "SUM(C2:C5)":
        fails.append(f"合计格公式应为 SUM(C2:C5)，实际 {cells[5][1].get('formula')}")
    if cells[1][3].get("formula") is not None:
        fails.append(f"含 {{}} 条件的表达式不该翻成公式，实际 {cells[1][3].get('formula')}")

    # 多页导出时公式坐标按整表生成、逐页复制后行号对不上 → 必须回落写值
    if any(c.get("formula") for p in (resp.get("pages") or []) for r in p["rows"] for c in r):
        fails.append("分页导出的页里不该带公式（行号与整表对不上）")
    if not any("分页" in w for w in warns):
        fails.append(f"分页丢公式应告警，实际: {warns}")

    # 未分页导出：xlsx 里必须真的存着公式（而非算好的值）
    try:
        import copy
        import io
        import zipfile

        flat = copy.deepcopy(TEMPLATE)
        del flat["template"]["sheets"][0]["page"]
        z = zipfile.ZipFile(io.BytesIO(post_raw(base, "/api/report/xlsx", flat)))
        xml = z.read("xl/worksheets/sheet1.xml").decode()
        if "<f>SUM(C2:C5)</f>" not in xml:
            fails.append("未分页 xlsx 的 sheet1.xml 里没有 SUM(C2:C5) 公式")
    except Exception as e:  # noqa: BLE001
        fails.append(f"xlsx 导出/解包失败：{e}")

    print("渲染结果：")
    for row in grid:
        print("   ", row)
    print(f"分页：{len(pages)} 页 | 告警：{len(warns)} 条")

    if fails:
        print("\nFAIL")
        for f in fails:
            print("  -", f)
        return 1
    print("\nPASS 全部断言通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
