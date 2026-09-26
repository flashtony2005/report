#!/usr/bin/env python3
"""
给**三条新加的「表内容钉子」**做故障注入：往 Rust 里塞已知的改动，
确认对应那条钉子真的会红。

## 为什么必须做

钉子（`assert_eq!(KINDS.to_vec(), vec![...])` 这类）天生有个陷阱：
**它可能是一条恒真的断言** —— 比如写成了断言一个 `const` 等于它自己，
那它就永远绿、什么都守不住，而**看起来跟真钉子一模一样**。
所以「三条钉子全绿」只有在「注入已知改动后它们真的会红」的前提下才有意义。

## 覆盖面刻意按**漏检类型**分组，不是随便凑数

| 注入 | 考的是 |
| --- | --- |
| 表里**加**一项 | 最普通的漂移：服务端加了、TS 没加 |
| 表里**改名**（数量不变） | **只有内容钉子才抓得到** —— `assert_eq!(X.len(), 3)` 对改名毫无反应 |
| 纸张表加一项 | 已有的钉子（`paper_table_is_pinned`）确实在守 |

第二条是这次的关键：它专门证明「钉内容」比「钉数量」强，
免得以后有人图省事把 `to_vec()` 比较改回 `.len()`。

用法：python3 scripts/fault-inject-table-pins.py
退出码：0 = 每条注入都被对应的钉子抓到；1 = 有注入没抓到（那就是钉子是摆设）。
"""

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"
REPORT_DIR = SERVER_DIR / "src" / "report"
CHART = REPORT_DIR / "chart.rs"
BARCODE = REPORT_DIR / "barcode.rs"
MODEL = REPORT_DIR / "model.rs"

# (说明, 文件, 锚点原文, 替换成, 期望变红的用例名)
#
# 锚点**必须恰好匹配 1 处** —— 匹配 0 处会被当成「没验过」，匹配多处则可能改错地方。
# 脚本对每条都做 count 校验，不靠「反正应该只有一处」。
CASES = [
    (
        "图表类型表**加**一项（bar/line/pie + donut）",
        CHART,
        'pub const KINDS: [&str; 3] = ["bar", "line", "pie"];',
        'pub const KINDS: [&str; 4] = ["bar", "line", "pie", "donut"];',
        "kinds_table_is_pinned_and_names_the_ts_mirror",
    ),
    (
        "图表类型表**改名**（pie → donut，数量不变 3）",
        CHART,
        'pub const KINDS: [&str; 3] = ["bar", "line", "pie"];',
        'pub const KINDS: [&str; 3] = ["bar", "line", "donut"];',
        "kinds_table_is_pinned_and_names_the_ts_mirror",
    ),
    (
        "码制表**加**一项（qr/code128 + code39）",
        BARCODE,
        'pub const SYMBOLOGIES: [&str; 2] = ["qr", "code128"];',
        'pub const SYMBOLOGIES: [&str; 3] = ["qr", "code128", "code39"];',
        "symbology_table_is_pinned_and_names_the_ts_mirror",
    ),
    (
        "码制表**改名**（code128 → code-128，数量不变 2）",
        BARCODE,
        'pub const SYMBOLOGIES: [&str; 2] = ["qr", "code128"];',
        'pub const SYMBOLOGIES: [&str; 2] = ["qr", "code-128"];',
        "symbology_table_is_pinned_and_names_the_ts_mirror",
    ),
    (
        "纸张表**加**一项（A2）—— 考的是已有的 paper_table_is_pinned",
        MODEL,
        "pub const PAPERS: &[(&str, f64, f64, u8)] = &[",
        'pub const PAPERS: &[(&str, f64, f64, u8)] = &[\n    ("A2", 420.0, 594.0, 66),',
        "paper_table_is_pinned",
    ),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def run_test(name: str):
    """跑指定用例，返回 `(是否真的跑了, 是否通过)`。

    「真的跑了」必须单独判：**`cargo test <过滤名>` 在匹配不到任何用例时仍然返回 0**。
    于是把用例名打错会伪装成「通过」—— 基线看着绿、注入看着「没抓到」，
    两种都是假结论。判据是数输出里真的出现了几条 `... ok` / `... FAILED`。
    """
    r = run(
        [
            "cargo", "test",
            "--manifest-path", "print-server/Cargo.toml",
            "--bin", "print-server",
            "--", name,
        ]
    )
    out = r.stdout + r.stderr
    ran = out.count("... ok") + out.count("... FAILED")
    return ran > 0, r.returncode == 0


def main() -> int:
    print("先跑基线（未注入时三条钉子应当是绿的）…")
    for name in sorted({n for *_, n in CASES}):
        ran, passed = run_test(name)
        if not ran:
            print(f"✗ 用例名匹配不到任何用例（**没验过**）：{name}")
            print("  过滤名写错了。改这里，别改钉子。")
            return 1
        if not passed:
            print(f"✗ 基线就跑不过：{name}")
            print("  先把钉子修绿再来注入 —— 否则「变红」说明不了任何事。")
            return 1
    print("基线 ✓\n")

    missed = []
    for desc, path, old, new, test_name in CASES:
        original = path.read_text(encoding="utf-8")
        before = sha(path)

        n = original.count(old)
        if n != 1:
            print(f"✗ 锚点匹配 {n} 处（要求恰好 1 处），**没验过**：{desc}")
            missed.append(desc)
            continue

        path.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            ran, passed = run_test(test_name)
        finally:
            path.write_text(original, encoding="utf-8")

        # 还原必须逐字节一致 —— 否则注入脚本自己就成了污染源
        after = sha(path)
        if after != before:
            print(f"✗ 还原后文件变了！{path}（{before[:12]} → {after[:12]}）")
            return 2

        if not ran:
            print(f"✗ 用例名匹配不到任何用例（**没验过**）：{desc}")
            missed.append(desc)
        elif passed:
            print(f"✗ **钉子仍然是绿的**（这条注入没抓到）：{desc}")
            missed.append(desc)
        else:
            print(f"✓ 如期变红  {desc}")
            print(f"    被抓者：{test_name}")

    print()
    if missed:
        print(f"有 {len(missed)} 条没抓到，钉子有漏网：")
        for m in missed:
            print("  -", m)
        return 1
    print(f"全部 {len(CASES)} 条注入都被对应钉子抓到；文件均已逐字节还原。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
