#!/usr/bin/env python3
"""故障注入：证明 `grid-report-inline-source.spec.tsx` 那 9 条**真的会红**。

## 为什么必须做

那 9 条全是「界面点一下 → 断言发出去的请求体」。如果注入一个明显的错、
用例照样全绿，那这组用例就只是摆设 —— 而本项目已经栽过两次假绿
（docx 的子元素顺序检查是死代码、part 闭合检查被 `Default Extension="xml"` 兜住）。

所以每条注入都要求**指定的那条用例变红**，只看退出码不算数。

## 注入点都在 `GridReportModal.tsx` 的**接线**上

纯函数那一层（`buildRenderRequest`）已经由 `fault-inject-inline-dataset.py` 守着了。
这一份专门守**接线**：state 有没有真的传进 `buildRenderRequest`、
选文件之后行有没有落到 state 上、出错有没有真的显示出来。
本项目正是因为「接线漏了」栽过一次 —— 分页开关画出来了、state 也变了，
但参数没走到请求体，而屏幕上「界面没反应」和「请求没带参数」一模一样。

## 锚点必须恰好匹配 1 次

匹配 0 次会**伪装成「闸没抓到」**（注入根本没生效），所以脚本当场报出来。

用法（要 designer-react 的 node_modules，它自带 vitest）：
    python3 scripts/fault-inject-inline-ui.py
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
SPEC = "src/modals/grid-report-inline-source.spec.tsx"

NODE = resolve_node()
# vitest 走 vite 工具链，不挂这两个 preload 会被 broker 拦（见 skill sandbox-broker-workarounds）
PRELOADS = [
    ROOT / "scripts" / "vite-safe-delete-bypass.cjs",
    ROOT / "scripts" / "broker-mkdir-throttle.cjs",
]

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# 每个 spec 跑一次要 ~100s（jsdom + antd 的 import 图），所以注入条数刻意压在 5 条
INJECTIONS: list[tuple[str, str, str, str]] = [
    (
        "请求体不再带 dataSourceKind（切到文件也没用，永远走数据库）",
        "        dataSourceKind,\n"
        "        // `null`（还没选数据）转成 `undefined`，让 `buildRenderRequest` 走「inline 但没数据」的报错分支\n",
        "",
        "选了 CSV",
    ),
    (
        "请求体不再带 inlineRows（解析出的行传不到请求上）",
        "        inlineRows: inlineRows ?? undefined,",
        "        inlineRows: undefined,",
        "选了 CSV",
    ),
    (
        "文件解析失败时不显示错误（退化成静默无数据）",
        "        clearInline()\n"
        "        setInlineErr(`解析「${file.name}」失败：${e instanceof Error ? e.message : String(e)}`)",
        "        clearInline()",
        "文件解析失败",
    ),
    (
        "接口取数失败时不显示错误（跨域退化成静默空表）",
        "      setInlineErr(e instanceof Error ? e.message : String(e))",
        "      setInlineErr('取数失败')",
        "接口跨域被挡",
    ),
    (
        "存盘不提示「内联数据不会被保存」（静默丢数据）",
        "      setSaveNotice(\n"
        "        dataSourceKind === 'inline'\n",
        "      setSaveNotice(\n"
        "        false\n",
        "存盘要提示",
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


def main() -> int:
    original = TARGET.read_text(encoding="utf-8")

    print("== 基线（要跑 ~100s）==", flush=True)
    code, out = run_spec()
    print(f"基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 本来就是红的，先修基线'}", flush=True)
    if code != 0:
        print("\n".join(out.splitlines()[-40:]))
        return 2

    caught = 0
    rows: list[tuple[str, str, str]] = []

    try:
        for desc, old, new, expect in INJECTIONS:
            n = original.count(old)
            if n != 1:
                rows.append((desc, f"❌ 锚点匹配 {n} 次（应为 1）", "未验证"))
                print(f"\n=== {desc}\n   ❌ 锚点匹配 {n} 次，跳过（注入没生效，不能算抓到）", flush=True)
                continue

            TARGET.write_text(original.replace(old, new), encoding="utf-8")
            try:
                code, out = run_spec()
                names = red_names(out)
                hit = code != 0 and any(expect in x for x in names)
                if hit:
                    caught += 1
                rows.append(
                    (desc, "✅ 抓到" if hit else "❌ 漏过", expect if hit else f"exit={code}，未见「{expect}」")
                )
                print(f"\n=== {desc}\n   exit={code}  期望用例「{expect}」{'✅ 变红' if hit else '❌ 没红'}", flush=True)
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
