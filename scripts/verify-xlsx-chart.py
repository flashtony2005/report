#!/usr/bin/env python3
"""
图表格导出的真机探针 —— 走真实的 /api/report/xlsx 与 /api/report/render，拆开产物核对。

为什么单测不够（本仓库反复踩的那一类）：

1. **图表是 zip 里的 `xl/charts/chart1.xml`，Rust 侧读不到内容** ——
   `to_xlsx` 的返回值里能搜到 `xl/charts/chart1.xml` 这个**文件名**
   （zip 中央目录不压缩），但里面的图表类型、序列引用、缓存数值全都搜不到。
   单测只能断言「没报错」，那等于没测。
2. 图表最容易错的地方**恰恰在 XML 里**：序列引用指到了哪几格、类目顺序对不对、
   空值是空档还是被写成了 0。这些只有拆开看才知道。
3. **引用范围错一格是静默的**：图会画出来，只是画的是别的数据。

用法（先起服务）：
    cd print-server && ~/.cargo/target/debug/print-server --port 18901 &
    python3 scripts/verify-xlsx-chart.py --port 18901
    python3 scripts/verify-xlsx-chart.py --port 18901 --dump   # 打印 chart/sheet XML

退出码：0 = 全部符合；1 = 有不符合（并打印差在哪）。
"""
import argparse
import json
import re
import sys
import urllib.request
import zipfile
from io import BytesIO

fails: list[str] = []


def check(ok: bool, msg: str) -> bool:
    if not ok:
        fails.append(msg)
    return ok


# ---------------------------------------------------------------- 模板

# 三行数据，**第二行的金额故意缺失**（`null`）—— 用来验「空值不是 0」。
# 分组汇总报表最常见的形状：A3 地区纵向展开，B3 金额挂在 A3 下。
# 图表格放在 D3，引用模板坐标 A3（类目）与 B3（数值）。
TEMPLATE = {
    "sheets": [
        {
            "name": "图表示例",
            "rows": [
                {
                    "cells": [
                        {
                            "pos": "A3",
                            "model": {
                                "ds": "ds1",
                                "field": "region",
                                "expand_type": "r",
                            },
                        },
                        {
                            "pos": "B3",
                            "model": {
                                "ds": "ds1",
                                "field": "amount",
                                "row_parent": "A3",
                            },
                        },
                        {},
                        {
                            "pos": "D3",
                            "chart": {
                                "kind": "bar",
                                "categories": ["A3"],
                                "series": [{"name": "销售额", "from": "B3"}],
                                "title": "各地区销售额",
                            },
                        },
                    ]
                }
            ],
        }
    ],
    "datasets": {
        "ds1": [
            {"region": "华东", "amount": 1200},
            {"region": "华北"},  # 金额缺失 → 空档
            {"region": "华南", "amount": 1530.5},
        ]
    },
}


def post(path: str, payload: dict, raw: bool = False):
    req = urllib.request.Request(
        path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        return body if raw else json.loads(body)


# ---------------------------------------------------------------- XML 小工具


def text_of(xml: str, tag: str) -> list[str]:
    """取某个标签的全部文本内容（不带命名空间前缀的宽松匹配）"""
    return re.findall(rf"<(?:\w+:)?{tag}[^>]*>(.*?)</(?:\w+:)?{tag}>", xml, re.S)


def chart_type_tags(chart_xml: str) -> list[str]:
    """chart XML 里出现的图表类型元素名，如 ['barChart']（排除外层的 `<c:chart>` 容器）"""
    return [t for t in re.findall(r"<c:(\w*[Cc]hart)>", chart_xml) if t != "chart"]


def series_formulas(chart_xml: str) -> list[str]:
    """所有 `<c:f>` 引用（序列名 / 类目 / 数值各一条）"""
    return [t for t in text_of(chart_xml, "f")]


def cached_points(chart_xml: str, section: str) -> list[tuple[int, str]]:
    """
    取某个区块（`cat` / `val`）里的缓存点：[(idx, 值文本)]。

    `section` 用 `<c:cat>` / `<c:val>` 定位，再在**那一段**里找 `<c:pt>`，
    否则 cat 和 val 的点会混在一起。
    """
    m = re.search(rf"<c:{section}>.*?</c:{section}>", chart_xml, re.S)
    if not m:
        return []
    out = []
    for pt in re.findall(r"<c:pt\b[^>]*>.*?</c:pt>", m.group(0), re.S):
        idx = re.search(r'idx="(\d+)"', pt)
        v = re.search(r"<c:v>(.*?)</c:v>", pt, re.S)
        if idx:
            out.append((int(idx.group(1)), v.group(1) if v else ""))
    return sorted(out)


def hidden_cols(sheet_xml: str) -> set[int]:
    """被隐藏的列号（0 基）"""
    out: set[int] = set()
    m = re.search(r"<cols>(.*?)</cols>", sheet_xml, re.S)
    if not m:
        return out
    for col in re.findall(r"<col\b[^>]*/>", m.group(1)):
        if 'hidden="1"' not in col and 'hidden="true"' not in col:
            continue
        lo = int(re.search(r'min="(\d+)"', col).group(1))
        hi = int(re.search(r'max="(\d+)"', col).group(1))
        for c in range(lo, hi + 1):
            out.add(c - 1)
    return out


def cell_texts(sheet_xml: str, shared: list[str]) -> dict[tuple[int, int], str]:
    """
    (行, 列) → 文本（0 基）。只认内联串与 sharedStrings，数字取原样。

    ⚠️ 必须同时认「自闭合」的格子：`<c r="C3" s="2"/>` 是**空**格，
    但它在 XML 里长得像一个开标签。只写 `<c ...>(.*?)</c>` 的话，正则会把
    这个空格一路吞到**下一个** `</c>`，把别人（比如数据块表头）的文本算到自己头上
    —— 结果是「表头读不到、空格读到了别人的值」，看起来像产品坏了。
    真踩过：`G5` 的「销售额」被记成了 `C3` 的文本。
    """
    out: dict[tuple[int, int], str] = {}
    for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', sheet_xml, re.S):
        col_letters, row_s, attrs, inner = m.groups()
        inner = inner or ""  # 自闭合 → 没有内容
        col = 0
        for ch in col_letters:
            col = col * 26 + (ord(ch) - 64)
        col -= 1
        row = int(row_s) - 1
        if 't="s"' in attrs:
            idx = re.search(r"<v>(\d+)</v>", inner)
            out[(row, col)] = shared[int(idx.group(1))] if idx else ""
        else:
            v = re.search(r"<v>(.*?)</v>", inner, re.S)
            out[(row, col)] = v.group(1) if v else ""
    return out


def shared_strings(z: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    xml = z.read("xl/sharedStrings.xml").decode("utf-8")
    return [re.sub(r"<.*?>", "", si) for si in text_of(xml, "si")]


def drawing_anchors(drawing_xml: str) -> list[tuple[int, int]]:
    """图表的锚点 (行, 列)（0 基）"""
    out = []
    for m in re.finditer(r"<xdr:from>(.*?)</xdr:from>", drawing_xml, re.S):
        seg = m.group(1)
        r = re.search(r"<xdr:row>(\d+)</xdr:row>", seg)
        c = re.search(r"<xdr:col>(\d+)</xdr:col>", seg)
        if r and c:
            out.append((int(r.group(1)), int(c.group(1))))
    return out


def col_letter(idx: int) -> str:
    s = ""
    n = idx
    while True:
        s = chr(ord("A") + n % 26) + s
        if n < 26:
            break
        n = n // 26 - 1
    return s


# ---------------------------------------------------------------- 主流程


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18888)
    ap.add_argument("--dump", action="store_true", help="打印 chart / sheet XML 便于对锚点")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    # ---- 1. xlsx 导出 ----
    try:
        blob = post(f"{base}/api/report/xlsx", {"template": TEMPLATE}, raw=True)
    except Exception as e:  # noqa: BLE001
        print(f"✗ 导出请求失败：{e}")
        return 1
    check(blob[:2] == b"PK", "导出物应当是 zip（以 PK 开头）")

    z = zipfile.ZipFile(BytesIO(blob))
    names = z.namelist()
    if args.dump:
        print("== zip 条目 ==")
        for n in names:
            print("  ", n)

    # ---- 2. 图表确实被嵌进去了 ----
    chart_names = [n for n in names if re.match(r"xl/charts/chart\d+\.xml$", n)]
    if not check(len(chart_names) == 1, f"应当嵌 1 个图表，实际 {len(chart_names)} 个：{chart_names}"):
        print("✗ 图表没被嵌进去 —— 后面的检查无从谈起")
        for f in fails:
            print("  -", f)
        return 1

    chart_xml = z.read(chart_names[0]).decode("utf-8")
    drawing_names = [n for n in names if re.match(r"xl/drawings/drawing\d+\.xml$", n)]
    drawing_xml = z.read(drawing_names[0]).decode("utf-8") if drawing_names else ""
    sheet_xml = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    shared = shared_strings(z)

    if args.dump:
        print("\n== chart1.xml ==")
        print(chart_xml)
        print("\n== drawing1.xml ==")
        print(drawing_xml)

    # ---- 3. 图表类型 ----
    kinds = chart_type_tags(chart_xml)
    check("barChart" in kinds, f"kind=bar 应当出 <c:barChart>，实际 {kinds}")

    # ---- 4. 数据块的位置与内容 ----
    # 布局（0 基）：数据 3 行 → 数据块从第 4 行开始（空一行），表头在 4，数据在 5..7。
    # 表格占 A..D 四列 → 数据块从 F 列（5）开始：F=类目，G=数值。
    HELPER_COL = 4 + 1          # 表格 4 列 + 空 1 列
    HEAD_ROW = 3 + 1            # 数据 3 行 + 空 1 行
    DATA0, DATA1 = HEAD_ROW + 1, HEAD_ROW + 3

    texts = cell_texts(sheet_xml, shared)
    cats = [texts.get((r, HELPER_COL), "") for r in range(DATA0, DATA1 + 1)]
    vals = [texts.get((r, HELPER_COL + 1), "") for r in range(DATA0, DATA1 + 1)]
    header = texts.get((HEAD_ROW, HELPER_COL + 1), "")

    check(cats == ["华东", "华北", "华南"], f"数据块类目列应为 华东/华北/华南，实际 {cats}")
    check(header == "销售额", f"数据块表头应当是序列名「销售额」，实际 {header!r}")
    # 缺测那格**必须真的空着**：写 0 就是撒谎
    check(vals[1] == "", f"缺失的金额必须留空（不许补 0），实际 {vals[1]!r}")
    check(vals[0] == "1200", f"第 1 个值应是 1200，实际 {vals[0]!r}")
    check(vals[2].startswith("1530.5"), f"第 3 个值应是 1530.5，实际 {vals[2]!r}")

    # ---- 5. 数据块是隐藏列 ----
    hid = hidden_cols(sheet_xml)
    check(
        HELPER_COL in hid and HELPER_COL + 1 in hid,
        f"数据块那两列应当隐藏（hidden=1），实际隐藏列 {sorted(hid)}",
    )

    # ---- 6. 序列引用指对了格子 ----
    refs = series_formulas(chart_xml)
    want_cat_ref = f"${col_letter(HELPER_COL)}${DATA0 + 1}:${col_letter(HELPER_COL)}${DATA1 + 1}"
    want_val_ref = (
        f"${col_letter(HELPER_COL + 1)}${DATA0 + 1}:${col_letter(HELPER_COL + 1)}${DATA1 + 1}"
    )
    check(
        any(r.endswith(want_cat_ref) for r in refs),
        f"类目引用应当是 {want_cat_ref}，实际 {refs}",
    )
    check(
        any(r.endswith(want_val_ref) for r in refs),
        f"数值引用应当是 {want_val_ref}，实际 {refs}",
    )

    # ---- 7. 缓存数值：顺序与缺测 ----
    cpts = cached_points(chart_xml, "cat")
    vpts = cached_points(chart_xml, "val")
    check([t for _, t in cpts] == ["华东", "华北", "华南"], f"类目缓存顺序不对：{cpts}")
    check([t for _, t in vpts] == ["1200", "1530.5"],
          f"数值缓存应当是 1200 / 1530.5（缺测那点**不出现**，不是 0）：{vpts}")
    check([i for i, _ in vpts] == [0, 2], f"缺测那点应当整个缺席（idx 0,2），实际 {vpts}")

    # ---- 8. 标题 ----
    check("各地区销售额" in chart_xml, "图表标题没进 chart XML")

    # ---- 9. 锚点在图表格那一格（D3 → 0 基 row0, col3）----
    anchors = drawing_anchors(drawing_xml)
    check((0, 3) in anchors, f"图表应当锚在 D3（0 基 0,3），实际锚点 {anchors}")

    # ---- 10. 图表格本身不写文本（否则会跟浮在上面的图打架）----
    check("[图表:" not in "".join(texts.values()), "正常图表不该出现 [图表: ...] 的失败文案")
    check("[图表:" not in "".join(shared), "失败文案不该进 sharedStrings")

    # ---- 11. HTML 预览要出内联 SVG ----
    try:
        resp = post(f"{base}/api/report/render", {"template": TEMPLATE})
    except Exception as e:  # noqa: BLE001
        check(False, f"render 请求失败：{e}")
        resp = {}
    html = resp.get("html", "")
    check("<svg " in html, "HTML 预览应当出内联 SVG")
    check("华东" in html and "华北" in html, "类目名要画进 SVG 里")
    check("各地区销售额" in html, "标题要画进 SVG 里")
    check(html.count("<svg ") == 1, f"应当恰好 1 张图，实际 {html.count('<svg ')}")
    # 单序列不画图例 → SVG 里的 <rect> 就只有柱子。
    # 3 个类目里第 2 个缺测 → **只能有 2 根柱子**（补 0 的话会画出 3 根）。
    bars = html.count("<rect ")
    check(bars == 2, f"应当只有 2 根柱子（缺测那根不画），实际 {bars} 个 <rect>")

    # ---- 12. 网格 JSON 里带的是**解析好的数据**（预览侧直接用，不必再解析坐标）----
    grid_chart = None
    for row in resp.get("sheets", [{}])[0].get("rows", []):
        for cell in row:
            if cell.get("chart"):
                grid_chart = cell["chart"]
    if check(grid_chart is not None, "渲染结果的格子里应当带 chart 字段"):
        check(grid_chart["kind"] == "bar", f"kind 应当是 bar，实际 {grid_chart.get('kind')}")
        check(grid_chart["categories"] == ["华东", "华北", "华南"],
              f"类目应当是三个地区，实际 {grid_chart.get('categories')}")
        check(grid_chart["series"][0]["data"] == [1200, None, 1530.5],
              f"数值应当是 [1200, null, 1530.5]，实际 {grid_chart['series'][0]['data']}")

    if fails:
        print(f"✗ {len(fails)} 项不符合：")
        for f in fails:
            print("  -", f)
        print(f"\n  数据块类目 {cats}  数值 {vals}  表头 {header!r}")
        print(f"  隐藏列 {sorted(hid)}  引用 {refs}  锚点 {anchors}")
        return 1

    print("✓ 全部通过")
    print(f"  图表类型 {kinds}  锚点 {anchors}")
    print(f"  数据块 {col_letter(HELPER_COL)}..{col_letter(HELPER_COL + 1)}"
          f" 行 {DATA0 + 1}..{DATA1 + 1}（隐藏列 {sorted(hid)}）")
    print(f"  类目 {cats}  数值 {vals}")
    print(f"  引用 {refs}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
