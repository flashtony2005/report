#!/usr/bin/env python3
"""故障注入：证明「AI 丢弃上报」这条链上的新断言**真的会红**。

## 为什么必须做

本 bug 的原始形态是：`normalizeControl` 对白名单外的类型静默 `return null` →
调用方 `.filter` 丢掉 → `diffSelectedControls` 把「没返回」当成「用户要删」→
`removeControl` **真删掉用户画布上的控件**，界面还弹绿色成功。

修复分四层（每层都可能「看着修好了、其实没接上」）：

    normalize.ts 上报 dropped
      → generate.ts 透出 dropped（选区）/ 当校验问题重试（整模板）
        → ai-assistant-logic.ts 的 diff 把 dropped 排除出 removedIds
          → 两个 UI 的 applySelected 真的把 dropped 传进去

只要**任何一层**忘了接，用户看到的还是「控件消失 + 成功提示」。
所以每一层都要有一条注入，要求**指定的那条用例变红**；只看退出码不算数。

## 锚点必须恰好匹配 1 次

匹配 0 次会**伪装成「闸没抓到」**（注入根本没生效），脚本当场报出来并计为漏过。

## 两个跑器

`normalize / generate / 共享 diff` 的 spec 在 `openprint`（快，~5s）；
UI 那层在 `designer-react`（~10s）。所以每条注入自带 runner。

用法：
    python3 scripts/fault-inject-ai-dropped.py
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
OPENPRINT = ROOT / "openprint"
DESIGNER = ROOT / "designer-react"

NORMALIZE = OPENPRINT / "src" / "ai" / "normalize.ts"
GENERATE = OPENPRINT / "src" / "ai" / "generate.ts"
LOGIC = OPENPRINT / "src" / "design" / "ai" / "shared" / "ai-assistant-logic.ts"
MODAL = DESIGNER / "src" / "modals" / "AiAssistantModal.tsx"

NODE = resolve_node()
# vitest 走 vite 工具链，不挂这两个 preload 会被 broker 拦（见 skill sandbox-broker-workarounds）
PRELOADS = [
    ROOT / "scripts" / "vite-safe-delete-bypass.cjs",
    ROOT / "scripts" / "broker-mkdir-throttle.cjs",
]

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# (说明, 目标文件, 原文, 替换成, runner, 期望变红的用例名子串)
INJECTIONS: list[tuple[str, Path, str, str, str, str]] = [
    (
        "第 1 层 normalize.ts：丢弃不再上报（退回静默 return null）",
        NORMALIZE,
        "    dropped.push({\n"
        "      kind: 'control',\n"
        "      type: typeName(raw.type),\n"
        "      ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),\n"
        "      reason:\n"
        "        `控件类型「${typeName(raw.type)}」不在 AI 可处理的类型里` +\n"
        "        `（可用：${VALID_TYPES.join(' / ')}），该控件已跳过。`,\n"
        "    })\n"
        "    return null",
        "    return null",
        "openprint",
        "必须出现在 dropped 里",
    ),
    (
        "第 2 层 generate.ts（选区）：透出的 dropped 恒为空",
        GENERATE,
        "    return { ok: true, controls, dropped, raw }",
        "    return { ok: true, controls, dropped: [], raw }",
        "openprint",
        "但 dropped 里有",
    ),
    (
        "第 3 层 generate.ts（整模板）：丢弃不再当成「输出不完整」（不重试）",
        GENERATE,
        "    if (result.valid && lastIssues.length === 0) {",
        "    if (result.valid) {",
        "openprint",
        "回喂重试，最终明确失败",
    ),
    (
        "第 4 层 diff：removedIds 不再排除被丢弃的 id（← 本 bug 的破坏面）",
        LOGIC,
        "  const removedIds = lockedIds.filter((id) => !returnedIds.has(id) && !droppedSet.has(id))",
        "  const removedIds = lockedIds.filter((id) => !returnedIds.has(id))",
        "openprint",
        "归一化丢掉的 id 不算删除",
    ),
    (
        "第 5 层 React UI：applySelected 不把 dropped 传进 diff（用户可见的删控件）",
        MODAL,
        "onClick={() => applySelected(m.controls!, m.dropped ?? [])}",
        "onClick={() => applySelected(m.controls!, [])}",
        "designer",
        "保持原样不删，且用 warning 说明",
    ),
]

RUNNERS: dict[str, tuple[Path, list[str]]] = {
    "openprint": (OPENPRINT, ["node_modules/vitest/vitest.mjs", "run", "src/ai", "src/design/ai"]),
    "designer": (DESIGNER, ["node_modules/vitest/vitest.mjs", "run", "src/modals/ai-assistant.spec.tsx"]),
}


def run_spec(runner: str) -> tuple[int, str]:
    cwd, argv = RUNNERS[runner]
    env = dict(os.environ)
    env["NODE_OPTIONS"] = " ".join(f"--require {p}" for p in PRELOADS)
    proc = subprocess.run(
        [NODE, *argv],
        cwd=cwd,
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.returncode, ANSI.sub("", proc.stdout + proc.stderr)


def red_names(out: str) -> list[str]:
    """vitest 的失败清单：`× <用例名>`，也有 `FAIL  <文件> > <用例名>`。"""
    return [line.strip() for line in out.splitlines() if "FAIL" in line or "×" in line]


def main() -> int:
    originals: dict[Path, str] = {
        p: p.read_text(encoding="utf-8") for p in {t[1] for t in INJECTIONS}
    }

    print("== 基线（两个跑器各跑一次）==", flush=True)
    for runner in ("openprint", "designer"):
        code, out = run_spec(runner)
        print(
            f"基线[{runner}]：exit={code} {'✅ 全绿' if code == 0 else '❌ 本来就是红的，先修基线'}",
            flush=True,
        )
        if code != 0:
            print("\n".join(out.splitlines()[-40:]))
            return 2

    caught = 0
    rows: list[tuple[str, str, str]] = []

    try:
        for desc, target, old, new, runner, expect in INJECTIONS:
            original = originals[target]
            n = original.count(old)
            if n != 1:
                rows.append((desc, f"❌ 锚点匹配 {n} 次（应为 1）", "未验证"))
                print(
                    f"\n=== {desc}\n   ❌ 锚点匹配 {n} 次，跳过（注入没生效，不能算抓到）",
                    flush=True,
                )
                continue

            target.write_text(original.replace(old, new), encoding="utf-8")
            try:
                code, out = run_spec(runner)
                names = red_names(out)
                hit = code != 0 and any(expect in x for x in names)
                if hit:
                    caught += 1
                rows.append(
                    (desc, "✅ 抓到" if hit else "❌ 漏过", expect if hit else f"exit={code}，未见「{expect}」")
                )
                print(
                    f"\n=== {desc}\n   exit={code}  期望用例「{expect}」{'✅ 变红' if hit else '❌ 没红'}",
                    flush=True,
                )
                if not hit:
                    print("   ---- 输出尾部 ----")
                    print("\n".join(out.splitlines()[-30:]))
            finally:
                target.write_text(original, encoding="utf-8")
    finally:
        for p, text in originals.items():
            p.write_text(text, encoding="utf-8")

    restored = all(p.read_text(encoding="utf-8") == t for p, t in originals.items())

    print("\n== 还原后基线 ==", flush=True)
    final = {}
    for runner in ("openprint", "designer"):
        code, _ = run_spec(runner)
        final[runner] = code
        print(f"还原后[{runner}]：exit={code} {'✅ 全绿' if code == 0 else '❌ 仍是红的'}", flush=True)

    print("\n" + "=" * 72)
    for desc, verdict, detail in rows:
        print(f"{verdict}  {desc}\n        期望用例：{detail}")
    print("=" * 72)
    print(f"注入 {len(INJECTIONS)} 条，抓到 {caught} 条")
    print(f"还原后逐字节一致：{restored}")

    ok = caught == len(INJECTIONS) and restored and all(c == 0 for c in final.values())
    print("\n结果：" + ("全部通过 —— 每条注入都被指定用例抓到" if ok else "❌ 有漏网，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
