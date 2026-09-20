#!/usr/bin/env python3
"""
票据指令（esc / tsc / zpl）真机探针 —— 走真实的 /print 接口，拆开落盘的指令文件核对。

为什么单测不够：`ticket/` 里的单测断言的是**函数返回值**，而这条链路还有三段
单测看不到的接线：

1. `/print` 有没有真的把 `content`（画布 JSON）交给翻译层 —— 传错字段（比如
   忘了 `encoding=utf8` 校验、把 base64 解了）单测不会红；
2. 落盘的文件名 / 扩展名（`lp` 是按文件发的，扩展名错了有些系统会拒）；
3. **喂行序列**。ESC/POS 没有绝对 y，位置全靠 `ESC d n` 一行一行推。
   同行多一个图元就多推一行，整张小票上移 —— 这种错在单测里要专门写用例才抓得住，
   在真实载荷上跑一遍是最直接的验证（第一版就是这么发现表格两格把方框顶上去了）。

用法（先起服务）：
    cd print-server && ~/.cargo/target/debug/print-server &
    python3 scripts/verify-ticket-print.py
退出码：0 = 全部符合预期；1 = 有不符合（并打印差在哪）。
"""
import glob
import json
import os
import subprocess
import sys
import time
import urllib.request

SERVER = "http://127.0.0.1:18888"
SPOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "print-server", "spool")

# 80×120mm、203dpi 的小票：标题 / 横线 / 绑定 / 表达式 / EAN13 / 二维码 / 静态表格 / 方框
CANVAS = {
    "version": "1.0",
    "document": {
        "type": "report",
        "page": {"width": 80, "height": 120, "unit": "mm", "orientation": "portrait"},
        "sections": [{"type": "body", "height": 120, "components": [
            {"id": "t1", "type": "text", "left": 0, "top": 4, "width": 80, "height": 6,
             "value": "望京店 · 销售小票", "style": {"fontSize": 14, "textAlign": "center"}},
            {"id": "l1", "type": "line", "left": 2, "top": 12, "width": 76, "height": 1},
            {"id": "t2", "type": "text", "left": 2, "top": 14, "width": 50, "height": 5,
             "contentType": "variable", "binding": "shop.name"},
            {"id": "t3", "type": "text", "left": 2, "top": 20, "width": 76, "height": 5,
             "value": "合计 {{order.total}} 元"},
            {"id": "bc1", "type": "barcode", "left": 2, "top": 28, "width": 50, "height": 12,
             "value": "690123456789", "format": "ean13", "showText": True},
            {"id": "qr1", "type": "qrcode", "left": 2, "top": 44, "width": 25, "height": 25,
             "value": "https://shop.example.com/o/8899"},
            {"id": "tb1", "type": "table", "left": 2, "top": 72, "width": 76, "height": 20,
             "columns": [{"title": "品名", "width": 46}, {"title": "数量", "width": 30}],
             "cells": [[{"contentType": "text", "text": "苹果"}, {"contentType": "text", "text": "2"}],
                       [{"contentType": "text", "text": "香蕉"}, {"contentType": "text", "text": "5"}]]},
            {"id": "r1", "type": "rect", "left": 2, "top": 108, "width": 76, "height": 10},
        ]}],
    },
    "data": {"shop": {"name": "望京店"}, "order": {"total": 128.5}},
}

fails: list[str] = []


def check(cond: bool, what: str) -> None:
    if cond:
        print(f"  ok   {what}")
    else:
        print(f"  FAIL {what}")
        fails.append(what)


def post(fmt: str, canvas: dict, dpi: int = 203) -> dict:
    body = json.dumps({
        "taskName": f"verify-{fmt}", "printer": "", "format": fmt, "encoding": "utf8",
        "content": json.dumps(canvas, ensure_ascii=False),
        "pages": 1, "width": 80, "height": 120, "copies": 1,
        "orientation": "portrait", "duplex": False, "color": False, "dpi": dpi,
    }).encode()
    req = urllib.request.Request(f"{SERVER}/print", data=body,
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def newest(ext: str) -> str:
    files = glob.glob(os.path.join(SPOOL, f"*.{ext}"))
    if not files:
        raise SystemExit(f"spool 里没有 .{ext} 文件：{SPOOL}")
    return max(files, key=os.path.getmtime)


def esc_feeds(b: bytes) -> list[int]:
    """把 ESC d n 序列抽出来 —— 它就是这张小票的「行位置」全貌"""
    out, i = [], 0
    while i + 2 < len(b):
        if b[i] == 0x1B and b[i + 1] == 0x64:
            out.append(b[i + 2])
            i += 3
        else:
            i += 1
    return out


def main() -> int:
    try:
        with urllib.request.urlopen(f"{SERVER}/health", timeout=3) as r:
            json.loads(r.read())
    except Exception as e:
        print(f"服务没起来（{SERVER}）：{e}\n先在 print-server/ 下启动 print-server 再跑本脚本")
        return 1

    # ---------------------------------------------------------------- esc
    print("== esc（ESC/POS）==")
    t0 = time.time()
    res = post("esc", CANVAS)
    path = newest("esc")
    check(os.path.getmtime(path) >= t0 - 1, f"落盘的是这一次的文件 {os.path.basename(path)}")
    b = open(path, "rb").read()

    check(b[:2] == b"\x1b\x40", "开头是 ESC @ 初始化")
    check(b[-3:] == b"\x1d\x56\x00", "结尾是 GS V 0 切纸")
    check(b[2:5] == b"\x1b\x33\x18", "行距钉成 24 点（ESC 3 24）—— 不钉的话 ESC d n 推进多少由机型定")

    # 中文必须是 GBK（票据机内置中文库），不能是 UTF-8
    gbk = "望京店".encode("gbk")
    check(gbk in b, "中文按 GBK 编码")
    check("望京店".encode("utf-8") not in b, "不是 UTF-8")

    # 绑定 / 表达式都要取到值
    check("望京店".encode("gbk") in b, "binding=shop.name 取到了值")
    check("合计 128.5 元".encode("gbk") in b, "{{order.total}} 被替换成 128.5")

    # EAN13：GS k 67 n=12 + 12 位数字
    check(b"\x1d\x6b\x43\x0c690123456789" in b, "EAN13 指令（GS k 67 n=12 + 12 位数字）")

    # 二维码：型号 2 / 模块大小 / 纠错 L / 存数据 / 打印，五段齐全
    check(b"\x1d\x28\x6b\x04\x001A2\x00" in b, "二维码型号 2 段")
    check(b"\x1d\x28\x6b\x03\x001C" in b, "二维码模块大小段")
    check(b"\x1d\x28\x6b\x03\x001E0" in b, "二维码纠错 L 段")
    check(b"\x1d\x28\x6b\x03\x001Q0" in b, "二维码打印段")
    payload = b"https://shop.example.com/o/8899"
    check(b"\x1d\x28\x6b" + bytes([len(payload) + 3, 0]) + b"1P0" + payload in b,
          "二维码数据段长度 = 数据 + 3")

    # 喂行序列：这是整张小票的位置全貌。
    # 逐项核对（y(mm) → 点 → 行 = floor(点/24)）：
    #   标题 4mm→1 行；横线 12mm→4 行；绑定 14mm→4 行（与横线同行，不喂）；
    #   表达式 20mm→6 行；条码 28mm→9 行；二维码 44mm→14 行；
    #   表格第 1 行 72mm→23 行（两格同行，只喂一次）；表格第 2 行 82mm→27 行；
    #   方框 108mm→35 行。
    # 期望 = [1, 2, 1, 2, 4, 8, 3, 7]，累计 28 行。
    # 表格那两格如果各推一行，这里会变成 [..., 9, 2, 6]，方框就上移一行。
    feeds = esc_feeds(b)
    check(feeds == [1, 2, 1, 2, 4, 8, 3, 7], f"喂行序列 = {feeds}（期望 [1, 2, 1, 2, 4, 8, 3, 7]）")
    check(sum(feeds) == 28, f"累计推进 28 行（实际 {sum(feeds)}）")

    # 画不出来的控件要留痕，不能静默丢
    check("img1" in json.dumps(res, ensure_ascii=False) or "image" not in json.dumps(CANVAS),
          "（本载荷没有 image 控件，跳过）")
    check(res.get("warnings") == [], f"这份载荷没有告警，实际 {res.get('warnings')}")

    # ---------------------------------------------------------------- tsc
    print("== tsc（TSPL）==")
    res = post("tsc", CANVAS)
    path = newest("tspl")
    s = open(path, "rb").read().decode("utf-8")
    check(s.startswith("SIZE 80.00 mm,120.00 mm\r\n"), "SIZE 用 mm 且带 CRLF")
    check("CLS\r\n" in s, "有 CLS 清屏")
    check(s.rstrip().endswith("PRINT 1,1"), "以 PRINT 1,1 结束")
    check("\n" not in s.replace("\r\n", ""), "行尾全是 CRLF，没有裸 LF")
    check('TEXT 16,112,"1",0,2,2,"望京店"' in s, "绑定取到值（坐标 14mm→112 点）")
    check('BARCODE 16,224,"EAN13",96,1,0,2,4,"690123456789"' in s, "EAN13 条码指令")
    check('QRCODE 16,352,L,8,A,0,"https://shop.example.com/o/8899"' in s, "二维码指令")
    check("BAR 16,96,607,2" in s, "横线（12mm→96 点，76mm→607 点）")
    check(s.count("BAR 16,863") == 2 and "BAR 623,863" in s,
          "方框四条边（上/下在 863/943，左右在 16/623；108mm→863 点）")
    check(any("UTF-8" in w for w in res.get("warnings", [])),
          "TSPL 有中文 → 提示机型字库依赖（不能静默）")

    # ---------------------------------------------------------------- zpl
    print("== zpl（ZPL II）==")
    res = post("zpl", CANVAS)
    path = newest("zpl")
    z = open(path, "rb").read().decode("utf-8")
    check(z.startswith("^XA\r\n"), "以 ^XA 开头")
    check(z.rstrip().endswith("^XZ"), "以 ^XZ 结束")
    check("^CI28\r\n" in z, "^CI28 声明 UTF-8（不打中文必乱，且是静默乱）")
    check("^PW639\r\n" in z, "^PW639（80mm × 7.9921 点/mm，不是整 640）")
    check("^LL959\r\n" in z, "^LL959（120mm → 959 点）")
    check("^FD望京店^FS" in z, "绑定取到值，且中文以 UTF-8 原样下发")
    check("^FD合计 128.5 元^FS" in z, "表达式取到值")
    check("^BEN,96,Y,N\r\n" in z, "EAN13 条码指令")
    check("^BQN,2,5,M\r\n" in z, "二维码指令（25mm→199 点 /40 → 5 倍）")
    check("^FDMA,https://shop.example.com/o/8899^FS" in z, "二维码数据段带 M 前缀")
    check("^GB607,2,2^FS" in z, "横线用 ^GB")
    check("^GB607,80,2^FS" in z, "方框用 ^GB（10mm 高 → 80 点）")
    check("^FH" not in z, "内容里没有 ^ / ~，不该出现 ^FH")
    check(res.get("warnings") == [], f"ZPL 有 ^CI28，中文不该告警：{res.get('warnings')}")

    # ------------------------------------------------- 画不出来的控件必须留痕
    print("== 画不出来的控件要留痕（image / chart）==")
    canvas2 = json.loads(json.dumps(CANVAS))
    canvas2["document"]["sections"][0]["components"].append(
        {"id": "img1", "type": "image", "left": 2, "top": 95, "width": 20, "height": 10,
         "value": "logo.png"})
    canvas2["document"]["sections"][0]["components"].append(
        {"id": "ch1", "type": "chart", "left": 2, "top": 100, "width": 40, "height": 15,
         "kind": "bar"})
    for fmt in ("esc", "tsc", "zpl"):
        res = post(fmt, canvas2)
        w = json.dumps(res.get("warnings", []), ensure_ascii=False)
        check("img1" in w and "ch1" in w, f"{fmt}: image 与 chart 都指名报了出来")
        check(res.get("ok") is False, f"{fmt}: 有未翻译内容时 ok=false（不假装成功）")

    # ------------------------------------------------- 单位 / 尺寸的硬错误
    print("== 单位认不出来 / 尺寸非法 → 明确报错 ==")
    # 注意：本服务的 service_error 是 **HTTP 200 + ok:false**（不是 5xx），
    # 所以判据要落在 ok / message 上，别只看状态码
    bad = json.loads(json.dumps(CANVAS))
    bad["document"]["page"]["unit"] = "cm"
    res = post("esc", bad)
    check(res.get("ok") is False, f"单位 cm → ok=false（实际 {res.get('ok')}）")
    check("cm" in res.get("message", ""), f"报错要指名单位：{res.get('message', '')[:90]}")

    bad = json.loads(json.dumps(CANVAS))
    bad["document"]["page"]["width"] = 0
    res = post("esc", bad)
    check(res.get("ok") is False and "页面尺寸" in res.get("message", ""),
          f"0 宽页面 → 明确报错：{res.get('message', '')[:90]}")

    print()
    if fails:
        print(f"✗ {len(fails)} 项不符合：")
        for f in fails:
            print("   -", f)
        return 1
    print("✓ 全部符合预期")
    return 0


if __name__ == "__main__":
    sys.exit(main())
