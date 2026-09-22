#!/usr/bin/env python3
"""条码故障注入：逐条改坏产品代码，确认探针**真的会红**。

## 为什么必须有这一层

「探针全绿」这句话在下面两种情况下毫无价值：
1. 探针根本没跑（早退、被 try/except 吞掉、路径写错）；
2. 探针跑了但断言是空的（`check(True, ...)`、比错了东西、只断言「没报错」）。

本仓库对这件事有硬要求：**每条注入都必须让探针变红**，红不出来就说明那条检查是摆设。
所以这个脚本对每一类错误改一处产品代码，重建，跑探针，断言它非零退出。

## 注入按「错误类别」分组

| 类别 | 注入 |
| --- | --- |
| 常量表错位 | Code128 图案表某个符号的宽度写错 |
| 算法步骤漏掉 | QR 掩码算完没应用；PNG 位序（MSB/LSB）反了 |
| 结构约定错 | QR 静区被涂黑；1 位图黑白颠倒 |
| 接线漏拷 | 展开分支漏拷 `barcode` 声明；`is_placeholder` 漏判条码 |
| 语义错 | `from: value` 没生效（一列条码不跟数据走） |
| 边界错 | 容量表算少 1 字节 |
| 报错内容错 | 上限只改了报错文案（报错了但说的原因不对） |
| 优先级错 | 导出端不走 `graphic()`（图片和条码都嵌进去） |
| 渲染几何错 | SVG 的宽高画反 |

## 用法

    python3 scripts/fault-inject-barcode-probe.py            # 跑全部
    python3 scripts/fault-inject-barcode-probe.py --only mask
    python3 scripts/fault-inject-barcode-probe.py --list

退出码：0 = 每条注入都让探针红了（说明探针有牙齿）；1 = 有注入没被抓住。
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "print-server"
BIN = Path.home() / ".cargo/target/debug/print-server"
PORT = 18903
PY = "/Users/lushaohui/.workbuddy-ai/binaries/python/envs/default/bin/python"

# (名字, 类别, 说明, 文件, 原文, 替换)
INJECTIONS = [
    (
        "code128-table",
        "常量表错位",
        "图案表里符号 33（'A'）的宽度 111323 → 111332",
        "print-server/src/report/barcode.rs",
        '"111323", "131123"',
        '"111332", "131123"',
    ),
    (
        "qr-mask",
        "算法步骤漏掉",
        "掩码算完忘了应用（格式信息照写 → 解码器反掩码后得到垃圾）",
        "print-server/src/report/barcode.rs",
        "        cand.apply_mask(mask);",
        "        // cand.apply_mask(mask);",
    ),
    (
        "qr-quiet-zone",
        "结构约定错",
        "静区被涂黑（静区是符号的一部分，少了/黑了都扫不出来）",
        "print-server/src/report/barcode.rs",
        "        let mut out = BarcodeMatrix::new(w, h);\n"
        "        for r in 0..self.height {",
        "        let mut out = BarcodeMatrix::new(w, h);\n"
        "        for r in 0..h {\n"
        "            for c in 0..w {\n"
        "                out.set(r, c, true);\n"
        "            }\n"
        "        }\n"
        "        for r in 0..self.height {",
    ),
    (
        "png-invert",
        "结构约定错",
        "1 位图黑白颠倒（0 才是黑）—— 只该坏 xlsx 那条路",
        "print-server/src/report/png.rs",
        "            if !dark(x, y) {",
        "            if dark(x, y) {",
    ),
    (
        "png-bit-order",
        "算法步骤漏掉",
        "PNG 位序反了（必须 MSB 在前，反了每 8 个像素镜像一次）",
        "print-server/src/report/png.rs",
        "                acc |= 1 << (7 - bit); // 白 = 1",
        "                acc |= 1 << bit; // 白 = 1",
    ),
    (
        "engine-copy",
        "接线漏拷",
        "展开分支漏拷 barcode 声明（`from: value` 的整列条码消失）",
        "print-server/src/report/engine.rs",
        "                inst.barcode = cell.barcode.clone().or_else(|| model.barcode.clone());",
        "                // inst.barcode = cell.barcode.clone().or_else(|| model.barcode.clone());",
    ),
    (
        "is-placeholder",
        "接线漏拷",
        "`is_placeholder` 漏判条码 → 纯条码格**整格消失**",
        "print-server/src/report/engine.rs",
        "        && cell.chart.is_none()\n        && cell.barcode.is_none()\n",
        "        && cell.chart.is_none()\n",
    ),
    (
        "from-value",
        "语义错",
        "`from: value` 没生效（一列条码不跟数据走）",
        "print-server/src/report/engine.rs",
        "                    let payload =\n"
        "                        if decl.from_value() { text.trim().to_string() } else { decl.value.clone() };",
        "                    let payload = decl.value.clone();",
    ),
    (
        "qr-capacity",
        "边界错",
        "容量表每个版本少算 1 字节（213 字节的上限变成 212）",
        "print-server/src/report/barcode.rs",
        "    bits.saturating_sub(4 + cci) / 8",
        "    bits.saturating_sub(4 + cci + 8) / 8",
    ),
    (
        "qr-limit-message",
        "报错内容错",
        "上限常量改错 → 报错了，但说的原因不对（213 说成 300）",
        "print-server/src/report/barcode.rs",
        "const MAX_QR_BYTES: usize = 213;",
        "const MAX_QR_BYTES: usize = 300;",
    ),
    (
        # 这一条验的是**渲染端**分叉。注入点选得很讲究：早先写的是
        # 「`decode_images` 里图片格返回 `Graphic::None`」，那个注入让图片格
        # 干脆不嵌位图 —— 结果和正确行为在探针的断言上**看不出区别**，
        # 于是探针没红，白拿一条「检查是摆设」的结论。
        # 真正会分叉的只有「图片 + 图表」：两者能同时合法地落在同一格上。
        "priority-xlsx",
        "优先级错",
        "导出端 `write_charts` 不走 `graphic()` → 图片盖住图表时位图和图表都嵌进去",
        "print-server/src/report/xlsx.rs",
        "            row.iter().enumerate().filter_map(move |(c, cell)| match cell.graphic() {\n"
        "                Graphic::Chart(ch) => Some((r, c, ch)),\n"
        "                _ => None,\n"
        "            })",
        "            row.iter().enumerate().filter_map(move |(c, cell)| match cell.chart.as_ref() {\n"
        "                Some(ch) => Some((r, c, ch)),\n"
        "                None => None,\n"
        "            })",
    ),
    (
        # 引擎侧的守卫。被盖住时**连编都不编**是那个不变量的来源
        # （`GridCell.barcode` 有值 ⟹ 它就是要画的那个），守卫没了渲染端就
        # 只能自己判优先级 —— 那正是分叉的起点。
        "priority-engine",
        "优先级错",
        "引擎「被盖住就不编」的守卫失效 → 被图片盖住的条码照样编出来",
        "print-server/src/report/engine.rs",
        "                if image.is_some() || inst.chart.is_some() {",
        "                if false {",
    ),
    (
        "svg-geometry",
        "渲染几何错",
        "SVG 把宽高画反（h{cw}v{rh} → h{rh}v{cw}）",
        "print-server/src/report/barcode_svg.rs",
        'out.push_str(&format!("M{c} {r}h{cw}v{rh}h-{cw}z"));',
        'out.push_str(&format!("M{c} {r}h{rh}v{cw}h-{rh}z"));',
    ),
]

OK = "\033[32m✓\033[0m"
BAD = "\033[31m✗\033[0m"


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def start_server() -> bool:
    """起服务，等它真的能响应"""
    stop_server()
    log = open("/tmp/barcode-inject-server.log", "w")
    subprocess.Popen(
        [str(BIN), "--port", str(PORT)],
        cwd=SERVER, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(40):
        time.sleep(0.25)
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2):
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def stop_server() -> None:
    r = sh(["pgrep", "-f", f"print-server --port {PORT}"])
    for pid in r.stdout.split():
        try:
            os.kill(int(pid), signal.SIGKILL)
        except (ProcessLookupError, ValueError):
            pass
    time.sleep(0.2)


def run_probes() -> list[str]:
    """跑两个探针，返回「红了」的名字列表"""
    red = []
    r = sh([PY, str(REPO / "scripts/verify-barcode.py")], cwd=REPO)
    if r.returncode != 0:
        red.append("verify-barcode")
    r = sh([PY, str(REPO / "scripts/verify-xlsx-barcode.py"), "--port", str(PORT)], cwd=REPO)
    if r.returncode != 0:
        red.append("verify-xlsx-barcode")
    return red


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只跑名字里含这个子串的注入")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for name, cls, desc, *_ in INJECTIONS:
            print(f"{name:<20} [{cls}] {desc}")
        return 0

    picked = [i for i in INJECTIONS if not args.only or args.only in i[0]]
    if not picked:
        print(f"没有匹配 --only {args.only!r} 的注入")
        return 1

    # 先确认基线是绿的 —— 基线本来就红的话，后面「注入后红」毫无意义
    print("== 基线 ==")
    if not sh(["cargo", "build", "--offline"], cwd=SERVER).returncode == 0:
        print("✗ 基线编译不过，先修好再来")
        return 1
    if not start_server():
        print("✗ 起不了服务")
        return 1
    red = run_probes()
    stop_server()
    if red:
        print(f"{BAD} 基线就是红的（{red}）—— 注入实验没有意义，先修基线")
        return 1
    print(f"{OK} 基线全绿（两个探针都通过）")

    results: list[tuple[str, str, list[str], str]] = []
    for name, cls, desc, rel, old, new in picked:
        path = REPO / rel
        original = path.read_text(encoding="utf-8")
        if original.count(old) != 1:
            print(f"{BAD} {name}: 注入锚点在 {rel} 里匹配到 {original.count(old)} 处（应当恰好 1 处）")
            results.append((name, cls, [], "锚点失效"))
            continue
        path.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            build = sh(["cargo", "build", "--offline"], cwd=SERVER)
            if build.returncode != 0:
                # 编译不过也算「抓住了」，但要说清楚 —— 它不是探针抓的
                results.append((name, cls, [], "编译失败"))
                print(f"  · {name}: 注入后编译不过（算抓住，但不是探针抓的）")
                continue
            if not start_server():
                results.append((name, cls, [], "服务起不来"))
                print(f"  · {name}: 注入后服务起不来（算抓住）")
                continue
            red = run_probes()
            stop_server()
            results.append((name, cls, red, "探针红了" if red else "探针没红"))
            if red:
                print(f"  {OK} {name:<18} [{cls}] → {', '.join(red)} 红了")
            else:
                print(f"  {BAD} {name:<18} [{cls}] → 探针**没红**（这条检查是摆设）")
        finally:
            path.write_text(original, encoding="utf-8")

    # 还原后必须回到全绿，否则说明还原没干净
    print("\n== 还原后复验 ==")
    if sh(["cargo", "build", "--offline"], cwd=SERVER).returncode != 0:
        print(f"{BAD} 还原后编译不过 —— 有文件没恢复干净")
        return 1
    if not start_server():
        print(f"{BAD} 还原后服务起不来")
        return 1
    red = run_probes()
    stop_server()
    if red:
        print(f"{BAD} 还原后探针还是红的（{red}）—— 有文件没恢复干净")
        return 1
    print(f"{OK} 还原后两个探针都回到全绿")

    missed = [r for r in results if not r[2]]
    print()
    print(f"注入 {len(results)} 条，被探针抓住 {len(results) - len(missed)} 条")
    if missed:
        print(f"{BAD} 这些注入**没被抓住**，说明对应的检查是摆设：")
        for name, cls, _, why in missed:
            print(f"  - {name} [{cls}] {why}")
        return 1
    print(f"{OK} 每条注入都让探针红了 —— 探针有牙齿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
