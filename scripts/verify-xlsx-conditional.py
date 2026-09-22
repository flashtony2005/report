#!/usr/bin/env python3
"""条件格式（B3「按值改样式」）的真机探针 —— 走真实的 /api/report/xlsx 与 /api/report/render。

## 为什么单测不够（本仓库反复踩的那一类）

条件格式**不另开渲染通道**：它只是决定把哪一份 `CellStyle` 放进 `GridCell.style`，
后面那条路（xlsx `with_style()` 叠加在基础格式上）是既有的、已验过的。
所以真正需要验的是**决定那一步**：
- 哪一格拿到了样式、哪一格没有（漏判 / 误判在 JSON 里看得见，但在 xlsx 里才是真的落地）；
- 样式**真的写进了 xlsx 的 styles.xml**（`s=` 索引 → `fontId` / `fillId` → 颜色）——
  Rust 侧读不到 zip 内容，单测只能断言「不报错」，那等于没测；
- 规则顺序（第一条命中的生效）、闭区间端点、非数值不命中、坏规则进 warnings。

## 这个探针验的链路

    模板 JSON（含 conditional）
        ↓ 引擎展开：按本格算出来的值挑规则，逐字段叠在作者样式上
        ↓ GridCell.style
        ├→ /api/report/render 的 JSON（可直接断言每一格的 style）
        └→ /api/report/xlsx → 拆 zip → styles.xml 的 fontId / fillId → 颜色

## 已知**不覆盖**的（照实说，不是漏了）

本探针只验 xlsx + JSON 两条路。**HTML 预览那条路由 `verify-html-style.py` 覆盖**
—— 2026-09-22 起 `to_html` 也会渲染作者样式（含条件格式算出来的那份），
所以「条件格式只在导出里看得见」这句话已经**过期**了。
（历史：在 2026-09-22 之前 `to_html` 从不读 `GridCell.style`，预览的配色是语义高亮。）

## 用法（先起服务）

    cd print-server && ~/.cargo/target/debug/print-server --port 18904 &
    python3 scripts/verify-xlsx-conditional.py --port 18904

退出码：0 = 全部符合；1 = 有不符合（并打印差在哪）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
import zipfile
from io import BytesIO

fails: list[str] = []

RED = "#FF0000"
BLUE = "#0000FF"
YELLOW = "#FFFF00"
GREEN = "#00FF00"
RULE_COLORS = {RED, BLUE, YELLOW, GREEN}

# 数据：1200 命中规则 1（红）也命中规则 2（蓝）→ 取第一条（红）
#       900  只命中规则 2（蓝）
#       3000 命中规则 1（红）
# 这是「第一条命中的生效」唯一能验出顺序的地方：必须有一格**同时命中两条**。
DATA = [("华东", 1200), ("华北", 900), ("华南", 3000)]


def check(ok: bool, msg: str) -> bool:
    if not ok:
        fails.append(msg)
    return ok


def rule(when: str, value, value2=None, style=None) -> dict:
    r: dict = {"when": when, "value": value}
    if value2 is not None:
        r["value2"] = value2
    if style is not None:
        r["style"] = style
    return r


# ---------------------------------------------------------------- 模板

TEMPLATE = {
    "sheets": [
        {
            "name": "条件格式",
            "rows": [
                {
                    "cells": [
                        {"pos": "A1", "value": "地区"},
                        {"pos": "B1", "value": "金额"},
                        {"pos": "C1", "value": "文本"},
                        {"pos": "D1", "value": "空值"},
                        {"pos": "E1", "value": "下界"},
                        {"pos": "F1", "value": "上界"},
                        {"pos": "G1", "value": "区间外"},
                    ]
                },
                {
                    "cells": [
                        # A2 纵向展开 → 同一行的其它格也跟着出现 3 次
                        {
                            "pos": "A2",
                            "model": {"ds": "ds1", "field": "region", "expand_type": "r"},
                        },
                        # B2：两条都命中时取第一条（红），只命中第二条时是蓝
                        {
                            "pos": "B2",
                            "model": {
                                "ds": "ds1",
                                "field": "amount",
                                "row_parent": "A2",
                                "conditional": [
                                    rule("gt", 1000, style={"color": RED, "bg": "#FFF1B8"}),
                                    rule("gt", 500, style={"color": BLUE}),
                                ],
                            },
                        },
                        # C2：**文本格**，`ge 0` 不该命中（若把文本当 0 就会命中）
                        {
                            "pos": "C2",
                            "value": "华东",
                            "model": {"conditional": [rule("ge", 0, style={"color": GREEN})]},
                        },
                        # D2：绑一个**数据里不存在的字段** → 值是空，`lt 100` 不该命中
                        {
                            "pos": "D2",
                            "model": {
                                "ds": "ds1",
                                "field": "no_such_field",
                                "row_parent": "A2",
                                "conditional": [rule("lt", 100, style={"color": GREEN})],
                            },
                        },
                        # E2/F2/G2：between 的闭区间（端点含）
                        {
                            "pos": "E2",
                            "value": 100,
                            "model": {"conditional": [rule("between", 100, 200, {"color": YELLOW})]},
                        },
                        {
                            "pos": "F2",
                            "value": 200,
                            "model": {"conditional": [rule("between", 100, 200, {"color": YELLOW})]},
                        },
                        {
                            "pos": "G2",
                            "value": 99.9,
                            "model": {"conditional": [rule("between", 100, 200, {"color": YELLOW})]},
                        },
                    ]
                },
            ],
        }
    ],
    "datasets": {
        "ds1": [{"region": r, "amount": a} for r, a in DATA],
    },
}

# 展开后：表头在第 1 行，数据在第 2~4 行（xlsx 的 1 基行号）
ROWS = len(DATA)
# 每行期望的 (B 字色, B 底色)，**整条序列一起断言** ——
# 只断言某一格会漏掉「旁边那格没带上样式 / 被挤掉」。
EXPECT_B = [
    (RED, "#FFF1B8"),
    (BLUE, None),
    (RED, "#FFF1B8"),
]


def post(path: str, payload: dict, raw: bool = False):
    """POST 到本机服务。

    **必须绕开代理**：这个沙箱里 `http_proxy` 是设着的，urllib 默认会走它，
    于是 127.0.0.1 的请求被代理成 `HTTP Error 502: Bad Gateway` ——
    看着像服务没起，其实是请求压根没到服务。
    """
    req = urllib.request.Request(
        path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=120) as r:
        body = r.read()
        return body if raw else json.loads(body)


# ---------------------------------------------------------------- xlsx 样式解析


def section(styles: str, tag: str) -> str:
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", styles, re.S)
    return m.group(1) if m else ""


def rgb_of(fragment: str) -> str | None:
    """取 `<color rgb="FFRRGGBB"/>` / `<fgColor rgb="FFRRGGBB"/>` 的 `#RRGGBB`。

    **必须大小写不敏感**：字色是 `<color>`、底色是 `<fgColor>`，
    写成 `'<color rgb='` 会**静默漏掉所有底色**（探针自己假红/假绿过一次）。
    主题色 / 索引色（`theme=` / `indexed=`）返回 None。
    """
    m = re.search(r'color rgb="([0-9A-Fa-f]{6,8})"', fragment, re.I)
    if not m:
        return None
    return "#" + m.group(1).upper()[-6:]


class XlsxStyles:
    """styles.xml → 「某个格子的字色 / 底色」。

    为什么要绕这一圈：`with_style()` 是**叠加**在导出器基础格式上的，
    所以「作者样式生效了吗」在产物里表现为「这格的 `s=` 指向的 xf 里
    fontId / fillId 有没有变成我们设的那个颜色」。只看 `s=` 存在与否
    是**看不出来**的 —— 每个格子本来就有 `s`（基础格式带边框）。
    """

    def __init__(self, styles: str):
        self.xfs = re.findall(r"<xf\b.*?(?:/>|</xf>)", section(styles, "cellXfs"), re.S)
        self.fonts = re.findall(r"<font>(.*?)</font>", section(styles, "fonts"), re.S)
        self.fills = re.findall(r"<fill>(.*?)</fill>", section(styles, "fills"), re.S)

    def of(self, sheet_xml: str, ref: str) -> tuple[str | None, str | None] | None:
        m = re.search(rf'<c r="{ref}"([^>]*?)(?:/>|>)', sheet_xml)
        if not m:
            return None
        s = re.search(r'\bs="(\d+)"', m.group(1))
        k = int(s.group(1)) if s else 0
        if k >= len(self.xfs):
            return None
        xf = self.xfs[k]
        fid = re.search(r'fontId="(\d+)"', xf)
        flid = re.search(r'fillId="(\d+)"', xf)
        font = self.fonts[int(fid.group(1))] if fid and int(fid.group(1)) < len(self.fonts) else ""
        fill = self.fills[int(flid.group(1))] if flid and int(flid.group(1)) < len(self.fills) else ""
        return rgb_of(font), rgb_of(fill)


def styles_of(payload) -> list[dict]:
    """render 结果里每格的 style（没样式就是 {}），按行展开。"""
    rows = payload["sheets"][0]["rows"]
    return [c.get("style") or {} for row in rows for c in row]


# ---------------------------------------------------------------- 主流程


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18888)
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    # ================================================ 一、xlsx 侧（真正的落地）
    print("== xlsx：styles.xml 里的字色 / 底色 ==")
    try:
        blob = post(f"{base}/api/report/xlsx", {"template": TEMPLATE}, raw=True)
    except Exception as e:  # noqa: BLE001
        # 必须记进 fails 再早退 —— 只 print 不记会让脚本以 0 退出（假绿）。
        # 探针出错的方向是假红还算安全，**假绿才是灾难**。
        fails.append(f"导出请求失败：{e}（服务起了吗？端口 {args.port}）")
        print(f"✗ 导出请求失败：{e}")
        return report()
    if not check(blob[:2] == b"PK", "导出物应当是 zip（以 PK 开头）"):
        return report()

    z = zipfile.ZipFile(BytesIO(blob))
    styles = z.read("xl/styles.xml").decode("utf8", "ignore")
    sheet_name = next((n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)), None)
    if not check(sheet_name is not None, "zip 里找不到 worksheet"):
        return report()
    sheet = z.read(sheet_name).decode("utf8", "ignore")
    sx = XlsxStyles(styles)

    # 每一格单独取，**整条序列一起断**
    got_b: list[tuple[str | None, str | None]] = []
    for i in range(ROWS):
        ref = f"B{i + 2}"
        one = sx.of(sheet, ref)
        if not check(one is not None, f"{ref} 在 worksheet 里找不到"):
            return report()
        got_b.append(one)
    if check(
        got_b == EXPECT_B,
        f"B 列的字色/底色与期望不符\n    期望 {EXPECT_B}\n    实际 {got_b}",
    ):
        print(f"  ✓ B2:B{ROWS + 1} 字色/底色 = {got_b}（第一条命中生效 + 只命中第二条走蓝）")

    # 非数值格（C 文本 / D 空）一条规则都不该命中
    for i in range(ROWS):
        for ref in (f"C{i + 2}", f"D{i + 2}"):
            one = sx.of(sheet, ref)
            if not check(one is not None, f"{ref} 找不到"):
                continue
            check(
                one[0] not in RULE_COLORS,
                f"{ref} 是文本 / 空值格，不该命中任何规则，实际字色 {one[0]}",
            )
    print(f"  ✓ C 列（文本）/ D 列（空值）都没有被标色")

    # between 的闭区间：E=100 与 F=200 都命中，G=99.9 不命中
    e = sx.of(sheet, "E2")
    f = sx.of(sheet, "F2")
    g = sx.of(sheet, "G2")
    check(e is not None and e[0] == YELLOW, f"E2=100 是区间下界，应当命中（闭区间），实际 {e}")
    check(f is not None and f[0] == YELLOW, f"F2=200 是区间上界，应当命中（闭区间），实际 {f}")
    check(
        g is not None and g[0] not in RULE_COLORS,
        f"G2=99.9 在区间外，不该命中，实际 {g}",
    )
    print("  ✓ between 闭区间：100 与 200 都命中、99.9 不命中")

    # ================================================ 二、JSON 侧（决定那一步）
    print("\n== render：每一格的 style ==")
    resp = post(f"{base}/api/report/render", {"template": TEMPLATE})
    check(
        not (resp.get("warnings") or []),
        f"这份模板不该有告警，实际 {resp.get('warnings')}",
    )
    rows = resp["sheets"][0]["rows"]
    check(len(rows) == ROWS + 1, f"应当 {ROWS + 1} 行（含表头），实际 {len(rows)}")

    # 作者样式 + 条件格式的**逐字段叠加**：C2 那格既有作者底色又有命中后的字色
    author_merge = json.loads(json.dumps(TEMPLATE))
    cells = author_merge["sheets"][0]["rows"][1]["cells"]
    cells[1]["model"]["style"] = {"bold": True, "font_size": 14}
    resp2 = post(f"{base}/api/report/render", {"template": author_merge})
    b2 = resp2["sheets"][0]["rows"][1][1]["style"]
    check(b2.get("color") == RED, f"命中后字色要变红，实际 {b2}")
    check(b2.get("bold") is True, f"作者设的粗体不该被抹掉，实际 {b2}")
    check(b2.get("font_size") == 14, f"作者设的字号不该被抹掉，实际 {b2}")
    check(b2.get("bg") == "#FFF1B8", f"规则里的底色要生效，实际 {b2}")
    print(f"  ✓ 条件格式逐字段叠加在作者样式上：{b2}")

    # 不命中时不该凭空多出样式（表头那行没配条件格式）
    head = resp["sheets"][0]["rows"][0][0]
    check(not head.get("style"), f"没配条件格式的表头格不该有 style，实际 {head.get('style')}")

    # ================================================ 三、错误路径：坏规则进 warnings
    print("\n== 错误路径：坏规则要告警（不是静默不生效）==")
    bad = json.loads(json.dumps(TEMPLATE))
    bad_cells = bad["sheets"][0]["rows"][1]["cells"]
    bad_cells[1]["model"]["conditional"] = [
        rule("bigger", 1000, style={"color": RED}),          # 认不出的比较方式
        rule("gt", None, style={"color": RED}),              # 缺 value
        rule("between", 100, style={"color": RED}),          # between 缺 value2
        rule("gt", 1, style={}),                             # 没有样式
        rule("gt", 1, 500, {"color": RED}),                  # value2 用错地方
        rule("between", 200, 100, {"color": RED}),           # 上下界写反
    ]
    rb = post(f"{base}/api/report/render", {"template": bad})
    warns = " ".join(rb.get("warnings") or [])
    for want in ["bigger", "value", "value2", "没有样式", "忽略", "写反"]:
        check(want in warns, f"告警里应当提到「{want}」，实际：{warns!r}")
    # 表照常出（失败粒度是**一条规则**，不是整张表）
    check(len(rb["sheets"][0]["rows"]) == ROWS + 1, "坏规则不该让表出不来")
    # 一条坏规则只该告警一次（不是每行一次）—— 6 条规则 × 3 行 = 18 条就说明去重坏了
    n_cond = len([w for w in (rb.get("warnings") or []) if "条件格式" in w])
    check(n_cond <= 6, f"坏规则应当每格只告警一次，实际 {n_cond} 条条件格式告警：{rb.get('warnings')}")
    print(f"  ✓ 6 种坏规则都点名了原因，共 {n_cond} 条条件格式告警（每格一次），表照常出")

    # 上下界写反要**自动交换**（照算的话区间为空、永远不命中）
    swap = json.loads(json.dumps(TEMPLATE))
    swap["sheets"][0]["rows"][1]["cells"][4]["model"]["conditional"] = [
        rule("between", 200, 100, {"color": YELLOW})
    ]
    rs = post(f"{base}/api/report/render", {"template": swap})
    e2 = rs["sheets"][0]["rows"][1][4]["style"]
    check((e2 or {}).get("color") == YELLOW, f"交换后 100 应落在 [100,200] 内，实际 {e2}")
    print("  ✓ 上下界写反 → 告警 + 自动交换（否则区间为空、静默永不命中）")

    # 符号写法（手写 JSON 的作者十有八九写符号）
    sym = json.loads(json.dumps(TEMPLATE))
    sym["sheets"][0]["rows"][1]["cells"][1]["model"]["conditional"] = [
        rule(">=", 900, style={"color": RED})
    ]
    ry = post(f"{base}/api/report/render", {"template": sym})
    got = [(r[1].get("style") or {}).get("color") for r in ry["sheets"][0]["rows"][1:]]
    check(got == [RED, RED, RED], f">= 900 三行都该命中（闭区间），实际 {got}")
    print(f"  ✓ 符号写法 >= 生效：{got}")

    # 空样式的规则**不能把后面的规则挡住**（判定是「第一条命中的生效」）
    shadow = json.loads(json.dumps(TEMPLATE))
    shadow["sheets"][0]["rows"][1]["cells"][1]["model"]["conditional"] = [
        rule("gt", 1000),                        # 命中但没样式 → 必须被刷掉
        rule("gt", 500, style={"color": YELLOW}),
    ]
    rz = post(f"{base}/api/report/render", {"template": shadow})
    got = [(r[1].get("style") or {}).get("color") for r in rz["sheets"][0]["rows"][1:]]
    check(
        got == [YELLOW, YELLOW, YELLOW],
        f"空样式那条不该挡住第二条（1200/900/3000 都 > 500），实际 {got}",
    )
    print(f"  ✓ 空样式规则不挡后面那条：{got}")

    return report()


def report() -> int:
    print()
    if fails:
        print(f"✗ {len(fails)} 项不符合：")
        for f in fails:
            print("  -", f)
        return 1
    print("✓ 条件格式探针全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
