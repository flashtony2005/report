#!/usr/bin/env python3
"""Word 导出（`/api/report/docx`）的真机探针。

## 为什么必须有这个脚本

docx 的失败是**全有或全无**的：`[Content_Types].xml` 漏声明一个 part、
`<w:pPr>` 放在 `<w:r>` 之后、文本里混进 XML 1.0 不允许的控制字符 ——
Word 的反应不是「格式有点怪」，而是**整个文件报「不可读内容」**。

而这类错在 Rust 单测里**一条都看不见**：单测只能断言「写了 N 字节 / 没 panic / 含
某个子串」。真正读这个文件的是 **Word**，不是我的断言。所以必须用**另一个实现**
（Python 的 `zipfile` + `ElementTree`）把产物读回来。

## 它检查的四条不变量

1. **XML 良构** —— 每个 part 都能被解析（裸 `&`、非法控制字符会死在这里）
2. **part 闭合** —— zip 里每个 part 都在 `[Content_Types].xml` 里有条目
3. **r:id 闭合** —— 每个关系都指向**存在**的 part，没有悬空
4. **子元素顺序** —— 符合 ECMA-376 的 CT_* 内容模型（顺序表来自
   `docx-order-table.py`，**不是**我凭记忆写的）

外加 **内容回读**：把表格文本读回来，跟 `/api/report/render` 的结果逐格比对 ——
专抓「结构都对、但格子写错了」。

## 它**不**检查什么（别拿它冒充）

**真 Word 打不打得开、Pages 里的排版观感 —— 本机判不了**（没装 Word /
LibreOffice / WPS）。上面的四条只是「Word 会拒绝的那一类错」的**可判定子集**，
过了 ≠ Word 一定能开。

用法（先起服务）：
    cd print-server && ~/.cargo/target/debug/print-server &
    python3 scripts/verify-docx.py
    python3 scripts/verify-docx.py --dump      # 打印 document.xml

退出码：0 = 全部符合；1 = 有不符合（并打印差在哪）；2 = 服务没起来 / 判据缺失。
"""
import argparse
import io
import json
import re
import sys
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

SERVER = "http://127.0.0.1:18888"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

# ⚠️ 沙箱里 HTTP_PROXY 指向本地代理，探 127.0.0.1 会被拦成 502（看着像服务没起来）。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

fails: list[str] = []
dumps: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        fails.append(msg)


def http(path: str, body=None) -> tuple[int, bytes]:
    """4xx/5xx 也照常返回 —— 错误路径也要断言。"""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        SERVER + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    try:
        with _OPENER.open(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        return 0, str(e).encode()


def local(tag: str) -> str:
    """`{ns}pPr` → `pPr`"""
    return tag.rsplit("}", 1)[-1]


def w(tag: str) -> str:
    return f"{{{W}}}{tag}"


def docx_bytes(page: dict | None = None, sheet_name: str | None = None) -> tuple[int, bytes]:
    st, body = http("/api/report/sample-template")
    if st != 200:
        return st, body
    tpl = json.loads(body)
    if sheet_name is not None:
        tpl["sheets"][0]["name"] = sheet_name
    tpl["sheets"][0]["page"] = page
    return http("/api/report/docx", {"template": tpl, "datasets": None, "sources": None, "dump": None})


def order_table() -> dict[str, list[str]]:
    """从 `docx-order-table.py` 取顺序表。**判据缺失就退出 2**，不静默跳过 ——
    缺了判据还继续跑，等于这条检查是摆设。"""
    import subprocess
    p = subprocess.run(
        [sys.executable, "scripts/docx-order-table.py"],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        sys.exit(f"✗ 取不到顺序表：\n{p.stderr}")
    return json.loads(p.stdout)["顺序表"]


def ct_model_of(tag: str, table: dict) -> list[str] | None:
    """`w:pPr` → `CT_PPr` 的顺序表条目。"""
    name = local(tag)
    return table.get("CT_" + name[0].upper() + name[1:])


# ---------------------------------------------------------------- 用例

def case_server_is_up() -> None:
    st, body = http("/health")
    check(st == 200, f"/health 应返回 200，实际 {st} {body[:120]!r}")


def case_endpoint_returns_a_zip() -> None:
    st, buf = docx_bytes()
    check(st == 200, f"/api/report/docx 应返回 200，实际 {st} {buf[:200]!r}")
    if st != 200:
        return
    check(buf[:2] == b"PK", f"应是 zip（以 PK 开头），实际 {buf[:4]!r}")
    z = zipfile.ZipFile(io.BytesIO(buf))
    # testzip() 会逐个校验 CRC —— CRC 错了 Word 一样打不开
    bad = z.testzip()
    check(bad is None, f"zip 里有 CRC 校验失败的条目：{bad}")


def case_all_parts_are_declared_in_content_types() -> None:
    """part 闭合：zip 里每个 part 都必须在 [Content_Types].xml 里被声明。
    漏一个 → Word 直接报不可读内容。"""
    st, buf = docx_bytes()
    if st != 200:
        return
    z = zipfile.ZipFile(io.BytesIO(buf))
    names = [n for n in z.namelist() if not n.endswith("/")]
    check("[Content_Types].xml" in names, f"缺 [Content_Types].xml，实际 {names}")
    ct = ET.fromstring(z.read("[Content_Types].xml"))

    defaults = {
        d.get("Extension", "").lower()
        for d in ct.findall(f"{{{CT_NS}}}Default")
    }
    overrides = {o.get("PartName") for o in ct.findall(f"{{{CT_NS}}}Override")}

    for n in names:
        if n == "[Content_Types].xml":
            continue  # 它自己不用声明自己
        ext = n.rsplit(".", 1)[-1].lower() if "." in n else ""
        declared = ext in defaults or ("/" + n) in overrides
        check(declared, f"part `{n}` 在 [Content_Types].xml 里没有条目（Word 会拒收整个文件）")

    # ⚠️ 「有 Default 兜住」还不够：`Default Extension="xml"` 只能说明「这是个 XML」，
    # 说不出「这是**主文档**」。Word 是靠**这一条 Override** 认出正文的 —— 删了它，
    # 每个 part 仍然「有声明」，但 Word 打不开。所以单独钉一条。
    main = f"{{{CT_NS}}}Override[@PartName='/word/document.xml']"
    node = ct.find(main)
    check(node is not None, "[Content_Types].xml 里缺 /word/document.xml 的 Override（Word 认不出正文）")
    if node is not None:
        want = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
        check(
            node.get("ContentType") == want,
            f"/word/document.xml 的 ContentType 应是 {want}，实际 {node.get('ContentType')}",
        )


def case_every_part_is_well_formed_xml() -> None:
    """XML 良构：裸 `&`、非法控制字符、标签没闭合都会死在这里。"""
    st, buf = docx_bytes()
    if st != 200:
        return
    z = zipfile.ZipFile(io.BytesIO(buf))
    for n in z.namelist():
        raw = z.read(n)
        try:
            ET.fromstring(raw)
        except ET.ParseError as e:
            check(False, f"`{n}` 不是良构 XML：{e}")
    # 顺带：XML 1.0 不允许的控制字符（0x00、0x0C …）不能出现在任何 part 里
    for n in z.namelist():
        raw = z.read(n)
        illegal = sorted({b for b in raw if b < 0x20 and b not in (0x09, 0x0A, 0x0D)})
        check(not illegal, f"`{n}` 含 XML 1.0 不允许的控制字符：{[hex(b) for b in illegal]}")


def case_relationship_ids_resolve() -> None:
    """r:id 闭合：每个关系都要指向**存在**的 part，且关系文件本身要能解析。"""
    st, buf = docx_bytes()
    if st != 200:
        return
    z = zipfile.ZipFile(io.BytesIO(buf))
    names = set(z.namelist())

    def resolve(base: str, target: str) -> str:
        # 关系里的 Target 是**相对**包根的路径（不是相对关系文件）
        return target.lstrip("/")

    for rels in [n for n in names if n.endswith(".rels")]:
        root = ET.fromstring(z.read(rels))
        for rel in root.findall(f"{{{PKG_REL}}}Relationship"):
            rid = rel.get("Id")
            target = rel.get("Target")
            check(bool(rid), f"`{rels}` 里有个关系没有 Id")
            check(bool(target), f"`{rels}` 里关系 {rid} 没有 Target")
            if not target:
                continue
            # 外部链接（TargetMode="External"）不指向包内 part，跳过
            if rel.get("TargetMode") == "External":
                continue
            check(
                resolve(rels, target) in names,
                f"关系 {rid} 指向 `{target}`，但包里没有这个 part（悬空关系）",
            )

    # 主文档关系必须存在，否则 Word 找不到正文
    check("_rels/.rels" in names, "缺包级关系 _rels/.rels")
    if "_rels/.rels" in names:
        txt = z.read("_rels/.rels").decode("utf8", "ignore")
        check("officeDocument" in txt, "_rels/.rels 里应有一条 officeDocument 关系")


def check_child_order(el, table: dict, path: str) -> None:
    """子元素顺序：对有 CT_* 模型的元素，检查子元素**相对顺序**不倒挂。

    ⚠️ **没有模型的元素也要继续往下走**。第一版写成「没有模型就 return」，
    结果根节点 `w:document`（本来就没有 CT_Document 的模型）直接把整棵树剪掉了 ——
    这条检查是**死代码**，而它看起来一直是绿的。故障注入 #3/#4 把它抓了出来。
    """
    model = ct_model_of(el.tag, table)
    if not model:
        for child in el:
            check_child_order(child, table, f"{path}/{local(el.tag)}")
        return
    pos = {name: i for i, name in enumerate(model)}
    last = -1
    for child in el:
        name = "w:" + local(child.tag)
        if name in pos:
            i = pos[name]
            check(
                i >= last,
                f"{path}/{local(el.tag)} 的子元素顺序不对："
                f"`{name}` 出现在 `{model[last] if last >= 0 else '?'}` 之前（应为 {model}）",
            )
            last = max(last, i)
    for child in el:
        check_child_order(child, table, f"{path}/{local(el.tag)}")


def case_child_element_order_matches_the_content_models() -> None:
    """子元素顺序 —— Word 对这条敏感：`<w:pPr>` 放到 `<w:r>` 之后 = 文件打不开。"""
    st, buf = docx_bytes()
    if st != 200:
        return
    table = order_table()
    z = zipfile.ZipFile(io.BytesIO(buf))
    doc = ET.fromstring(z.read("word/document.xml"))
    check_child_order(doc, table, "")


def table_texts(buf: bytes) -> list[list[str]]:
    """把 docx 里的表格读回成二维文本（续格读成空串）。"""
    z = zipfile.ZipFile(io.BytesIO(buf))
    doc = ET.fromstring(z.read("word/document.xml"))
    out: list[list[str]] = []
    for tbl in doc.iter(w("tbl")):
        for tr in tbl.findall(w("tr")):
            row: list[str] = []
            for tc in tr.findall(w("tc")):
                parts: list[str] = []
                for p in tc.findall(w("p")):
                    seg: list[str] = []
                    for node in p.iter():
                        if node.tag == w("t") and node.text:
                            seg.append(node.text)
                        elif node.tag == w("br"):
                            seg.append("\n")
                    parts.append("".join(seg))
                row.append("\n".join(parts))
            out.append(row)
    return out


def visible_texts(rows: list[list[dict]]) -> list[str]:
    """渲染网格 → 「导出后还能看见的文本」序列。

    **被合并盖住的格不算**。这条规则不是我编的：样例模板里 `城市小计` 落在
    `上海`（rowspan 3）盖住的位置，**xlsx 导出里那一格也是空的**
    （`xl/worksheets/sheet1.xml` 的 `<c r="B5" s="3"/>`）。
    也就是说「渲染 API 返回合并盖住的格、导出格式丢掉它」是既有语义，
    见 `case_covered_cells_are_dropped_like_xlsx_does` —— 那条把这条规则钉住。
    """
    n = len(rows)
    width = max((len(r) for r in rows), default=0)
    hskip = [[False] * width for _ in range(n)]   # 被 gridSpan 横向吸收
    vcont = [[False] * width for _ in range(n)]   # 纵向合并的续格
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            cs = max(cell.get("colspan", 1), 1)
            rs = max(cell.get("rowspan", 1), 1)
            for j in range(1, cs):
                if c + j < width:
                    hskip[r][c + j] = True
            for i in range(1, rs):
                if r + i >= n:
                    break
                for j in range(cs):
                    if c + j < width:
                        vcont[r + i][c + j] = True
                        if j > 0:
                            hskip[r + i][c + j] = True
    out: list[str] = []
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            if hskip[r][c]:
                continue
            out.append("" if vcont[r][c] else cell.get("text", ""))
    return out


def case_content_round_trips_against_render() -> None:
    """内容回读：docx 里的文字必须和渲染结果（去掉合并盖住的格后）一致 ——
    专抓「结构全对，但格子写错了 / 转义坏了 / 文本丢了」这类最容易被单测漏掉的错。"""
    _, buf = docx_bytes()
    st, body = http("/api/report/sample-template")
    tpl = json.loads(body)
    st, rb = http("/api/report/render", {"template": tpl, "datasets": None, "sources": None, "dump": None})
    check(st == 200, f"/api/report/render 应返回 200，实际 {st}")
    if st != 200:
        return
    rendered = json.loads(rb)
    want_nz = [t for t in visible_texts(rendered["sheets"][0]["rows"]) if t != ""]
    got_nz = [t for row in table_texts(buf) for t in row if t != ""]
    check(
        want_nz == got_nz,
        "docx 里的文本与渲染结果不一致：\n"
        f"  期望：{want_nz[:14]}\n  实际：{got_nz[:14]}",
    )
    check(len(want_nz) > 0, "渲染结果一个非空格都没有 —— 这条用例等于空转")


def xlsx_texts() -> list[str]:
    """把同一份模板导出成 xlsx，读出所有字符串（含共享串）。"""
    st, body = http("/api/report/sample-template")
    tpl = json.loads(body)
    st, buf = http("/api/report/xlsx", {"template": tpl, "datasets": None, "sources": None, "dump": None})
    check(st == 200, f"/api/report/xlsx 应返回 200，实际 {st}")
    if st != 200:
        return []
    z = zipfile.ZipFile(io.BytesIO(buf))
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        for si in root.findall(f"{ns}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{ns}t")))
    out: list[str] = []
    for name in sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)):
        root = ET.fromstring(z.read(name))
        ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        for c in root.iter(f"{ns}c"):
            if c.get("t") == "s":
                v = c.find(f"{ns}v")
                if v is not None and v.text:
                    out.append(shared[int(v.text)])
    return out


def case_covered_cells_are_dropped_like_xlsx_does() -> None:
    """把「合并盖住的格会被丢掉」这条语义钉住。

    样例模板里 `城市小计` 正好落在 `上海`（rowspan 3）盖住的格上，
    **xlsx 和 docx 都不该出现它**。这条用例的作用是：哪天引擎改了（比如让小计行
    不被合并覆盖），这里会红 —— 那正是我们想看见的，别把它当成噪音删掉。
    """
    _, buf = docx_bytes()
    got = [t for row in table_texts(buf) for t in row]
    xs = xlsx_texts()
    check("城市小计" not in got, f"docx 不该出现被合并盖住的「城市小计」：{got}")
    check("城市小计" not in xs, f"xlsx 也不该出现「城市小计」（既有语义），实际：{xs}")
    # 别让这条用例空转：两个格式都得真的有内容
    check(len([t for t in got if t]) > 5, "docx 内容太少，这条用例在空转")
    check(len(xs) > 5, "xlsx 内容太少，这条用例在空转")


def case_merge_structure_survives() -> None:
    """主格展开出来的就是合并格。横向要成 gridSpan、纵向要成 vMerge，
    丢了它报表结构就散了。"""
    _, buf = docx_bytes()
    z = zipfile.ZipFile(io.BytesIO(buf))
    doc = ET.fromstring(z.read("word/document.xml"))
    grid = list(doc.iter(w("gridSpan")))
    vmerge = list(doc.iter(w("vMerge")))
    check(
        len(grid) + len(vmerge) > 0,
        "样例模板展开后应当有合并格（gridSpan 或 vMerge），一个都没有 —— "
        "要么合并没还原，要么样例模板变了（后者要连本用例一起改）",
    )


def case_every_row_has_the_full_column_count() -> None:
    """每行**占满**表宽。缺格会让 Word 里整行错位 —— 而渲染出来的行本来就是
    锯齿状的（见 csv.rs 的说明），补齐是导出端的事。

    ⚠️ 判据是「**占的列数**」不是「tc 个数」：一个 `gridSpan=4` 的 tc 一个人就占
    4 列（标题行就是这样）。我第一版数 tc，当场被这条用例自己打回。"""
    _, buf = docx_bytes()
    z = zipfile.ZipFile(io.BytesIO(buf))
    doc = ET.fromstring(z.read("word/document.xml"))
    for tbl in doc.iter(w("tbl")):
        cols = len(list(tbl.iter(w("gridCol"))))
        check(cols > 0, "表没有 gridCol")
        for i, tr in enumerate(tbl.findall(w("tr"))):
            used = 0
            for tc in tr.findall(w("tc")):
                pr = tc.find(w("tcPr"))
                gs = pr.find(w("gridSpan")) if pr is not None else None
                used += int(gs.get(f"{{{W}}}val")) if gs is not None else 1
            check(used == cols, f"第 {i} 行占 {used} 列，但表宽是 {cols}（缺格会整行错位）")


def case_paper_size_reaches_the_docx() -> None:
    """纸张设置要进 sectPr（与 HTML / xlsx 同一份 PageConfig）。"""
    _, buf = docx_bytes(page={"paper": "A4"})
    z = zipfile.ZipFile(io.BytesIO(buf))
    doc = ET.fromstring(z.read("word/document.xml"))
    sz = list(doc.iter(w("pgSz")))
    check(len(sz) == 1, f"应恰好一个 pgSz，实际 {len(sz)}")
    if sz:
        # Word 自己写 A4 用的值（不是我算的）
        check(sz[0].get(f"{{{W}}}w") == "11906", f"A4 宽应是 11906，实际 {sz[0].get(f'{{{W}}}w')}")
        check(sz[0].get(f"{{{W}}}h") == "16838", f"A4 高应是 16838，实际 {sz[0].get(f'{{{W}}}h')}")

    # 没写 margin_mm → 不该有 pgMar（「不表态」口径）
    _, buf2 = docx_bytes(page={"paper": "A4"})
    doc2 = ET.fromstring(zipfile.ZipFile(io.BytesIO(buf2)).read("word/document.xml"))
    check(len(list(doc2.iter(w("pgMar")))) == 0, "没写 margin_mm 就不该吐 pgMar")

    _, buf3 = docx_bytes(page={"paper": "A4", "margin_mm": {"top": 25.4, "right": 25.4, "bottom": 25.4, "left": 25.4}})
    doc3 = ET.fromstring(zipfile.ZipFile(io.BytesIO(buf3)).read("word/document.xml"))
    mar = list(doc3.iter(w("pgMar")))
    check(len(mar) == 1, "写了 margin_mm 就该有 pgMar")
    if mar:
        check(mar[0].get(f"{{{W}}}top") == "1440", f"1 英寸 = 1440 twips，实际 {mar[0].get(f'{{{W}}}top')}")


def case_content_type_header() -> None:
    st, buf = docx_bytes()
    check(st == 200, f"应返回 200，实际 {st}")
    # 响应头这里拿不到，用 zip 签名兜底（见 case_endpoint_returns_a_zip）
    check(buf[:2] == b"PK", "响应体应是 zip")


CASES = [
    case_server_is_up,
    case_endpoint_returns_a_zip,
    case_all_parts_are_declared_in_content_types,
    case_every_part_is_well_formed_xml,
    case_relationship_ids_resolve,
    case_child_element_order_matches_the_content_models,
    case_content_round_trips_against_render,
    case_covered_cells_are_dropped_like_xlsx_does,
    case_merge_structure_survives,
    case_every_row_has_the_full_column_count,
    case_paper_size_reaches_the_docx,
    case_content_type_header,
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true", help="打印 word/document.xml")
    args = ap.parse_args()

    st, _ = http("/health")
    if st == 0:
        print("✗ 连不上 127.0.0.1:18888（服务没起，或被沙箱代理拦了）", file=sys.stderr)
        return 2

    for c in CASES:
        before = len(fails)
        c()
        print(f"{'✗' if len(fails) > before else '✓'} {c.__name__}")

    if args.dump:
        _, buf = docx_bytes()
        z = zipfile.ZipFile(io.BytesIO(buf))
        print("\n--- word/document.xml ---")
        print(z.read("word/document.xml").decode("utf8", "ignore"))

    if fails:
        print(f"\n✗ {len(fails)} 条不符合：", file=sys.stderr)
        for f in fails:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print(f"\n✓ {len(CASES)} 条用例全部符合")
    return 0


if __name__ == "__main__":
    sys.exit(main())
