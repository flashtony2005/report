#!/usr/bin/env python3
"""条码格导出的真机探针 —— 走真实的 /api/report/xlsx 与 /api/report/render，拆开产物核对。

## 为什么单测不够（本仓库反复踩的那一类）

1. **xlsx 里的位图是 zip 里的一条 `xl/media/imageN.png`** —— Rust 侧读不到内容。
   `to_xlsx` 的返回值里能搜到那个**文件名**（zip 中央目录不压缩），
   但里面的像素一个也搜不到。单测只能断言「没报错」，那等于没测。
2. **条码错了在屏幕上看不出来**：黑白颠倒、静区少一模块、掩码没应用 ——
   图还是个「有条码形状的图」，肉眼看着完全正常，扫不出来。
   只有真正的解码器说「读出来是这串」才算数。
3. **HTML 侧的内联 SVG 同理**：几何对不对得用真渲染器画出来再解。

## 这个探针验的是完整链路

    模板 JSON → 引擎 → 编码器（位矩阵）→ ┬→ 1 位灰度 PNG → xlsx 的 media
                                          └→ 内联 SVG → 真渲染器（rsvg）→ PNG
                                                          ↓
                                            两者都交给 zxing 解码对原文

## 用法（先起服务）

    cd print-server && ~/.cargo/target/debug/print-server --port 18902 &
    python3 scripts/verify-xlsx-barcode.py --port 18902
    python3 scripts/verify-xlsx-barcode.py --port 18902 --dump   # 保留中间产物

退出码：0 = 全部符合；1 = 有不符合（并打印差在哪）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from io import BytesIO

fails: list[str] = []


def check(ok: bool, msg: str) -> bool:
    if not ok:
        fails.append(msg)
    return ok


# ---------------------------------------------------------------- 模板

# 布局刻意覆盖四种情形：
# - A3：`from: value` 的**一列**条码（每行一个，内容跟着行走）
# - C3：字面量二维码（固定内容，不随数据变）
# - D3：字面量 Code128
# - E3：中文内容（必须走二维码，Code128 只收 ASCII）
#
# ⚠️ 关键语义：A3 是纵向展开格，**同一行的 C3/D3/E3 也跟着出现 3 次**。
# 所以条码格是 4 列 × 3 行 = **12 个**，不是 4 个。
# 这是**有意的**：条码在展开行里的行为跟图片一致（每行一个）。
# 图表才是「一个声明只画一份」（它读整列数据，画 N 份会叠在同一格上）。
TEMPLATE = {
    "sheets": [
        {
            "name": "条码示例",
            "rows": [
                {
                    "cells": [
                        {
                            "pos": "A3",
                            "model": {
                                "ds": "ds1",
                                "field": "order_no",
                                "expand_type": "r",
                            },
                            # 每行的条码内容 = 本行订单号
                            "barcode": {"from": "value", "symbology": "code128"},
                        },
                        {
                            "pos": "B3",
                            "model": {"ds": "ds1", "field": "region", "row_parent": "A3"},
                        },
                        {
                            "pos": "C3",
                            "barcode": {
                                "value": "https://example.com/order/2026-0001",
                                "symbology": "qr",
                            },
                        },
                        {
                            "pos": "D3",
                            "barcode": {"value": "SHIP-2026-0001", "symbology": "code128"},
                        },
                        {
                            "pos": "E3",
                            "barcode": {"value": "销售单：2026-0001", "symbology": "qr"},
                        },
                    ]
                }
            ],
        }
    ],
    "datasets": {
        "ds1": [
            {"order_no": "SO-2026-0001", "region": "华东"},
            {"order_no": "SO-77", "region": "华北"},
            {"order_no": "SO-2026-88888", "region": "华南"},
        ]
    },
}

ROWS = 3
# 每行的条码（列顺序 A、C、D、E）
ROW_PAYLOADS = ["SO-2026-0001", "https://example.com/order/2026-0001", "SHIP-2026-0001", "销售单：2026-0001"]
# HTML 里是 12 个内联 SVG（行优先：3 行 × 4 列），字面量那三列每行重复
EXPECTED_HTML = [
    "SO-2026-0001", "https://example.com/order/2026-0001", "SHIP-2026-0001", "销售单：2026-0001",
    "SO-77", "https://example.com/order/2026-0001", "SHIP-2026-0001", "销售单：2026-0001",
    "SO-2026-88888", "https://example.com/order/2026-0001", "SHIP-2026-0001", "销售单：2026-0001",
]
EXPECTED_CELLS = len(EXPECTED_HTML)  # 12 个条码格

# xlsx 的 media 是**去重**过的：字面量条码在 3 行里字节完全相同，
# 于是 12 个格子只存 6 份位图（rust_xlsxwriter 的行为），
# 但 drawing 里有 12 个锚点，各自指向正确的 media。
# 顺序 = 行优先首次出现的顺序。
EXPECTED_MEDIA = [
    "SO-2026-0001",
    "https://example.com/order/2026-0001",
    "SHIP-2026-0001",
    "销售单：2026-0001",
    "SO-77",
    "SO-2026-88888",
]


def post(path: str, payload: dict, raw: bool = False):
    req = urllib.request.Request(
        path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
        return body if raw else json.loads(body)


# ---------------------------------------------------------------- 解码 oracle


def zxing():
    try:
        import zxingcpp
    except ImportError:
        print("✗ 缺少 zxingcpp（解码 oracle）。装法：")
        print("  ~/.workbuddy-ai/binaries/python/envs/default/bin/python -m pip install zxing-cpp")
        sys.exit(1)
    return zxingcpp


def decode_png_bytes(zxingcpp, blob: bytes) -> list[tuple[str, bytes]]:
    """PNG 字节 → [(码制, 原始字节)]，**必须恰好一个**条码"""
    from io import BytesIO as B

    from PIL import Image

    img = Image.open(B(BytesIO(blob).read())).convert("L")
    return [(str(r.format), r.bytes) for r in zxingcpp.read_barcodes(img)]


def rsvg_render(svg: str, out_png: str) -> bool:
    """用 librsvg 把内联 SVG 画成 PNG。这是**独立渲染器** ——
    不是我们自己解析自己的 path，能验出「path 语法写错了」这类问题。"""
    exe = shutil.which("rsvg-convert")
    if not exe:
        return False
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False, encoding="utf-8") as f:
        f.write(svg)
        svg_path = f.name
    try:
        r = subprocess.run(
            [exe, "-w", "600", svg_path, "-o", out_png],
            capture_output=True, text=True,
        )
        return r.returncode == 0 and os.path.exists(out_png)
    finally:
        os.unlink(svg_path)


# ---------------------------------------------------------------- 主流程


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18888)
    ap.add_argument("--dump", action="store_true", help="保留中间产物到 /tmp/barcode-probe")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}"
    zxingcpp = zxing()

    workdir = "/tmp/barcode-probe"
    if args.dump:
        shutil.rmtree(workdir, ignore_errors=True)
        os.makedirs(workdir, exist_ok=True)
        print(f"· 中间产物留在 {workdir}")

    # ================================================ 一、xlsx 侧
    print("== xlsx：位图 → zxing ==")
    try:
        blob = post(f"{base}/api/report/xlsx", {"template": TEMPLATE}, raw=True)
    except Exception as e:  # noqa: BLE001
        print(f"✗ 导出请求失败：{e}")
        return 1
    if not check(blob[:2] == b"PK", "导出物应当是 zip（以 PK 开头）"):
        return report()

    z = zipfile.ZipFile(BytesIO(blob))
    names = z.namelist()
    media = sorted(
        (n for n in names if re.match(r"xl/media/image\d+\.png$", n)),
        key=lambda n: int(re.search(r"(\d+)", n.split("/")[-1]).group(1)),
    )
    if not check(
        len(media) == len(EXPECTED_MEDIA),
        f"应当嵌 {len(EXPECTED_MEDIA)} 张去重后的位图，实际 {len(media)} 张：{media}",
    ):
        print("✗ 位图数量不对 —— 后面的检查无从谈起")
        if args.dump:
            for n in names:
                print("  zip:", n)
        return report()

    decoded: list[bytes] = []
    for n in media:
        raw = z.read(n)
        if args.dump:
            with open(os.path.join(workdir, n.split("/")[-1]), "wb") as f:
                f.write(raw)
        got = decode_png_bytes(zxingcpp, raw)
        if not check(len(got) == 1, f"{n}: 应当解出恰好 1 个条码，实际 {len(got)} 个"):
            continue
        fmt, payload = got[0]
        decoded.append(payload)
        print(f"  ✓ {n:<22} {fmt:<10} {payload!r}")

    if check(
        decoded == [p.encode() for p in EXPECTED_MEDIA],
        f"解出的内容与期望不符\n    期望 {EXPECTED_MEDIA}\n"
        f"    实际 {[b.decode('utf-8', 'replace') for b in decoded]}",
    ):
        print(f"  ✓ {len(decoded)} 张位图全部解回原文（顺序=行优先首次出现）")

    # 位深与颜色类型：必须是 1 位灰度。写成 24 位 RGB 会让文件大 24 倍，
    # 而且缩放时可能插值出灰边 —— 灰边会毁掉条码
    for n in media:
        raw = z.read(n)
        i = raw.find(b"IHDR")
        if check(i > 0, f"{n}: 找不到 IHDR"):
            check(raw[i + 12] == 1, f"{n}: 位深应当是 1，实际 {raw[i + 12]}")
            check(raw[i + 13] == 0, f"{n}: 颜色类型应当是灰度(0)，实际 {raw[i + 13]}")
    print("  ✓ 位图都是 1 位灰度 PNG")

    # 锚点：6 个条码格应当落在 6 个不同的格子上（不是 6 张叠在同一格）
    drawing = next((n for n in names if re.match(r"xl/drawings/drawing\d+\.xml$", n)), None)
    if check(drawing is not None, "应当有 drawing 条目"):
        d = z.read(drawing).decode("utf-8")
        anchors = re.findall(
            r"<xdr:from>.*?<xdr:col>(\d+)</xdr:col>.*?<xdr:row>(\d+)</xdr:row>",
            d, re.S,
        )
        check(
            len(anchors) == EXPECTED_CELLS,
            f"应当有 {EXPECTED_CELLS} 个锚点（4 列 × {ROWS} 行），实际 {len(anchors)} 个",
        )
        check(len(set(anchors)) == len(anchors), f"锚点有重复（多张图叠在同一格）：{anchors}")
        # 一列三个条码必须落在**不同行**（`from: value` 每行一个）
        rows = sorted(int(r) for _, r in anchors)
        check(len(set(rows)) == ROWS, f"条码应当落在 {ROWS} 行上，实际行号 {rows}")
        print(f"  ✓ {len(anchors)} 个锚点各不相同，覆盖 {len(set(rows))} 行")

    # ================================================ 二、HTML 侧
    print("\n== HTML：内联 SVG → librsvg 渲染 → zxing ==")
    try:
        resp = post(f"{base}/api/report/render", {"template": TEMPLATE})
    except Exception as e:  # noqa: BLE001
        print(f"✗ render 请求失败：{e}")
        return report()
    html = resp.get("html", "")
    svgs = re.findall(r"<svg\b.*?</svg>", html, re.S)
    if not check(
        len(svgs) == EXPECTED_CELLS,
        f"HTML 里应当有 {EXPECTED_CELLS} 个内联 SVG，实际 {len(svgs)} 个",
    ):
        return report()

    html_decoded: list[bytes] = []
    if not shutil.which("rsvg-convert"):
        print("  ⚠ 没有 rsvg-convert，跳过 HTML 侧解码（只做结构检查）")
        fails.append("缺少 rsvg-convert，HTML 侧没做解码验证")
    else:
        for idx, svg in enumerate(svgs):
            png_path = os.path.join(workdir if args.dump else tempfile.gettempdir(), f"svg{idx}.png")
            if not rsvg_render(svg, png_path):
                fails.append(f"第 {idx} 个 SVG 渲染失败")
                continue
            got = decode_png_bytes(zxingcpp, open(png_path, "rb").read())
            if not check(len(got) == 1, f"第 {idx} 个 SVG: 应当解出 1 个条码，实际 {len(got)} 个"):
                continue
            fmt, payload = got[0]
            html_decoded.append(payload)
            print(f"  ✓ svg[{idx}] {fmt:<10} {payload!r}")

        check(
            html_decoded == [p.encode() for p in EXPECTED_HTML],
            "HTML 侧的条码与期望不符\n"
            f"    期望 {EXPECTED_HTML}\n"
            f"    实际 {[b.decode('utf-8', 'replace') for b in html_decoded]}",
        )

    # 颜色必须写死：深色主题下跟着主题走会变成浅条深底，扫不出来
    check('fill="#fff"' in html, "条码 SVG 必须有白底")
    check('fill="#000"' in html, "条码 SVG 的条必须是黑的")
    check("currentColor" not in html, "条码不能跟随主题颜色")

    # ================================================ 三、错误路径
    print("\n== 错误路径：装不下要明确报错 ==")
    bad = json.loads(json.dumps(TEMPLATE))
    bad["sheets"][0]["rows"][0]["cells"] = [
        {"pos": "A1", "barcode": {"value": "x" * 300, "symbology": "qr"}},
        {"pos": "B1", "barcode": {"value": "中文", "symbology": "code128"}},
        {"pos": "C1", "barcode": {"value": "ABC", "symbology": "code39"}},
    ]
    resp_bad = post(f"{base}/api/report/render", {"template": bad})
    warns = " ".join(resp_bad.get("warnings", []))
    cells = resp_bad["sheets"][0]["rows"][0]
    for i, want in enumerate(["213", "ASCII", "code39"]):
        check(want in cells[i]["text"], f"A1/B1/C1 第 {i} 格的 text 要说明原因，实际 {cells[i]['text']!r}")
        check(want in warns, f"第 {i} 个错误要进 warnings，实际 {warns!r}")
    for i in range(3):
        check(cells[i].get("barcode") is None, f"第 {i} 格不该有编出来的条码")
    print("  ✓ 超容量 / 非 ASCII / 未知码制 三种错误都点名了原因")

    # ================================================ 四、优先级（从 xlsx 产物验）
    #
    # 引擎保证了「`GridCell.barcode` 有值 ⟹ 它就是要画的那个」，所以渲染端
    # 各自判优先级时**只剩一处会分叉**：图片和图表可以同时合法地落在同一格上
    # （图片在展开时就地解析，图表要等整个网格填完才解析，两条路互不知情）。
    # 这正是加条码时挖出来的老 bug ——「图片 + 图表」的格子在 Excel 里
    # 同时嵌了一张位图**和**一张原生图表，两个东西叠在同一格上。
    #
    # 关键：**这一条只能从 xlsx 产物验**。JSON 和 HTML 都走 `graphic()`，
    # 渲染端分叉了它们也看不出来（HTML 侧压根不出原生图表）。
    # 只验 JSON/HTML 的话，「导出端不走 graphic()」这类注入根本红不了。
    print("\n== 优先级：同一格只能出一个（从 xlsx 产物验） ==")
    prio = {
        "sheets": [
            {
                "name": "优先级",
                "rows": [
                    {
                        "cells": [
                            {"pos": "A3", "model": {"ds": "ds1", "field": "region", "expand_type": "r"}},
                            {"pos": "B3", "model": {"ds": "ds1", "field": "amount", "row_parent": "A3"}},
                            # C3 图片 + 图表 → 出图片（图片优先）
                            {"pos": "C3", "image": {"src": TINY_PNG}, "chart": CHART},
                            # D3 只有图表 → 出图表（证明图表没被整体关掉）
                            {"pos": "D3", "chart": CHART},
                            # E3 条码 + 图片 → 出图片（引擎侧就不编条码）
                            {
                                "pos": "E3",
                                "image": {"src": TINY_PNG},
                                "barcode": {"value": "E3-NOT-DRAWN", "symbology": "code128"},
                            },
                            # F3 条码 + 图表 → 出图表
                            {
                                "pos": "F3",
                                "chart": CHART,
                                "barcode": {"value": "F3-NOT-DRAWN", "symbology": "code128"},
                            },
                        ]
                    }
                ],
            }
        ],
        "datasets": {"ds1": [{"region": "华东", "amount": 1200}, {"region": "华北", "amount": 900}]},
    }
    blob_prio = post(f"{base}/api/report/xlsx", {"template": prio}, raw=True)
    if check(blob_prio[:2] == b"PK", "优先级模板应当也能导出"):
        zp = zipfile.ZipFile(BytesIO(blob_prio))
        pn = zp.namelist()
        pmedia = [n for n in pn if re.match(r"xl/media/image\d+\.png$", n)]
        pcharts = [n for n in pn if re.match(r"xl/charts/chart\d+\.xml$", n)]
        # C3 与 E3 的图片是同一份字节 → 去重成 1 张位图
        check(len(pmedia) == 1, f"C3/E3 的图片应去重成 1 张位图，实际 {len(pmedia)} 张：{pmedia}")
        # D3、F3 各一张；C3 被图片盖住**不该**再画
        check(
            len(pcharts) == 2,
            f"应当只有 D3/F3 两张原生图表（C3 被图片盖住），实际 {len(pcharts)} 张：{pcharts}",
        )
        # 被盖住的条码内容不能以任何形式出现在产物里
        for n in pn:
            if n.endswith((".xml", ".rels")):
                body = zp.read(n).decode("utf-8", "replace")
                check("E3-NOT-DRAWN" not in body, f"{n} 里出现了被盖住的 E3 条码内容")
                check("F3-NOT-DRAWN" not in body, f"{n} 里出现了被盖住的 F3 条码内容")
        print(f"  ✓ 位图 {len(pmedia)} 张、原生图表 {len(pcharts)} 张（被盖住的两个都没出）")

    # 三种「非文本格子」同时声明：优先级 + 告警
    both = json.loads(json.dumps(TEMPLATE))
    both["sheets"][0]["rows"][0]["cells"] = [
        {
            "pos": "A1",
            "image": {"src": TINY_PNG},
            "barcode": {"value": "SHOULD-NOT-APPEAR", "symbology": "code128"},
        }
    ]
    resp_both = post(f"{base}/api/report/render", {"template": both})
    w = " ".join(resp_both.get("warnings", []))
    check("同时声明" in w, f"图片+条码要告警，实际 {w!r}")
    cell = resp_both["sheets"][0]["rows"][0][0]
    check(cell.get("barcode") is None, "图片在时不该再编条码")
    check("SHOULD-NOT-APPEAR" not in resp_both.get("html", ""), "被盖住的条码不该出现在 HTML 里")
    print("  ✓ 图片盖住条码时告警且不出现")

    return report()


def report() -> int:
    print()
    if fails:
        print(f"✗ {len(fails)} 项不符合：")
        for f in fails:
            print("  -", f)
        return 1
    print("✓ 条码探针全部通过")
    return 0


# 一张 1×1 的合法 PNG（当图片格用，不参与条码检查）
TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

# 一张最小图表声明（读 A3 展开出的地区、B3 的金额），用来验优先级
CHART = {
    "kind": "bar",
    "categories": ["A3"],
    "series": [{"name": "销售额", "from": "B3"}],
    "title": "优先级用图",
}

if __name__ == "__main__":
    sys.exit(main())
