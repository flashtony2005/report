#!/usr/bin/env python3
"""HTML 预览画作者样式（任务 #74）的真机探针 —— 走真实的 /api/report/render。

## 为什么单测不够（本仓库反复踩的那一类）

`to_html()` 是纯函数，单测直接喂 `RenderedSheet` 就能断言输出字符串 —— 但那只
证明了「**这个函数**拿到 style 会画」。真正的问题从来不是这个，而是：

- `GridCell.style` 这条链**上游有没有真的把样式填进来**（条件格式算出来的那份
  走的是同一格字段，容易只在某一层生效）；
- 端到端跑一遍 `/api/report/render` 时，样式会不会被**另一段代码**抹掉
  （分页路径就另有一份 `to_html` 调用）；
- 出错时 HTTP 层给的是 400 还是 500、文案里有没有**点名是哪一格**。

所以这里只做端到端：POST 模板 → 读 `RenderResponse.html` / `pages_html` 字段。

## 这个探针验的链路

    模板 JSON（作者 style + conditional）
        ↓ 引擎展开（条件格式按本格值挑规则、逐字段叠在作者样式上）
        ↓ GridCell.style
        ├→ /api/report/render 的 `html`        ← 设计器预览走的就是这条
        └→ /api/report/render 的 `pages_html`  ← 分页预览，**另一份 to_html 调用**

## 判据为什么长这样

- **按 `<tr>` / `<td>` 解析而不是 `html.count("style=")`**：`<table>` 自己就带
  `style="border-collapse:collapse"`，所以「文档里有没有 style=」永远为真。
  这个陷阱在写 Rust 单测时已经骗过一次（两条断言是**恒真**的）。
- **样式串整条精确比对**：只查「有没有 color」会漏掉「多了个别的属性 / 顺序变了 /
  属性跑到隔壁格」。顺序是 `html_style_attr` 里 `css.push` 的顺序，是契约的一部分。
- **没样式的格单独断言成 `<td rowspan="1" colspan="1">素格</td>`**：
  这是「加样式功能**没有**改变无样式格输出」的逐字节证据。

## 已知**不覆盖**的（照实说，不是漏了）

- Univer 画布里的表现：那是 `canvas-pixel-verify` 的地盘，这里只看服务端 HTML。
- xlsx 侧的落地：由 `verify-xlsx-conditional.py` 覆盖。
- 样式的**视觉**效果（字号 14pt 到底多大）：这里只验 CSS 文本对不对。
- **没有覆盖到的字段组合**：`h_align` 只走 `right`、`v_align` 只走 `bottom`/`middle`、
  `font_size` 只走 14/16 —— 单测里是**全枚举**的（`html_preview_maps_every_alignment_variant`）。
  这道门禁的职责是「端到端接线对不对」，字段枚举留给单测；两边都跑才是完整覆盖。

## 它自己的牙齿

`scripts/fault-inject-html-style.py` 会逐条改坏产品代码、同时跑**单测**与**本探针**，
打印一张门禁矩阵。第一次跑出来时本探针在 3 条注入下是**绿的**（`always-attr` /
`bold-normal` / `valign-middle`）—— 因为模板里没有 `bold: Some(false)` 这一格、
`v_align` 也没走 `middle`。补上「六、样式枚举」那一段后，这 3 条也红了。
**留着这段记录**：探针的强度是被注入实验量出来的，不是感觉出来的。

## 用法（先起服务）

    cd print-server && ~/.cargo/target/debug/print-server --port 18906 &
    python3 scripts/verify-html-style.py --port 18906
    python3 scripts/verify-html-style.py --port 18906 --dump   # 打印拿到的 HTML

退出码：0 = 全部符合；1 = 有不符合（并打印差在哪）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request

fails: list[str] = []

RED = "#FF0000"
YELLOW = "#FFFF00"
GREEN = "#00FF00"

# 全字段样式的期望 CSS。顺序 = `html_style_attr` 里 css.push 的顺序，
# **是契约的一部分**：换顺序会让这里的 diff 很吵，但那正是提醒「你动了渲染口径」。
FULL_CSS = (
    "font-weight:bold;font-style:italic;font-size:14pt;"
    "color:#123456;background-color:#ABCDEF;text-align:right;vertical-align:bottom"
)

DATA = [("华东", 1200), ("华北", 900), ("华南", 3000)]
ROWS = len(DATA)


def check(ok: bool, msg: str) -> bool:
    if not ok:
        fails.append(msg)
    return ok


def rule(when: str, value, style=None) -> dict:
    r: dict = {"when": when, "value": value}
    if style is not None:
        r["style"] = style
    return r


# ---------------------------------------------------------------- 模板
#
# 列布局（展开后每行 6 格，A2 的 expand_type=r 只把行数从 1 撑到 3，
# 因为每个 region 取值不同 → 没有合并格）：
#
#   A 地区（展开）  B 金额（作者粗体+16pt，条件 >1000 变红）
#   C 全字段样式    D 字面量 1201（条件 >1000 加黄底）
#   E 字面量 7（同一条规则**不**命中）  F 素格（完全没样式）

TEMPLATE = {
    "sheets": [
        {
            "name": "预览样式",
            "rows": [
                {
                    "cells": [
                        {"pos": "A1", "value": "地区"},
                        {"pos": "B1", "value": "金额"},
                        {"pos": "C1", "value": "全字段"},
                        {"pos": "D1", "value": "命中"},
                        {"pos": "E1", "value": "不命中"},
                        {"pos": "F1", "value": "没样式"},
                    ]
                },
                {
                    "cells": [
                        {
                            "pos": "A2",
                            "model": {"ds": "ds1", "field": "region", "expand_type": "r"},
                        },
                        {
                            "pos": "B2",
                            "model": {
                                "ds": "ds1",
                                "field": "amount",
                                "row_parent": "A2",
                                # 作者样式**只有**粗体 + 字号：条件格式只改字色，
                                # 若渲染器整格替换而不是逐字段叠加，这两项就会消失。
                                "style": {"bold": True, "font_size": 16},
                                "conditional": [rule("gt", 1000, {"color": RED})],
                            },
                        },
                        {
                            "pos": "C2",
                            "value": "样式全字段格",
                            "model": {
                                "style": {
                                    "bold": True,
                                    "italic": True,
                                    "font_size": 14,
                                    "color": "#123456",
                                    "bg": "#ABCDEF",
                                    "h_align": "right",
                                    "v_align": "bottom",
                                }
                            },
                        },
                        {
                            "pos": "D2",
                            "value": 1201,
                            "model": {"conditional": [rule("gt", 1000, {"bg": YELLOW})]},
                        },
                        {
                            "pos": "E2",
                            "value": 7,
                            "model": {"conditional": [rule("gt", 1000, {"bg": YELLOW})]},
                        },
                        {"pos": "F2", "value": "素格"},
                    ]
                },
            ],
        }
    ],
    "datasets": {"ds1": [{"region": r, "amount": a} for r, a in DATA]},
}

# 分页模板：每页都该带上样式（分页路径另有一次 `to_html` 调用）
PAGED = {
    "sheets": [
        {
            "name": "分页",
            "page": {"rows_per_page": 2, "repeat_header_rows": 1, "repeat_footer_rows": 0},
            "rows": [
                {"cells": [{"pos": "A1", "value": "地区"}, {"pos": "B1", "value": "金额"}]},
                {
                    "cells": [
                        {
                            "pos": "A2",
                            "model": {"ds": "ds1", "field": "region", "expand_type": "r"},
                        },
                        {
                            "pos": "B2",
                            "model": {
                                "ds": "ds1",
                                "field": "amount",
                                "row_parent": "A2",
                                "style": {"bg": GREEN},
                            },
                        },
                    ]
                },
            ],
        }
    ],
    "datasets": {
        "ds1": [{"region": "A", "amount": 1}, {"region": "B", "amount": 2},
                {"region": "C", "amount": 3}, {"region": "D", "amount": 4}],
    },
}


# ---------------------------------------------------------------- HTTP


def post(path: str, payload: dict) -> tuple[int, str]:
    """POST 到本机服务，返回 `(状态码, 响应体)`。**4xx/5xx 不抛异常**（要读文案）。

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
    try:
        with opener.open(req, timeout=120) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


# ---------------------------------------------------------------- HTML 解析


def table_rows(html: str) -> list[list[str]]:
    """把 HTML 切成「每个 `<td …>…</td>` 的完整字符串」，按 `<tr>` 分组。"""
    rows = re.findall(r"<tr>(.*?)</tr>", html, re.S)
    return [re.findall(r"<td\b[^>]*>.*?</td>", row, re.S) for row in rows]


def style_of(td: str) -> str | None:
    m = re.search(r'style="([^"]*)"', td)
    return m.group(1) if m else None


def inner_of(td: str) -> str:
    m = re.search(r"<td\b[^>]*>(.*)</td>", td, re.S)
    return m.group(1) if m else ""


def styled_tags(html: str) -> set[str]:
    """带 `style=` 属性的标签名集合。

    比 `html.count('style=')` 有意义：那个数字永远 ≥ 1（`<table>` 自带
    `border-collapse`），断言它等于 0 是**恒假**、等于 1 也说明不了没跑到别处。
    """
    return set(re.findall(r"<(\w+)\b[^>]*\sstyle=\"", html))


def check_one_table(html: str, want_rows: int, want_cols: int, label: str) -> list[list[str]] | None:
    rows = table_rows(html)
    if not check(len(rows) == want_rows, f"{label}：应当 {want_rows} 行，实际 {len(rows)}"):
        return None
    for i, r in enumerate(rows):
        if not check(len(r) == want_cols, f"{label}：第 {i + 1} 行应当 {want_cols} 格，实际 {len(r)}"):
            return None
    return rows


# ---------------------------------------------------------------- 主流程


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18888)
    ap.add_argument("--dump", action="store_true", help="打印拿到的 HTML")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    # ================================================ 一、样式落到正确的格
    print("== 一、预览 HTML：样式落到正确的格 ==")
    code, body = post(f"{base}/api/report/render", {"template": TEMPLATE})
    if not check(code == 200, f"render 应当 200，实际 {code}：{body[:200]}"):
        return report()
    resp = json.loads(body)
    check(not (resp.get("warnings") or []), f"这份模板不该有告警，实际 {resp.get('warnings')}")
    html = resp["html"]
    if args.dump:
        print(html)

    rows = check_one_table(html, ROWS + 1, 6, "预览")
    if rows is None:
        return report()

    # 样式只允许出现在 <td> 与 <table> 上（没跑到 <tr> / <h3> / 文档级）
    tags = styled_tags(html)
    check(
        tags == {"td", "table"},
        f"带 style 的标签应当只有 td 与 table，实际 {sorted(tags)}",
    )
    print(f"  ✓ 带 style 的标签 = {sorted(tags)}（table 的是 border-collapse，与样式无关）")

    # C 列（全字段）三行都该是完整那一串 —— 整条精确比对，顺序也是契约
    got_c = [style_of(r[2]) for r in rows[1:]]
    if check(
        got_c == [FULL_CSS] * ROWS,
        f"C 列（全字段样式）不符\n    期望 {FULL_CSS}\n    实际 {got_c}",
    ):
        print("  ✓ C2 的 7 个样式字段三行都在，且顺序/取值精确匹配")

    # F 列（素格）必须**逐字节**是加这个功能之前的样子
    plain = '<td rowspan="1" colspan="1">素格</td>'
    got_f = [r[5] for r in rows[1:]]
    if check(got_f == [plain] * ROWS, f"素格的 <td> 应当逐字节是 {plain}\n    实际 {got_f}"):
        print(f"  ✓ 无样式格的输出与加功能前逐字节一致：{plain}")

    # 表头整行都没有 style
    head_styled = [i for i, td in enumerate(rows[0]) if style_of(td) is not None]
    check(not head_styled, f"表头第 {head_styled} 列不该有 style")

    # 不串格：C 列有样式、紧邻的 F 列没有（同一行内），D 列有、E 列没有
    check(
        all(style_of(r[2]) and style_of(r[5]) is None for r in rows[1:]),
        "样式串到了不该有的格子（C 有而 F 没有才是对的）",
    )
    print("  ✓ 样式没有串到相邻格（C 有 / F 无，D 有 / E 无）")

    # ================================================ 二、条件格式在预览里可见
    print("\n== 二、条件格式（B3）在预览里可见 —— 与 #74 的交汇点 ==")

    # B 列：1200 / 900 / 3000 → 命中 / 不命中 / 命中
    got_b = [style_of(r[1]) for r in rows[1:]]
    want_b = [
        "font-weight:bold;font-size:16pt;color:#FF0000",
        "font-weight:bold;font-size:16pt",
        "font-weight:bold;font-size:16pt;color:#FF0000",
    ]
    if check(
        got_b == want_b,
        f"B 列条件格式不符\n    期望 {want_b}\n    实际 {got_b}",
    ):
        print("  ✓ B 列：>1000 变红，且作者设的粗体/字号**没被整格替换掉**（逐字段叠加）")

    # 文字也得跟着走（样式挂在正确那一格上，不是别的格）
    got_text = [inner_of(r[1]) for r in rows[1:]]
    check(
        got_text == ["1,200", "900", "3,000"],
        f"B 列文本应当是 1,200 / 900 / 3,000，实际 {got_text}",
    )

    # D 列：字面量 1201（无条件格式之外还要验「字面量格也走这条路」）
    got_d = [style_of(r[3]) for r in rows[1:]]
    check(
        got_d == [f"background-color:{YELLOW}"] * ROWS,
        f"D 列（字面量 1201，条件命中）应当三行都是黄底，实际 {got_d}",
    )

    # E 列：字面量 7，同一条规则不命中 → **完全不该有 style**
    got_e = [style_of(r[4]) for r in rows[1:]]
    if check(got_e == [None] * ROWS, f"E 列（7，条件不命中）不该有 style，实际 {got_e}"):
        print("  ✓ D 列（命中）三行都有黄底、E 列（不命中）三行都没有 style")

    # ================================================ 三、分页 HTML 也有样式
    print("\n== 三、分页预览（另一份 to_html 调用）也有样式 ==")
    code, body = post(f"{base}/api/report/render", {"template": PAGED})
    if not check(code == 200, f"分页 render 应当 200，实际 {code}：{body[:200]}"):
        return report()
    pr = json.loads(body)
    pages = pr.get("pages_html")
    if not check(bool(pages), f"分页模板应当返回 pages_html，实际 {pages!r}"):
        return report()
    check(len(pages) == 2, f"4 行数据 + 每页 2 行 → 应当 2 页，实际 {len(pages)}")
    for i, ph in enumerate(pages):
        prows = check_one_table(ph, 3, 2, f"第 {i + 1} 页")
        if prows is None:
            continue
        # 每页第一行是重复表头（不该有样式），后两行是数据（都该有绿底）
        check(style_of(prows[0][1]) is None, f"第 {i + 1} 页表头不该有样式")
        got = [style_of(r[1]) for r in prows[1:]]
        check(
            got == [f"background-color:{GREEN}"] * 2,
            f"第 {i + 1} 页数据行应当都是绿底，实际 {got}",
        )
    print(f"  ✓ {len(pages)} 页都带上了样式，且每页重复的表头没有被染色")

    # ================================================ 四、没样式 → 输出逐字节不变
    print("\n== 四、整份模板都没有样式时，<td> 与加功能前逐字节一致 ==")
    bare = json.loads(json.dumps(TEMPLATE))
    for row in bare["sheets"][0]["rows"]:
        for c in row["cells"]:
            if "model" in c:
                c["model"].pop("style", None)
                c["model"].pop("conditional", None)
    code, body = post(f"{base}/api/report/render", {"template": bare})
    if not check(code == 200, f"无样式模板应当 200，实际 {code}：{body[:200]}"):
        return report()
    bhtml = json.loads(body)["html"]
    brows = check_one_table(bhtml, ROWS + 1, 6, "无样式")
    if brows is not None:
        # 每一个 <td> 都必须是 `<td rowspan="1" colspan="1">…</td>` 这一种形状
        all_td = [td for r in brows for td in r]
        bad = [td for td in all_td if not re.fullmatch(r'<td rowspan="1" colspan="1">.*?</td>', td, re.S)]
        check(not bad, f"无样式时每个 <td> 都不该多任何属性，这几个不是：{bad}")
        check(
            styled_tags(bhtml) == {"table"},
            f"无样式时带 style 的标签应当只有 table，实际 {sorted(styled_tags(bhtml))}",
        )
        print(f"  ✓ {len(all_td)} 个 <td> 全是 `<td rowspan=\"1\" colspan=\"1\">`，无多余属性")

    # ================================================ 五、转义与样式共存
    print("\n== 五、文本里的 HTML 元字符与样式属性互不干扰 ==")
    esc_tpl = {
        "sheets": [{"name": "转义", "rows": [{"cells": [
            {"pos": "A1", "value": '<b>&"', "model": {"style": {"bold": True}}},
        ]}]}],
    }
    code, body = post(f"{base}/api/report/render", {"template": esc_tpl})
    check(code == 200, f"转义模板应当 200，实际 {code}：{body[:200]}")
    if code == 200:
        ehtml = json.loads(body)["html"]
        want = '<td rowspan="1" colspan="1" style="font-weight:bold">&lt;b&gt;&amp;"</td>'
        check(want in ehtml, f"应当出现 {want}\n    实际 {ehtml}")
        print(f"  ✓ {want}")

    # ================================================ 六、样式枚举与边界
    print("\n== 六、样式枚举：`Some(false)` 与 middle 对齐 ==")
    # 这两格在单测里枚举过（`html_preview_maps_every_alignment_variant` /
    # `html_preview_omits_false_bold_instead_of_writing_normal`），端到端这条路上
    # **也要走一遍**：门禁矩阵第一次跑出来时，探针在这两条注入下是**绿的** ——
    # 那意味着「预览这条路」没人守 `Some(false)` 语义与 middle 映射。
    enum_tpl = {
        "sheets": [{"name": "枚举", "rows": [{"cells": [
            # `bold: Some(false)` 单独一项 → `CellStyle` 非空，但一个 CSS 字段都产不出。
            # 这一格必须**完全不带 style 属性**：既不能吐 `style=""`，
            # 也不能吐 `font-weight:normal`（xlsx 侧 `Some(false)` = 不表态、保持基础格式，
            # 这里写 normal 就会让同一份模板在预览与导出里长得不一样）。
            {"pos": "A1", "value": "假加粗", "model": {"style": {"bold": False}}},
            # `v_align: middle`：CSS 里合法值是 middle（写 center 等于没设，静默失效）
            {"pos": "B1", "value": "垂直居中", "model": {"style": {"v_align": "middle"}}},
        ]}]}],
    }
    code, body = post(f"{base}/api/report/render", {"template": enum_tpl})
    if not check(code == 200, f"枚举模板应当 200，实际 {code}：{body[:200]}"):
        return report()
    erows = check_one_table(json.loads(body)["html"], 1, 2, "枚举")
    if erows is not None:
        e0, e1 = erows[0]
        if check(
            e0 == '<td rowspan="1" colspan="1">假加粗</td>',
            f"`bold: false` 不该产出任何 style（更不该写 font-weight:normal），实际 {e0}",
        ):
            print(f"  ✓ bold:false → {e0}")
        if check(
            style_of(e1) == "vertical-align:middle",
            f"`v_align: middle` 应当映射成 vertical-align:middle，实际 {style_of(e1)!r}",
        ):
            print(f'  ✓ v_align:middle → style="{style_of(e1)}"')

    # ================================================ 七、错误路径：报错并点名
    print("\n== 七、坏样式要报 400 并点名哪一格哪个值（不是静默丢样式）==")

    def one_cell(style: dict) -> dict:
        return {"sheets": [{"name": "s", "rows": [{"cells": [
            {"pos": "C2", "value": "x", "model": {"style": style}}]}]}]}

    cases = [
        ({"color": "red"}, "style.color", "red"),
        ({"color": "#GGGGGG"}, "style.color", "#GGGGGG"),
        ({"bg": "rgb(1,2,3)"}, "style.bg", "rgb(1,2,3)"),
        ({"font_size": 0}, "style.font_size", "0"),
        ({"font_size": 500}, "style.font_size", "500"),
        ({"font_size": -3}, "style.font_size", "-3"),
    ]
    for style, field, value in cases:
        code, body = post(f"{base}/api/report/render", {"template": one_cell(style)})
        check(code == 400, f"{style} 应当报 400，实际 {code}：{body[:160]}")
        check("格子 C2" in body, f"{style} 的报错应当点名「格子 C2」，实际 {body[:160]!r}")
        check(field in body, f"{style} 的报错应当点名字段「{field}」，实际 {body[:160]!r}")
        check(value in body, f"{style} 的报错应当带上原值「{value}」，实际 {body[:160]!r}")
    print(f"  ✓ {len(cases)} 种坏样式都是 400，且都点名了格子位置 + 字段 + 原值")

    # 导出端点同口径：`to_html` 现在在 `render()` 内部校验，所以错误在
    # `xlsx_handler` 调 `to_xlsx` **之前**就冒出来 → 400（改动前是 500，
    # 因为那时 `to_html` 不校验、错要等 `xlsx::with_style` 才炸）。
    # 这条断言就是钉住「两个端点对同一个坏样式给同一个状态码」。
    code_x, body_x = post(f"{base}/api/report/xlsx", {"template": one_cell({"color": "red"})})
    if check(
        code_x == 400,
        f"/api/report/xlsx 对坏样式应当与预览同口径报 400，实际 {code_x}：{body_x[:160]}",
    ):
        print("  ✓ /api/report/xlsx 对同一个坏样式也报 400（改动前是 500）")
    check("格子 C2" in body_x, f"导出端点的报错也要点名格子，实际 {body_x[:160]!r}")

    # 合法边界不该报错（0~409 是闭区间，409 允许、1 允许）
    for ok_sz in (1, 409):
        code, body = post(f"{base}/api/report/render", {"template": one_cell({"font_size": ok_sz})})
        check(code == 200, f"font_size={ok_sz} 合法，不该报错，实际 {code}：{body[:160]}")
    print("  ✓ font_size 的合法边界（1 / 409）不报错")

    return report()


def report() -> int:
    print()
    if fails:
        print(f"✗ {len(fails)} 项不符合：")
        for f in fails:
            print("  -", f)
        return 1
    print("✓ HTML 预览样式探针全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
