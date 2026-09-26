#!/usr/bin/env python3
"""故障注入：证明 `grid-report-issues.spec.tsx` 那 4 条**真的会红**。

## 为什么必须做

那 4 条全是「服务端回了什么级别的诊断 → 界面显示什么 + 导出按钮能不能点」。
如果注入一个明显的错、用例照样全绿，那这组用例就只是摆设 ——
本项目已经栽过两次假绿（docx 的子元素顺序检查是死代码、part 闭合检查被
`Default Extension="xml"` 兜住）。

所以每条注入都要求**指定的那条用例变红**，只看退出码不算数。

## 注入点都在 `GridReportModal.tsx` 的**接线**上

类型那一层（`RenderIssue` / `IssueCode`）由 `mirror-check.py` 与
`print-server` 的 `codes_table_is_pinned_and_names_the_ts_mirror` 守着。
这一份专门守**接线**：`setIssues` 有没有真的被调用、级别判据有没有写反、
`disabled` 与函数内那道闸有没有真的接上。

## 本文件与 `fault-inject-inline-ui.py` 的两点差别

1. **加了第 5 个字段**（`expect_msg`）：光知道「哪条用例红了」不够。
   注入 4 和 5 都让「error 级」那条变红，但**红的断言不是同一条** ——
   4 该红在「按钮必须禁用」上（函数内那道闸还在，xlsx 仍然发不出去），
   5 该红在「结果不可信却把 xlsx 发出去了」上。不区分的话，
   「第二道闸真的拦住了」这句话就没有任何证据。
2. **`old` / `new` 允许是列表**：注入 5 要同时拆掉按钮禁用态和函数内那道闸，
   两处相隔很远，没法用一个连续锚点覆盖。

## 锚点必须恰好匹配 1 次

匹配 0 次会**伪装成「闸没抓到」**（注入根本没生效），所以脚本当场报出来。
⚠️ 锚点带缩进时要注意：6 空格的 `setIssues` 是 8 空格那处的**子串**，
只写一行会匹配到 2 次。所以这里的锚点一律写成**同缩进的多行块**。

用法（要 designer-react 的 node_modules，它自带 vitest）：
    python3 scripts/fault-inject-issues-ui.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_bin import resolve_node  # noqa: E402  （必须在 sys.path 之后）

ROOT = Path(__file__).resolve().parent.parent
DESIGNER = ROOT / "designer-react"
TARGET = DESIGNER / "src" / "modals" / "GridReportModal.tsx"
SPEC = "src/modals/grid-report-issues.spec.tsx"

NODE = resolve_node()
# vitest 走 vite 工具链，不挂这两个 preload 会被 broker 拦（见 skill sandbox-broker-workarounds）
PRELOADS = [
    ROOT / "scripts" / "vite-safe-delete-bypass.cjs",
    ROOT / "scripts" / "broker-mkdir-throttle.cjs",
]

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# (说明, 原串/原串列表, 新串/新串列表, 期望变红的用例名子串, 期望在输出里看到的断言文案)
# 单跑一次约 15s（比 inline-ui 那份的 ~100s 快，那份的 import 图更重）
INJECTIONS: list[tuple[str, object, object, str, str | None]] = [
    (
        "预览路径不再把 issues 接到 state（界面回到只读 warnings 的旧行为）",
        "      setWarnings(data.warnings ?? [])\n      setIssues(data.issues ?? [])\n",
        "      setWarnings(data.warnings ?? [])\n",
        "info 级",
        "等「诊断 Alert」超时",
    ),
    (
        "info 级在进 state 前被过滤掉（= 改之前「Info 看不见」的行为）",
        "      setIssues(data.issues ?? [])\n      setBlockNotice('')",
        "      setIssues((data.issues ?? []).filter((i) => i.level !== 'info'))\n      setBlockNotice('')",
        "info 级",
        "等「诊断 Alert」超时",
    ),
    (
        "error 级判据写成 warning（严重程度判错，导出闸形同虚设）",
        "issues.filter((i) => i.level === 'error')",
        "issues.filter((i) => i.level === 'warning')",
        "error 级",
        # 判据写错 → `blockingIssues` 为空 → 标题变成「模板诊断」而不是「已拦住导出」，
        # 所以红在**这条**上（比 `disabled` 那条更早）。这条文案是实测出来的，别凭想象改。
        "已拦住导出",
    ),
    (
        "导出按钮不再禁用（只剩 doExport 里那道闸 —— 它应当照样拦得住）",
        "                disabled={blockingIssues.length > 0}",
        "                disabled={false}",
        "error 级",
        "导出按钮必须是禁用的",
    ),
    (
        "按钮禁用 + 函数内那道闸一起拆掉 → xlsx 真的被发出去了（证明两道闸都在干活）",
        ["                disabled={blockingIssues.length > 0}", "    if (blockingIssues.length > 0) {"],
        ["                disabled={false}", "    if (false) {"],
        "error 级",
        "结果不可信却把 xlsx 发出去了",
    ),
]


def run_spec() -> tuple[int, str]:
    node_options = " ".join(f"--require {p}" for p in PRELOADS)
    env = dict(os.environ)
    env["NODE_OPTIONS"] = node_options
    proc = subprocess.run(
        [NODE, "node_modules/.bin/vitest", "run", SPEC],
        cwd=DESIGNER,
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.returncode, ANSI.sub("", proc.stdout + proc.stderr)


def red_names(out: str) -> list[str]:
    """vitest 的失败清单：`× <用例名>`，也有 `FAIL  <文件> > <用例名>`。"""
    names: list[str] = []
    for line in out.splitlines():
        if "FAIL" in line or "×" in line:
            names.append(line.strip())
    return names


def apply_edits(text: str, old: object, new: object) -> str | None:
    """按 (old, new) 逐对替换；锚点必须恰好匹配 1 次，否则返回 None。"""
    olds = old if isinstance(old, list) else [old]
    news = new if isinstance(new, list) else [new]
    if len(olds) != len(news):
        raise ValueError("old / new 长度不一致")
    for o, n in zip(olds, news):
        cnt = text.count(o)
        if cnt != 1:
            return None
        text = text.replace(o, n)
    return text


def main() -> int:
    original = TARGET.read_text(encoding="utf-8")

    print("== 基线 ==", flush=True)
    code, out = run_spec()
    print(f"基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 本来就是红的，先修基线'}", flush=True)
    if code != 0:
        print("\n".join(out.splitlines()[-40:]))
        return 2

    caught = 0
    rows: list[tuple[str, str, str]] = []

    try:
        for desc, old, new, expect, expect_msg in INJECTIONS:
            mutated = apply_edits(original, old, new)
            if mutated is None:
                # 逐个锚点报出匹配次数，否则「没抓到」和「锚点失效」分不清
                olds = old if isinstance(old, list) else [old]
                counts = [original.count(o) for o in olds]
                rows.append((desc, f"❌ 锚点匹配 {counts} 次（应为 1）", "未验证"))
                print(f"\n=== {desc}\n   ❌ 锚点匹配 {counts} 次，跳过（注入没生效，不能算抓到）", flush=True)
                continue

            TARGET.write_text(mutated, encoding="utf-8")
            try:
                code, out = run_spec()
                names = red_names(out)
                hit_name = code != 0 and any(expect in x for x in names)
                hit_msg = expect_msg is None or expect_msg in out
                hit = hit_name and hit_msg
                if hit:
                    caught += 1
                if hit:
                    detail = expect
                elif not hit_name:
                    detail = f"exit={code}，未见变红的「{expect}」"
                else:
                    detail = f"用例红了但断言文案不对，未见「{expect_msg}」"
                rows.append((desc, "✅ 抓到" if hit else "❌ 漏过", detail))
                print(
                    f"\n=== {desc}\n   exit={code}  期望用例「{expect}」"
                    f"{'✅ 变红' if hit_name else '❌ 没红'}"
                    f"{'' if hit_msg else '（断言文案对不上）'}",
                    flush=True,
                )
                if not hit:
                    print("   ---- 输出尾部 ----")
                    print("\n".join(out.splitlines()[-30:]))
            finally:
                TARGET.write_text(original, encoding="utf-8")
    finally:
        TARGET.write_text(original, encoding="utf-8")

    restored = TARGET.read_text(encoding="utf-8") == original
    code, _ = run_spec()

    print("\n" + "=" * 72)
    for desc, verdict, detail in rows:
        print(f"{verdict}  {desc}\n        期望用例：{detail}")
    print("=" * 72)
    print(f"注入 {len(INJECTIONS)} 条，抓到 {caught} 条")
    print(f"还原后逐字节一致：{restored}")
    print(f"还原后基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 仍是红的'}")

    ok = caught == len(INJECTIONS) and restored and code == 0
    print("\n结果：" + ("全部通过 —— 每条注入都被指定用例抓到" if ok else "❌ 有漏网，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
