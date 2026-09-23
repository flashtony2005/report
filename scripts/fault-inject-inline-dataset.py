#!/usr/bin/env python3
"""
故障注入：证明「内联数据集」那组用例**真的会红**。

为什么必须做：`buildRenderRequest` 的用例全是「断言请求体长什么样」——
如果注入一个明显的错、而用例照样全绿，那这组用例就是摆设。
本项目已经栽过两次「假绿」（docx 的子元素顺序检查是死代码、part 闭合检查太宽），
所以每条注入都要求**指定的那条用例变红**，只看退出码不算数。

注入点全在 `designer-react/src/modals/grid-report-request.ts`，
闸是 `designer-react` 自己的 vitest（`src/modals/grid-report-request.spec.ts`）。

用法：
    python3 scripts/fault-inject-inline-dataset.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "designer-react" / "src" / "modals" / "grid-report-request.ts"
SPEC = "src/modals/grid-report-request.spec.ts"
DESIGNER = ROOT / "designer-react"

NODE = "/Users/lushaohui/.workbuddy-ai/binaries/node/versions/22.22.2-3/bin/node"
PRELOADS = [
    ROOT / "scripts" / "vite-safe-delete-bypass.cjs",
    ROOT / "scripts" / "broker-mkdir-throttle.cjs",
]

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run_spec() -> tuple[int, str]:
    """跑那一个 spec 文件，返回 (退出码, 去掉 ANSI 的输出)。"""
    node_options = " ".join(f"--require {p}" for p in PRELOADS)
    env = {"NODE_OPTIONS": node_options, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    import os

    full_env = dict(os.environ)
    full_env.update(env)
    proc = subprocess.run(
        [NODE, "node_modules/.bin/vitest", "run", SPEC],
        cwd=DESIGNER,
        capture_output=True,
        text=True,
        env=full_env,
    )
    return proc.returncode, ANSI.sub("", proc.stdout + proc.stderr)


def failed_test_names(out: str) -> list[str]:
    """从 vitest 输出里挑出失败的用例名。

    vitest 在 `Failed Tests` 段里给失败用例打 `FAIL  <file> > <describe> > <name>`，
    文件内清单里则用 `× <name>`。两种都收，只要名字对得上就行。
    """
    names: list[str] = []
    for line in out.splitlines():
        if "FAIL" in line or "×" in line:
            names.append(line.strip())
    return names


# (说明, 要替换的原文, 替换成什么, 期望变红的用例名里的一个片段)
INJECTIONS: list[tuple[str, str, str, str]] = [
    (
        "数据集键名写错（模板绑的是 ds1）",
        "return { ok: true, part: { datasets: { [dsName]: inlineRows } } }",
        "return { ok: true, part: { datasets: { ds_typo: inlineRows } } }",
        "数据集名就是模板里绑的那个",
    ),
    (
        "inline 分支整个失效（判据写错）",
        "if (dataSourceKind === 'inline') {",
        "if (dataSourceKind === 'inline_never') {",
        "inline 时不要求库/表",
    ),
    (
        "inline 不检查空数据 → 渲染出空表",
        "if (!inlineRows || inlineRows.length === 0) {\n        return { ok: false, message: '请先选择数据文件或接口 —— 当前没有任何数据行' }",
        "if (false) {\n        return { ok: false, message: '请先选择数据文件或接口 —— 当前没有任何数据行' }",
        "inline 但一行数据都没有",
    ),
    (
        "db 分支也带上 datasets → 两条通道同时出现",
        "      part: {\n        sources: [\n          { name: dsName, database, engine, table, where: where.trim() || undefined, params },\n        ],\n      },",
        "      part: {\n        datasets: { [dsName]: inlineRows ?? [] },\n        sources: [\n          { name: dsName, database, engine, table, where: where.trim() || undefined, params },\n        ],\n      },",
        "db 模式绝不带 datasets",
    ),
    (
        "free 分支没用数据通道（早退分支漏接新特性）",
        "    const ch1 = dataChannel()",
        "    const ch1 = (() => ({ ok: true as const, part: { sources: [] as never[] } }))()",
        "自由模板也接了内联数据源",
    ),
]


def main() -> int:
    original = TARGET.read_text(encoding="utf-8")

    # 基线：注入之前必须全绿，否则「变红」说明不了任何事
    code, out = run_spec()
    base_ok = code == 0
    print(f"基线：exit={code} {'✅ 全绿' if base_ok else '❌ 本来就是红的，先修基线'}")
    if not base_ok:
        print(out[-3000:])
        return 2

    caught = 0
    rows: list[tuple[str, str, str]] = []

    try:
        for desc, old, new, expect in INJECTIONS:
            n = original.count(old)
            if n != 1:
                # 锚点匹配 0 次会**伪装成「闸没抓到」**，必须当场报出来
                rows.append((desc, f"❌ 锚点匹配 {n} 次（应为 1）", "未验证"))
                print(f"\n=== {desc}\n   ❌ 锚点匹配 {n} 次，跳过（注入没生效，不能算抓到）")
                continue

            TARGET.write_text(original.replace(old, new), encoding="utf-8")
            try:
                code, out = run_spec()
                names = failed_test_names(out)
                hit = code != 0 and any(expect in n_ for n_ in names)
                if hit:
                    caught += 1
                rows.append(
                    (desc, "✅ 抓到" if hit else "❌ 漏过", expect if hit else f"exit={code}，未见「{expect}」")
                )
                print(f"\n=== {desc}\n   exit={code}  期望用例「{expect}」{'✅ 变红' if hit else '❌ 没红'}")
                if not hit:
                    print("   ---- 输出尾部 ----")
                    print("\n".join(out.splitlines()[-25:]))
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
    print(f"还原后与原文件逐字节一致：{restored}")
    print(f"还原后基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 仍是红的'}")

    ok = caught == len(INJECTIONS) and restored and code == 0
    print("\n结果：" + ("全部通过 —— 每条注入都被指定的用例抓到" if ok else "❌ 有漏网，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
