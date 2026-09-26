#!/usr/bin/env python3
"""故障注入：证明 `mirror-check.py` 的**语义层**那 8 条真的会红。

## 为什么必须做

新增的语义层（规则类事实）全是「解析源码文本 + 比对」。**解析类检查最危险的
失效形态不是漏报，而是「锚点没匹配到 → 静默当成一致」** —— 那时它照样打印
「镜像一致」，退出码 0，而实际上**什么都没检查**。

所以这里的注入分两类，两类都不可省：

1. **改事实**（7 条）：把 TS 侧单独改掉，要求**指定的那条事实**变红。
   这类注入证明「检查在看对的地方」。
2. **改锚点**（1 条）：把 Rust 的常量改名，要求报**「抽取失败」**并且**计为红**。
   这类注入证明「检查不会静默失效」—— 没有它，上面 7 条全绿也可能只是
   「恰好锚点还在、正则还松」。

## ⚠️ 还必须有**对照组**（第 5 条）

`码制别名` 的方向是 **TS ⊆ Rust**（单向）。方向写反了会怎样？
把 TS 的别名**删掉一个** —— 那是**合法**的（设计器只认服务端认的一部分是允许的），
正确的行为是**仍然绿**。所以这条期望是「**绿**」：
它证明这个方向**没有写反**，也证明这条断言不是「任何差异都红」的粗判据。

（这条经验来自 `silent-failure-hunt` 的「改口径时对照组比主测试更重要」：
主测试证明「新的行为对」，对照组证明「旧的/合法的行为没被误伤」，
**回归风险全在后者**。）

## 锚点必须恰好匹配 1 处

匹配 0 次会**伪装成「闸没抓到」**（注入根本没生效），所以脚本当场报出来。

用法：
    python3 scripts/fault-inject-mirror-semantics.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "openprint" / "src" / "report" / "grid-report.ts"
CHART_RS = ROOT / "print-server" / "src" / "report" / "chart.rs"

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# (说明, 目标文件, 原串, 新串, 期望)  期望 = ("red", 输出里必须出现的子串) 或 ("green", None)
INJECTIONS: list[tuple[str, Path, str, str, tuple[str, str | None]]] = [
    (
        "TS 侧单独改图表类型（pie → donut）",
        TS,
        "export const CHART_KINDS: readonly CellChartKind[] = ['bar', 'line', 'pie']",
        "export const CHART_KINDS: readonly CellChartKind[] = ['bar', 'line', 'donut']",
        ("red", "图表类型"),
    ),
    (
        "TS 侧单独改字节上限（qr 213 → 240）",
        TS,
        "  qr: 213,",
        "  qr: 240,",
        ("red", "字节上限"),
    ),
    (
        "TS 侧单独删一个条件运算符（少 not_between）",
        TS,
        "  'between',\n  'not_between',\n]",
        "  'between',\n]",
        ("red", "条件运算符"),
    ),
    (
        "TS 侧单独删一个纸张名（少 Legal）",
        TS,
        "export const PAPER_NAMES = ['A3', 'A4', 'A5', 'B5', 'Letter', 'Legal']",
        "export const PAPER_NAMES = ['A3', 'A4', 'A5', 'B5', 'Letter']",
        ("red", "纸张名清单"),
    ),
    (
        "TS 侧单独删一个 IssueCode（少 generic）",
        TS,
        "  | 'join_key_not_grouped'\n  | 'generic'\n",
        "  | 'join_key_not_grouped'\n",
        ("red", "诊断 code 词表"),
    ),
    (
        "TS 侧单独改页脚上限（255 → 250）",
        TS,
        "if (escaped + 2 > 255) {",
        "if (escaped + 2 > 250) {",
        ("red", "页脚字符上限"),
    ),
    (
        "TS 码制别名**更宽**（加了 Rust 不认的别名）→ 必须红",
        TS,
        "  if (raw === 'code128' || raw === 'code-128' || raw === 'code_128') return 'code128'",
        "  if (raw === 'code128' || raw === 'code-128' || raw === 'code_128' || raw === 'code_1') return 'code128'",
        ("red", "码制别名"),
    ),
    (
        "TS 码制别名**更窄**（删掉 qr-code）→ 合法设计，必须**仍然绿**（对照组）",
        TS,
        "  if (raw === 'qr' || raw === 'qrcode' || raw === 'qr_code' || raw === 'qr-code') return 'qr'",
        "  if (raw === 'qr' || raw === 'qrcode' || raw === 'qr_code') return 'qr'",
        ("green", None),
    ),
    (
        "Rust 常量改名（KINDS → KINDS_RUST）→ 必须报「抽取失败」而不是静默一致",
        CHART_RS,
        'pub const KINDS: [&str; 3] = ["bar", "line", "pie"];',
        'pub const KINDS_RUST: [&str; 3] = ["bar", "line", "pie"];',
        ("red", "抽取失败"),
    ),
]


def run_check() -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, "scripts/mirror-check.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode, ANSI.sub("", proc.stdout + proc.stderr)


def main() -> int:
    originals = {p: p.read_text(encoding="utf-8") for p in {i[1] for i in INJECTIONS}}

    print("== 基线 ==", flush=True)
    code, out = run_check()
    print(f"基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 本来就是红的，先修基线'}", flush=True)
    if code != 0:
        print(out[-2000:])
        return 2

    caught = 0
    rows: list[tuple[str, str, str]] = []

    try:
        for desc, target, old, new, (kind, expect_text) in INJECTIONS:
            src = originals[target]
            n = src.count(old)
            if n != 1:
                rows.append((desc, f"❌ 锚点匹配 {n} 次（应为 1）", "未验证"))
                print(f"\n=== {desc}\n   ❌ 锚点匹配 {n} 次，跳过（注入没生效，不能算抓到）", flush=True)
                continue

            target.write_text(src.replace(old, new), encoding="utf-8")
            try:
                code, out = run_check()
                if kind == "red":
                    hit = code != 0 and expect_text is not None and expect_text in out
                    detail = (
                        f"✅ 红且报出「{expect_text}」"
                        if hit
                        else (
                            f"❌ 没红（exit={code}）"
                            if code == 0
                            else f"❌ 红了但没报出「{expect_text}」"
                        )
                    )
                else:
                    hit = code == 0
                    detail = "✅ 仍然绿（方向没写反）" if hit else f"❌ 误报红了（exit={code}）"
                if hit:
                    caught += 1
                rows.append((desc, "✅ 抓到" if hit else "❌ 漏过", detail))
                print(f"\n=== {desc}\n   {detail}", flush=True)
                if not hit:
                    print("   ---- 输出尾部 ----")
                    print("\n".join(out.splitlines()[-25:]))
            finally:
                target.write_text(src, encoding="utf-8")
    finally:
        for p, text in originals.items():
            p.write_text(text, encoding="utf-8")

    restored = all(p.read_text(encoding="utf-8") == t for p, t in originals.items())
    code, _ = run_check()

    print("\n" + "=" * 72)
    for desc, verdict, detail in rows:
        print(f"{verdict}  {desc}\n        {detail}")
    print("=" * 72)
    print(f"注入 {len(INJECTIONS)} 条，符合预期 {caught} 条")
    print(f"还原后逐字节一致：{restored}")
    print(f"还原后基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 仍是红的'}")

    ok = caught == len(INJECTIONS) and restored and code == 0
    print("\n结果：" + ("全部通过 —— 改事实会红、改锚点会红、合法的更窄不会误报" if ok else "❌ 有漏网，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
