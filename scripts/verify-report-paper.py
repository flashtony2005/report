#!/usr/bin/env python3
"""报表页面设置（纸张 / 方向 / 页边距 / 页码 / 居中）的真机探针。

为什么单测不够（本仓库反复踩的那一类）：

1. **xlsx 是 zip，`xl/worksheets/sheetN.xml` 是 deflate 过的** —— Rust 单测在
   `to_xlsx` 的返回值里搜不到 `paperSize` / `oddFooter` / `pageMargins` 的**内容**
   （只能搜到 zip 中央目录里没压缩的**文件名**）。所以「纸设对了没有」只能拆包读 XML。
   单测那边只守到「走一遍不报错、纸张名映射不到码时报错」为止。
2. **HTML 与 xlsx 是两套口径**，最容易出的错是「两边不一致」：
   `@page` 是**文档级**规则（一篇 HTML 只能一份纸张设置），而 xlsx 是每 sheet 一份。
   这个脚本把同一份配置**两边都读一遍**，专抓「一边对一边不对」。
3. 页边距有两个静默坑，肉眼看不出来，只能量：
   - **单位**：HTML 用 mm、xlsx 的 `set_margins` 用**英寸**（差 25.4 倍）；
   - **参数顺序**：xlsx 是 `left, right, top, bottom, header, footer`（6 个！），
     HTML 的 CSS 简写是 `top right bottom left`。顺序写反了打出来才知道。
   所以四边刻意给**四个互不相同**的值，逐边对账。
4. Excel 页脚码：`{page}` → `&P`、`{pages}` → `&N`，而字面量 `&` 要写成 `&&`。
   转义与替换**顺序反了**就会印出字面量「&P」—— 导出成功、没有报错，只是页码变乱码。

用法（先起服务）：
    cd print-server && ~/.cargo/target/debug/print-server &
    python3 scripts/verify-report-paper.py
    python3 scripts/verify-report-paper.py --dump     # 打印 sheet XML 与 HTML 片段

退出码：0 = 全部符合；1 = 有不符合（并打印差在哪）。
"""
import argparse
import io
import json
import re
import sys
import urllib.error
import urllib.request
import zipfile

SERVER = "http://127.0.0.1:18888"
MM_PER_INCH = 25.4

# ⚠️ 沙箱里 `HTTP_PROXY` / `http_proxy` 指向本地代理，探 127.0.0.1 会被它拦成
# **502 Bad Gateway**（看着像服务没起来，其实服务好好的）。所以显式清空代理。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

fails: list[str] = []
dumps: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        fails.append(msg)


def http(path: str, body=None, method: str | None = None) -> tuple[int, bytes]:
    """返回 (状态码, 响应体)。4xx/5xx 也照常返回，不抛异常 —— 错误路径也要断言。"""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        SERVER + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method or ("POST" if body is not None else "GET"),
    )
    try:
        with _OPENER.open(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def render(page: dict | None, sheet_name: str | None = None) -> tuple[int, dict]:
    """拿样例模板，把 sheet[0].page 换成给定配置，渲染一次。"""
    st, body = http("/api/report/sample-template")
    assert st == 200, f"取样例模板失败：{st} {body[:200]!r}"
    tpl = json.loads(body)
    if sheet_name is not None:
        tpl["sheets"][0]["name"] = sheet_name
    tpl["sheets"][0]["page"] = page
    st, body = http("/api/report/render", {"template": tpl, "datasets": None, "sources": None, "dump": None})
    if st != 200:
        return st, {"error": body.decode("utf8", "ignore")}
    return st, json.loads(body)


def xlsx(page: dict | None) -> tuple[int, list[str]]:
    """导出 xlsx 并拆出每张 sheet 的 XML。"""
    st, body = http("/api/report/sample-template")
    tpl = json.loads(body)
    tpl["sheets"][0]["page"] = page
    st, buf = http("/api/report/xlsx", {"template": tpl, "datasets": None, "sources": None, "dump": None})
    if st != 200:
        return st, []
    z = zipfile.ZipFile(io.BytesIO(buf))
    names = sorted(
        n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)
    )
    return st, [z.read(n).decode("utf8", "ignore") for n in names]


def xlsx_workbook(page: dict | None) -> tuple[int, str]:
    """导出 xlsx 并取出 `xl/workbook.xml`。

    **为什么单开一个函数**：重复表头（`_xlnm.Print_Titles`）**不在 sheetN.xml 里**，
    它写在 workbook.xml 的 `definedNames` 里 —— 只用上面那个 `xlsx()` 是验不到的，
    这正是 `case_page_setup_does_not_drop_repeat_rows` 存在的理由。
    """
    st, body = http("/api/report/sample-template")
    tpl = json.loads(body)
    tpl["sheets"][0]["page"] = page
    st, buf = http(
        "/api/report/xlsx", {"template": tpl, "datasets": None, "sources": None, "dump": None}
    )
    if st != 200:
        return st, ""
    z = zipfile.ZipFile(io.BytesIO(buf))
    return st, z.read("xl/workbook.xml").decode("utf8", "ignore")


def print_title_ranges(wb: str) -> list[str]:
    """`_xlnm.Print_Titles` 的行范围（如 `$1:$2`），每张 sheet 一条。

    注意 sheet 名会被 Excel 规则清洗（`销售分组汇总 (1/1)` 里的 `/` 是非法字符，
    写出去变成 `销售分组汇总 (11)`）—— 所以只取 `!` 后面的范围，不比对表名。
    """
    return re.findall(
        r'name="_xlnm\.Print_Titles"[^>]*>[^<]*!(\$[\d]+:\$[\d]+)</definedName>', wb
    )


def margins_of(xml: str) -> dict[str, float]:
    m = re.search(r"<pageMargins\b([^>]*)/>", xml)
    if not m:
        return {}
    return {k: float(v) for k, v in re.findall(r'(\w+)="([\d.]+)"', m.group(1))}


def approx(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


# --------------------------------------------------------------------------- #
# 用例
# --------------------------------------------------------------------------- #

def case_baseline() -> None:
    """没配页面设置 —— 这是「老模板输出逐字节不变」的守门人。"""
    st, resp = render(None)
    check(st == 200, f"基准渲染失败：{st} {resp.get('error')}")
    html = resp.get("html", "")
    check("@page" not in html, "没配页面设置却吐了 @page —— 既有模板的打印版面会被改掉")
    check("margin-top:auto" not in html, "没配页码却加了页码包装 div")

    st, xmls = xlsx(None)
    check(st == 200, f"基准导出失败：{st}")
    check(len(xmls) == 1, f"不分页应当只有 1 张 sheet，实际 {len(xmls)}")
    if xmls:
        xml = xmls[0]
        check("paperSize" not in xml, "没配纸张却写了 paperSize（应听打印机的）")
        check("<oddFooter" not in xml, "没配页码却写了 oddFooter")
        check("horizontalCentered" not in xml, "没配居中却写了 horizontalCentered")
        # pageMargins 是**无条件**写的（crate 的行为），所以这里断言的是**取值等于 Excel 默认**
        mg = margins_of(xml)
        check(
            approx(mg.get("left", -1), 0.7)
            and approx(mg.get("right", -1), 0.7)
            and approx(mg.get("top", -1), 0.75)
            and approx(mg.get("bottom", -1), 0.75)
            and approx(mg.get("header", -1), 0.3)
            and approx(mg.get("footer", -1), 0.3),
            f"没配页边距时应当就是 Excel 默认（左右 0.7 / 上下 0.75 / 页眉脚 0.3），实际 {mg}",
        )
        dumps.append(("baseline sheet1.xml", xml))


def case_a4_portrait_full() -> None:
    """A4 纵向 + 四边互不相同的页边距 + 页码 + 居中 + 真分页。"""
    page = {
        "rows_per_page": 10,
        "repeat_header_rows": 2,
        "repeat_footer_rows": 0,
        "paper": "A4",
        "orientation": "portrait",
        # 四边**刻意各不相同**：顺序写反（CSS 是 top/right/bottom/left、
        # xlsx 是 left/right/top/bottom）会立刻被抓到
        "margin_mm": {"top": 10.0, "right": 8.0, "bottom": 12.0, "left": 6.0},
        "page_number": "第 {page} / {pages} 页",
        "center_horizontally": True,
    }
    st, resp = render(page)
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    html = resp.get("html", "")
    check(
        "@page{size:210.00mm 297.00mm;margin:10.00mm 8.00mm 12.00mm 6.00mm}" in html,
        f"A4 纵向的 @page 不对（注意 CSS 简写是 上/右/下/左）：{[l for l in html.splitlines() if '@page' in l]}",
    )
    check("margin-left:auto" in html, "配了居中却没有 margin-left:auto")

    # 页码：分页时逐页 HTML 里印真实数字
    pages_html = resp.get("pages_html") or []
    check(len(pages_html) == 3, f"样例表应切成 3 页，实际 {len(pages_html)}")
    for i, h in enumerate(pages_html):
        check(f"第 {i + 1} / 3 页" in h, f"第 {i + 1} 页没印出「第 {i + 1} / 3 页」")
    check("页码" not in "\n".join(resp.get("warnings") or []), "真印出来了却还在告警")

    st, xmls = xlsx(page)
    check(st == 200, f"导出失败：{st}")
    check(len(xmls) == 3, f"分页导出应当每页一张 sheet，实际 {len(xmls)}")
    for i, xml in enumerate(xmls):
        check('paperSize="9"' in xml, f"sheet{i + 1} 缺 paperSize=9（A4）")
        check('orientation="portrait"' in xml, f"sheet{i + 1} 方向不是 portrait")
        mg = margins_of(xml)
        want = {"left": 6.0, "right": 8.0, "top": 10.0, "bottom": 12.0}
        for k, mm in want.items():
            check(
                approx(mg.get(k, -1), mm / MM_PER_INCH, 1e-9),
                f"sheet{i + 1} 的 {k} 边距不对：期望 {mm}mm = {mm / MM_PER_INCH}in，实际 {mg.get(k)}"
                "（xlsx 的 set_margins 收**英寸**，且顺序是 left/right/top/bottom）",
            )
        check(
            approx(mg.get("header", -1), 0.3) and approx(mg.get("footer", -1), 0.3),
            f"sheet{i + 1} 的页眉/页脚距离该保持 Excel 默认 0.3，实际 {mg.get('header')}/{mg.get('footer')}",
        )
        check(
            "<oddFooter>&amp;C第 &amp;P / &amp;N 页</oddFooter>" in xml,
            f"sheet{i + 1} 的页脚不对：{re.findall(r'<oddFooter>.*?</oddFooter>', xml)}"
            "（{page}→&P、{pages}→&N）",
        )
        check('horizontalCentered="1"' in xml, f"sheet{i + 1} 缺 horizontalCentered")
    if xmls:
        dumps.append(("A4 sheet1.xml", xmls[0]))


def case_a3_landscape() -> None:
    """A3 横向 —— 宽高要换、纸张码是 8。"""
    st, resp = render({"paper": "A3", "orientation": "landscape"})
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    html = resp.get("html", "")
    check("@page{size:420.00mm 297.00mm}" in html, f"A3 横向的 @page 不对：{[l for l in html.splitlines() if '@page' in l]}")

    st, xmls = xlsx({"paper": "A3", "orientation": "landscape"})
    check(st == 200, f"导出失败：{st}")
    if xmls:
        check('paperSize="8"' in xmls[0], "A3 应当是纸张码 8")
        check('orientation="landscape"' in xmls[0], "没写成横向")


def case_orientation_without_paper() -> None:
    """只写方向、不写纸张 —— 两边都**不许**替作者选一张纸。"""
    st, resp = render({"orientation": "landscape"})
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    html = resp.get("html", "")
    check("@page{size:landscape}" in html, f"应当用 CSS 的裸 landscape 关键字：{[l for l in html.splitlines() if '@page' in l]}")
    check("mm" not in html.split("@page")[1].split("}")[0], "不许替作者把纸钉成 A4")

    st, xmls = xlsx({"orientation": "landscape"})
    check(st == 200, f"导出失败：{st}")
    if xmls:
        check('orientation="landscape"' in xmls[0], "没写成横向")
        check("paperSize" not in xmls[0], "没写纸张却替作者选了（应当听打印机的）")


def case_b5_is_jis() -> None:
    """B5 的口径钉子：ISO 176×250 与 JIS 182×257 是两个纸，
    Excel 的码 13（界面上写「B5」）是 **JIS** 那个。两边必须同口径。"""
    st, resp = render({"paper": "B5"})
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    html = resp.get("html", "")
    check("@page{size:182.00mm 257.00mm}" in html, f"B5 应当是 JIS 182×257：{[l for l in html.splitlines() if '@page' in l]}")

    st, xmls = xlsx({"paper": "B5"})
    check(st == 200, f"导出失败：{st}")
    if xmls:
        check('paperSize="13"' in xmls[0], "B5 应当是 Excel 码 13（JIS）")


def case_paper_name_is_case_insensitive() -> None:
    """纸张名**大小写不敏感、前后空白不算数** —— 服务端 `paper_mm` 用的是
    `n.eq_ignore_ascii_case(name.trim())`。

    这条是**跨端契约**的实物证据：设计器的预检（`pageSetupProblem`）必须与服务端
    同口径，否则 `"a4"` 会被设计器拦下、而服务端照样编得出来 —— 预检**误报**，
    比不报更烦人（设计器放行、服务端 400 是另一种，同样坏）。
    Rust 侧有单测 `paper_lookup_is_case_insensitive_and_trims` 钉这个事实，
    但那条只证明函数本身；这里证明的是**整条渲染链路**都认小写。
    """
    for name in ["a4", "  A4  ", "legal"]:
        st, resp = render({"paper": name})
        check(st == 200, f"纸张「{name}」应当被接受，实际 {st} {resp.get('error')}")
        html = resp.get("html", "")
        want_mm = "210.00mm 297.00mm" if "4" in name else "215.90mm 355.60mm"
        check(
            f"@page{{size:{want_mm}}}" in html,
            f"纸张「{name}」的尺寸不对：{[l for l in html.splitlines() if '@page' in l]}",
        )

        st, xmls = xlsx({"paper": name})
        check(st == 200, f"纸张「{name}」导出失败：{st}")
        if xmls:
            want_id = 'paperSize="9"' if "4" in name else 'paperSize="5"'
            check(want_id in xmls[0], f"纸张「{name}」的 Excel 码不对：期望 {want_id}")


def case_page_setup_does_not_drop_repeat_rows() -> None:
    """**只配纸张不能把重复表头挤掉** —— 「页面设置 × 分页」的交叉点。

    `page` 变成 `Some` 的原因**不止分页**：页面设置也挂在同一个 `PageConfig` 上，
    而那时 `repeat_header_rows` 是 0（作者根本没填）。不判「分页是否真开」就取它，
    会把「预览 2 行表头」**静默**变成「导出 1 行」—— 界面上完全看不出来。
    （单测 `xlsx_header_rows_ignores_page_setup_without_pagination` 守的是纯函数；
    这里守的是**整条导出链路真的这么做了**。）

    ⚠️ 重复表头写在 `xl/workbook.xml` 的 `definedNames` 里、**不在 sheetN.xml**，
    所以这条必须读 workbook.xml —— 这正是它存在的理由。
    """
    st, wb = xlsx_workbook(None)
    check(st == 200, f"导出失败：{st}")
    base = print_title_ranges(wb)
    check(base == ["$1:$2"], f"基线（没配页面设置）的重复表头应当是 $1:$2，实际 {base}")

    st, wb = xlsx_workbook({"paper": "A3"})
    check(st == 200, f"导出失败：{st}")
    got = print_title_ranges(wb)
    check(
        got == base,
        f"只配了纸张（没开分页）就把重复表头挤掉了：{got}，期望 {base}（= 与不配页面设置时一致）",
    )


def case_page_number_without_pagination() -> None:
    """**HTML 印不出、xlsx 照印** —— 这是刻意的不对称，要守住两边各自的行为。

    `rows_per_page = 0` 时 `paginate` 原样返回一整页，服务端**不知道**浏览器会切成几页，
    印「第 1 / 1 页」是错的；而 xlsx 用的是 Excel 原生页脚，Excel 自己知道共几页。
    """
    st, resp = render({"page_number": "第 {page} / {pages} 页"})
    check(st == 200, f"渲染失败：{st} {resp.get('error')}")
    for h in resp.get("pages_html") or []:
        check("页" not in h, f"没真分页却印了页码（印个错的比不印更坏）：{h[:200]}")
    w = "\n".join(resp.get("warnings") or [])
    check("页码" in w and "rows_per_page" in w, f"应当告警说明是 rows_per_page 没开，实际告警：{w!r}")

    st, xmls = xlsx({"page_number": "第 {page} / {pages} 页"})
    check(st == 200, f"导出失败：{st}")
    if xmls:
        check(
            "<oddFooter>&amp;C第 &amp;P / &amp;N 页</oddFooter>" in xmls[0],
            "xlsx 侧不受分页影响，页脚该在（Excel 原生页脚）",
        )


def case_ampersand_is_escaped() -> None:
    """字面量 `&` 必须翻倍成 `&&`，否则页脚印出来是错的。

    这条同时守「转义与替换的**顺序**」：先替换再转义的话，`&P` 会被翻成 `&&P`，
    页脚就印出字面量「&P」—— 导出成功、没有报错，只是页码变成乱码。
    """
    st, xmls = xlsx({"page_number": "A&B 第 {page} 页"})
    check(st == 200, f"导出失败：{st}")
    if xmls:
        got = re.findall(r"<oddFooter>.*?</oddFooter>", xmls[0])
        # 页脚串是 `&C` + `A&&B 第 &P 页`，XML 转义后 `&` → `&amp;`
        want = ["<oddFooter>&amp;CA&amp;&amp;B 第 &amp;P 页</oddFooter>"]
        check(got == want, f"`&` 的转义/顺序不对：{got}，期望 {want}")


def case_saved_report_keeps_page_setup() -> None:
    """**设计器走的那条路**：存报表 → 打开即执行（`PUT /api/reports/:id` → `POST …/run`）。

    这条专抓「`apply_options` 把模板里的页面设置抹掉」：
    设计器读的是**存盘文件**（纸张还在，看着完全正常），跑的是套过 `options` 的模板。
    两边不一致、屏幕上又看不出来 —— 所以断言必须落在 **run 的结果**上，
    只断言「存盘文件里有 paper」是抓不到的。

    （会在报表目录留一个 `probe-paper-tmp.json`，跑完即删。）
    """
    st, body = http("/api/report/sample-template")
    check(st == 200, f"取样例模板失败：{st}")
    tpl = json.loads(body)
    tpl["sheets"][0]["page"] = {
        "rows_per_page": 10,
        "repeat_header_rows": 2,
        "repeat_footer_rows": 0,
        "paper": "A3",
        "orientation": "landscape",
        "margin_mm": {"top": 7.0, "right": 7.0, "bottom": 7.0, "left": 7.0},
        "page_number": "第 {page} / {pages} 页",
    }
    rid = "probe-paper-tmp"
    st, body = http(
        # ⚠️ 存盘路径是 `/api/reports/save`（不是 `/api/reports/:id`，那条只挂 GET/DELETE）
        "/api/reports/save",
        {
            "format": "openprint.report",
            "version": 1,
            "id": rid,
            "name": "探针临时报表",
            "template": tpl,
            # options 只带分页三项 —— 与设计器保存时一样（页面设置不在 options 里）
            "options": {"rowsPerPage": 20, "repeatHeaderRows": 3},
        },
        method="PUT",
    )
    check(st == 200, f"存报表失败：{st} {body[:200]!r}")
    try:
        st, body = http(f"/api/reports/{rid}/run", {})
        check(st == 200, f"执行报表失败：{st} {body[:300]!r}")
        resp = json.loads(body)
        html = resp.get("html", "")
        check(
            "@page{size:420.00mm 297.00mm;margin:7.00mm 7.00mm 7.00mm 7.00mm}" in html,
            "套过 options 之后页面设置丢了（存盘文件里有、跑出来没有）："
            f"{[l for l in html.splitlines() if '@page' in l]}",
        )
        # options 的分页要生效：20 行一页 → 23 行的样例表正好 1 页
        pages_html = resp.get("pages_html") or []
        check(len(pages_html) == 1, f"options 的 rowsPerPage=20 应当切 1 页，实际 {len(pages_html)}")
        check(
            bool(pages_html) and "第 1 / 1 页" in pages_html[0],
            f"页码丢了：{pages_html[:1]}",
        )
    finally:
        st, _ = http(f"/api/reports/{rid}", method="DELETE")
        check(st == 200, f"清理临时报表失败：{st}（报表目录里会留下 {rid}.json）")


def case_two_sheets() -> None:
    """两张 sheet：页码**各算各的**，纸张不一致要告警。

    单张表看不出「页码用了扁平下标」——那时候扁平下标恰好等于表内页码
    （`fault-inject-report-paper.py` 的 #7 就是这么漏过去的）。这里补上多表。
    """
    st, body = http("/api/report/sample-template")
    check(st == 200, f"取样例模板失败：{st}")
    tpl = json.loads(body)
    import copy

    tpl["sheets"].append(copy.deepcopy(tpl["sheets"][0]))
    for i, nm in enumerate(("甲", "乙")):
        tpl["sheets"][i]["name"] = nm
        tpl["sheets"][i]["page"] = {
            "rows_per_page": 10,
            "repeat_header_rows": 2,
            "repeat_footer_rows": 0,
            "paper": "A4",
            "page_number": "第 {page} / {pages} 页",
        }
    st, body = http("/api/report/render", {"template": tpl, "datasets": None, "sources": None, "dump": None})
    check(st == 200, f"渲染失败：{st} {body[:200]!r}")
    resp = json.loads(body)
    h = resp.get("pages_html") or []
    check(len(h) == 6, f"两张表各 3 页，应当 6 页，实际 {len(h)}")
    if len(h) == 6:
        check("第 1 / 3 页" in h[0] and "第 3 / 3 页" in h[2], "甲表页码不对")
        # 关键：乙表首页是「第 1 页」，不是扁平下标算出来的「第 4 页」
        check("第 1 / 3 页" in h[3], f"乙表首页页码错了（用了扁平下标？）：{h[3][:200]}")
        check("第 4" not in h[3], "用了扁平下标：乙表首页印成第 4 页")
    check("不一致" not in "\n".join(resp.get("warnings") or []), "两张表纸张相同，不该告警")

    # 纸张不一致 → 告警（`@page` 是文档级规则，一篇 HTML 只能表达一份）
    tpl["sheets"][1]["page"]["paper"] = "A3"
    st, body = http("/api/report/render", {"template": tpl, "datasets": None, "sources": None, "dump": None})
    check(st == 200, f"渲染失败：{st}")
    w = "\n".join(json.loads(body).get("warnings") or [])
    check("不一致" in w, f"两张表纸张不同（A4 / A3）应当告警，实际告警：{w!r}")


def case_errors() -> None:
    """错误路径：认不出的纸张 / 占位符要**报 400 并点名**，不许静默回落。"""
    for bad, needle in [
        ({"paper": "A6"}, "A6"),
        ({"paper": "A4", "orientation": "sideways"}, "sideways"),
        ({"page_number": "第 {pge} 页"}, "pge"),
        ({"page_number": "第 {page 页"}, "闭合"),
        ({"paper": "A4", "margin_mm": {"top": 0, "right": 120, "bottom": 0, "left": 120}}, "空白"),
    ]:
        st, resp = render(bad)
        check(st == 400, f"非法配置 {bad} 应当报 400，实际 {st} {resp.get('error')}")
        check(needle in resp.get("error", ""), f"错误文案里没点名「{needle}」：{resp.get('error')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true", help="打印 sheet XML / HTML 片段")
    args = ap.parse_args()

    for fn in (
        case_baseline,
        case_a4_portrait_full,
        case_a3_landscape,
        case_orientation_without_paper,
        case_b5_is_jis,
        case_paper_name_is_case_insensitive,
        case_page_setup_does_not_drop_repeat_rows,
        case_page_number_without_pagination,
        case_ampersand_is_escaped,
        case_saved_report_keeps_page_setup,
        case_two_sheets,
        case_errors,
    ):
        before = len(fails)
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            fails.append(f"{fn.__name__} 抛异常：{type(e).__name__}: {e}")
        mark = "✓" if len(fails) == before else "✗"
        print(f"{mark} {fn.__name__}")

    if args.dump:
        for title, text in dumps:
            print(f"\n--- {title} ---")
            print(text[:4000])

    if fails:
        print("\n✗ 不通过：")
        for e in fails:
            print("  -", e)
        return 1
    print("\n✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
