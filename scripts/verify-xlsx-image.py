#!/usr/bin/env python3
"""
图片格导出的真机探针 —— 走真实的 /api/report/xlsx，拆开 zip 核对。

为什么单测不够（本仓库反复踩的那一类）：

1. **图片的最终尺寸写在 `xdr:ext`（EMU）里，Rust 单测读不到** ——
   xlsx 是 zip，drawing XML 是 deflate 过的；`to_xlsx` 的返回值里只能搜到
   `xl/media/image1.png` 这个**文件名**（zip 中央目录不压缩），搜不到内容。
2. 第一版真的漏了「按算好的尺寸缩放」这一步：偏移按缩完的尺寸算、图却按原尺寸插，
   结果图会盖到右边那一列。单测全绿 —— 因为两边都不看 EMU。
3. 列宽 / 行高的换算是**照抄 crate 内部**的公式（`round(字符×7)+5`、
   `round(磅×4/3)`），抄错了只有真的量产物才知道。这里量到的列宽像素值
   会反推回字符数，与 `xlsx.rs` 的 `col_pixels` 对账。

读 XML 的两个坑（都踩过）：
- `<a:off x y>` 是**整张表上的绝对位置**（前面所有行列的累计），不是格内偏移；
  格内偏移看 `<xdr:from>` 里的 `colOff` / `rowOff`。
- 列宽在 XML 里不是「字符数」而是 `floor(像素×256/7)/256`（crate 的
  `width_to_chars`），所以反推像素要 `round(width × 7)`，**不是** `round(w×7)+5`。

用法（先起服务）：
    cd print-server && ~/.cargo/target/debug/print-server &
    python3 scripts/verify-xlsx-image.py
    python3 scripts/verify-xlsx-image.py --dump     # 打印 drawing/sheet XML，便于对锚点

退出码：0 = 全部符合；1 = 有不符合（并打印差在哪）。
"""
import argparse
import base64
import json
import re
import struct
import sys
import urllib.request
import zipfile
import zlib
from io import BytesIO

SERVER = "http://127.0.0.1:18888"
EMU_PER_PX = 9525  # Excel 的固定换算：1 像素 = 9525 EMU
MDW = 7            # Calibri 11 的最大数字宽（Excel 列宽换算用）

fails: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        fails.append(msg)


def png(w: int, h: int, rgb=(0x33, 0x99, 0xCC), dpi: int | None = None) -> bytes:
    """造一张真 PNG（纯色）。不同尺寸 → 不同字节，避开 crate 的图片去重。

    `dpi` 给上就写一个 pHYs 块 —— 从打印链路导出的图常带它，
    而 Excel 按**物理尺寸**显示，所以 120px@203dpi 只显示约 57px。
    """
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    if dpi:
        ppm = round(dpi / 0.0254)  # pHYs 的单位是「像素/米」
        out += chunk(b"pHYs", struct.pack(">IIB", ppm, ppm, 1))
    return out + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def data_uri(b: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(b).decode()


# 五张**互不相同**的图，各自进一格
IMGS = {
    "logo": png(120, 80),      # sheet1 A1：单格字面图（撑列宽 + 撑行高）
    "photo1": png(100, 60),    # sheet1 A3：取本格的值（第 1 行）
    "photo2": png(90, 50),     # sheet1 A3：取本格的值（第 2 行）
    "merged": png(200, 40),    # sheet1 A5：合并 A:B 的字面图
    # sheet2 A1：**必须被缩小**的图。1000px 宽超过 MAX_COL_WIDTH(60 字符 = 425px)，
    # 列只能撑到 425px，图得缩到 425×85 —— 这条才真正走到 set_scale_to_size。
    # 单独放一张 sheet，免得它把 sheet1 的 A 列撑宽、把其它锚点的偏移全改掉。
    "wide": png(1000, 200),
    # sheet2 A2：带 pHYs=203dpi 的图。Excel 按物理尺寸显示，
    # 120×80px@203dpi 只显示约 57×38px —— 不折算的话会大 2.1 倍，
    # 而它在设计器里看着是好的（设计器用的是像素）。
    "hidpi": png(120, 80, dpi=203),
}

TEMPLATE = {
    "sheets": [
        {
            "name": "图片",
            "rows": [
                {"cells": [
                    {"pos": "A1", "value": "公司 logo",
                     "image": {"from": "literal", "src": data_uri(IMGS["logo"])}},
                    {"pos": "B1", "value": "产品"},
                    {"pos": "C1", "value": "备注"},
                ]},
                {"cells": [
                    {"pos": "A2", "value": "普通文本"},
                    {"pos": "B2", "value": "第二列内容"},
                ]},
                {"cells": [
                    {"pos": "A3",
                     "model": {"field": "photo", "expand_type": "r"},
                     "image": {"from": "value"}},
                ]},
                {"cells": [{"pos": "A4", "value": "普通文本二"}]},
                {"cells": [
                    {"pos": "A5", "merge_across": 1,
                     "image": {"from": "literal", "src": data_uri(IMGS["merged"])}},
                ]},
            ],
        },
        {
            "name": "宽图",
            "rows": [
                {"cells": [
                    {"pos": "A1",
                     "image": {"from": "literal", "src": data_uri(IMGS["wide"])}},
                ]},
                {"cells": [
                    {"pos": "A2",
                     "image": {"from": "literal", "src": data_uri(IMGS["hidpi"])}},
                ]},
            ],
        },
    ],
    "datasets": {
        "ds1": [
            {"photo": data_uri(IMGS["photo1"])},
            {"photo": data_uri(IMGS["photo2"])},
        ]
    },
}


def fetch_xlsx() -> bytes:
    body = json.dumps({"template": TEMPLATE, "datasets": None, "sources": None}).encode()
    req = urllib.request.Request(
        SERVER + "/api/report/xlsx",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        ctype = r.headers.get("content-type", "")
        blob = r.read()
    if "spreadsheet" not in ctype and not blob.startswith(b"PK"):
        raise SystemExit(f"✗ 返回的不是 xlsx（content-type={ctype}）：{blob[:200]!r}")
    return blob


def anchors(drawing: str) -> list[dict]:
    """每个图片锚点 → {col,row,colOff,rowOff,cx,cy,descr}（偏移取格内的，不是绝对位置）"""
    out = []
    for blk in re.findall(r"<xdr:(?:oneCell|twoCell)Anchor\b.*?</xdr:(?:oneCell|twoCell)Anchor>",
                          drawing, re.S):
        frm = re.search(
            r"<xdr:from>\s*<xdr:col>(\d+)</xdr:col>\s*<xdr:colOff>(\d+)</xdr:colOff>\s*"
            r"<xdr:row>(\d+)</xdr:row>\s*<xdr:rowOff>(\d+)</xdr:rowOff>", blk)
        # 尺寸在 `<a:ext>` 里（a = drawingml 命名空间），不是 `<xdr:ext>`
        ext = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', blk)
        descr = re.search(r'descr="([^"]*)"', blk)
        out.append({
            "col": int(frm.group(1)) if frm else None,
            "col_off": int(frm.group(2)) if frm else None,
            "row": int(frm.group(3)) if frm else None,
            "row_off": int(frm.group(4)) if frm else None,
            "cx": int(ext.group(1)) if ext else None,
            "cy": int(ext.group(2)) if ext else None,
            "descr": descr.group(1) if descr else "",
        })
    return out


def px(emu: int) -> float:
    return emu / EMU_PER_PX


def sheet_artifacts(z: zipfile.ZipFile, names: list[str]) -> dict[str, tuple[str, list[dict]]]:
    """sheet 名 → (sheet XML, 锚点列表)。

    sheet 与 drawing 的对应关系走 `_rels`，**不假设 drawing1 对应 sheet1** ——
    只有第一张表有图时编号就会错位，那种错位是静默的（会读到别的表的锚点）。
    """
    out: dict[str, tuple[str, list[dict]]] = {}
    for n in sorted(x for x in names if re.match(r"xl/worksheets/sheet\d+\.xml$", x)):
        sid = re.match(r"xl/worksheets/(sheet\d+)\.xml$", n).group(1)
        sheet = z.read(n).decode("utf8", "ignore")
        rels = f"xl/worksheets/_rels/{sid}.xml.rels"
        anch: list[dict] = []
        if rels in names:
            target = re.search(r'Target="([^"]*drawings/drawing\d+\.xml)"',
                               z.read(rels).decode("utf8", "ignore"))
            if target:
                dpath = "xl/" + target.group(1).lstrip("/").replace("../", "")
                if dpath in names:
                    anch = anchors(z.read(dpath).decode("utf8", "ignore"))
        out[sid] = (sheet, anch)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true", help="打印 drawing / sheet XML")
    ap.add_argument("--xlsx", help="离线模式：直接读一个已导出的 xlsx")
    args = ap.parse_args()

    blob = open(args.xlsx, "rb").read() if args.xlsx else fetch_xlsx()
    z = zipfile.ZipFile(BytesIO(blob))
    names = z.namelist()

    media = sorted(n for n in names if n.startswith("xl/media/"))
    drawings = sorted(n for n in names if n.startswith("xl/drawings/drawing"))

    if args.dump:
        for n in drawings:
            print("==== " + n + " ====")
            print(z.read(n).decode("utf8", "ignore"))
        print("==== sheet1.xml ====")
        print(z.read("xl/worksheets/sheet1.xml").decode("utf8", "ignore"))
        print("条目：", names, file=sys.stderr)
        return 0

    if not media:
        print("✗ 产物里一张图都没有（xl/media 为空）")
        print("  条目：", names)
        return 1

    shared = (z.read("xl/sharedStrings.xml").decode("utf8", "ignore")
              if "xl/sharedStrings.xml" in names else "")
    arts = sheet_artifacts(z, names)

    def geom(sheet_xml: str):
        """→ (列宽像素 {列号:px}, 行高磅 {行号:pt})"""
        c = {int(m.group(1)): round(float(m.group(2)) * MDW)
             for m in re.finditer(r'<col min="(\d+)" max="\d+" width="([\d.]+)"', sheet_xml)}
        r = {int(m.group(1)): float(m.group(2))
             for m in re.finditer(r'<row r="(\d+)"[^>]*?ht="([\d.]+)"', sheet_xml)}
        return c, r

    def expect(key: str, a: dict | None, row: int, w: int, h: int, avail_w: int,
               descr: str) -> None:
        """一张图的四件事：缩放后的尺寸、格内偏移、纵向不被顶出去、alt 文本"""
        if a is None:
            check(False, f"{key} 的图片锚点没找到（第 {row + 1} 行）")
            return
        check(a["cx"] == w * EMU_PER_PX, f"{key} 宽应为 {w}px，实际 {px(a['cx']):.1f}px")
        check(a["cy"] == h * EMU_PER_PX, f"{key} 高应为 {h}px，实际 {px(a['cy']):.1f}px")
        want_x = (avail_w - w) // 2
        check(a["col_off"] == want_x * EMU_PER_PX,
              f"{key} 横向居中偏移应为 {want_x}px，实际 {px(a['col_off']):.1f}px")
        check(a["row_off"] == 0,
              f"{key} 纵向偏移应为 0（行高已撑到刚好），实际 {px(a['row_off']):.1f}px")
        if descr:
            check(a["descr"] == descr, f"{key} 的 alt 应是「{descr}」，实际 {a['descr']!r}")

    # ---- 1. 媒体字节 == 原图字节 ----
    stored = {z.read(n): n for n in media}
    for key, want in IMGS.items():
        check(want in stored, f"{key} 的图没进 xl/media（被当成空图丢了？）")

    # ================= sheet1：撑列宽 / 撑行高 / 逐行解析 / 合并 =================
    sheet1, anch = arts.get("sheet1", ("", []))
    check(len(anch) == 4, f"sheet1 应当有 4 个图片锚点，实际 {len(anch)}")
    cols, rows = geom(sheet1)
    # 反推像素要与 xlsx.rs 的 col_pixels 对账：
    # 120px 的 logo → chars_for_pixels(120) = ceil((120-5.5)/7) = 17 → col_pixels(17) = 124
    a_px = cols.get(1, 0)
    b_px = cols.get(2, 0)
    check(a_px == 124, f"A 列应被 logo 撑到 17 字符 = 124px，实际 {a_px}px")
    check(a_px >= 120, f"A 列放不下 120px 的 logo，实际 {a_px}px")

    # 行高 = 图片高度（磅 = 像素 × 3/4）
    check(abs(rows.get(1, 0) - 60.0) < 0.51, f"第 1 行应被 logo 撑到 60 磅，实际 {rows.get(1)}")
    check(abs(rows.get(3, 0) - 45.0) < 0.51, f"第 3 行应撑到 45 磅，实际 {rows.get(3)}")
    check(abs(rows.get(4, 0) - 37.5) < 0.51, f"第 4 行应撑到 37.5 磅，实际 {rows.get(4)}")
    check(abs(rows.get(6, 0) - 30.0) < 0.51, f"第 6 行应被合并图撑到 30 磅，实际 {rows.get(6)}")
    # 没有图也没有长文本的行不该写行高（普通报表的行高要跟以前一模一样）
    check(2 not in rows, f"第 2 行不该有自定义行高，实际 {rows.get(2)}")

    def find(anchors_: list[dict], row: int, col: int = 0):
        return next((a for a in anchors_ if a["row"] == row and a["col"] == col), None)

    # A1：logo 120×80，A 列 124px → 不缩，x 偏移 (124-120)/2 = 2
    expect("A1 的 logo", find(anch, 0), 0, 120, 80, a_px, "公司 logo")
    # A3 展开出的两张产品图：逐行按各自的图撑行高、各自居中
    expect("第 1 张产品图", find(anch, 2), 2, 100, 60, a_px, "")
    expect("第 2 张产品图", find(anch, 3), 3, 90, 50, a_px, "")
    # A5 的合并图 200×40，A:B 合并区 = 124+89 = 213px → 不缩，x 偏移 (213-200)/2 = 6
    expect("A5 的合并图", find(anch, 5), 5, 200, 40, a_px + b_px, "")

    # 合并图的锚点要真的跨到 B 列
    if find(anch, 5):
        check(b_px > 0, "B 列宽度读不到，无法验证合并区")

    # ================= sheet2：必须被缩小的图（MAX_COL_WIDTH 夹住） =================
    sheet2, anch2 = arts.get("sheet2", ("", []))
    check(len(anch2) == 2, f"sheet2 应当有 2 个图片锚点，实际 {len(anch2)}")
    cols2, rows2 = geom(sheet2)
    w_px = cols2.get(1, 0)
    # 1000px 的图 → chars_for_pixels 算出 143 字符，被 MAX_COL_WIDTH=60 夹住 → 425px
    check(w_px == 425, f"宽图那列应夹在 MAX_COL_WIDTH=60 字符 = 425px，实际 {w_px}px")
    # 于是图必须从 1000×200 缩到 425×85 —— 这条才是 set_scale_to_size 的证据
    expect("宽图", find(anch2, 0), 0, 425, 85, w_px, "")
    check(abs(rows2.get(1, 0) - 63.75) < 0.51,
          f"宽图那行应撑到 63.75 磅(85px)，实际 {rows2.get(1)}")
    # 203dpi 的图：自然显示尺寸 = 120×96/203 ≈ 57px，不是 120px
    expect("203dpi 的图", find(anch2, 1), 1, 57, 38, w_px, "")
    check(abs(rows2.get(2, 0) - 28.5) < 0.51,
          f"203dpi 的图那行应撑到 28.5 磅(38px)，实际 {rows2.get(2)}")

    # ---- 图片格不写文本；普通文本格照旧 ----
    check("公司 logo" not in shared,
          "图片格的 text 不该写进 sharedStrings（它只该当 alt）")
    check("普通文本" in shared, "普通文本格应当照常写进 sharedStrings")

    if fails:
        print(f"✗ {len(fails)} 项不符合：")
        for f in fails:
            print("  -", f)
        print(f"\n  条目：{names}")
        print(f"  sheet1 列宽 {cols} 行高 {rows}\n  sheet1 锚点 {anch}")
        print(f"  sheet2 列宽 {cols2} 行高 {rows2}\n  sheet2 锚点 {anch2}")
        return 1

    print(f"✓ 全部通过：{len(media)} 个媒体文件、{len(anch) + len(anch2)} 个锚点")
    print(f"  sheet1 列宽 A/B = {a_px}/{b_px}px  行高 {rows} 磅")
    print(f"  sheet2 列宽 A = {w_px}px  行高 {rows2} 磅")
    for a in anch + anch2:
        print(f"  锚点 ({a['row']},{a['col']}) {px(a['cx']):.0f}×{px(a['cy']):.0f}px"
              f" 偏移 ({px(a['col_off']):.0f},{px(a['row_off']):.0f}) alt={a['descr']!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
