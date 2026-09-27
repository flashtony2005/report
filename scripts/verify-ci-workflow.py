#!/usr/bin/env python3
"""校验 `.github/workflows/ci.yml` —— 因为「Actions 真的会触发」这件事我验不了。

## 为什么需要这个脚本（它替代的是哪一句话）

加 CI 的**唯一**目的就是让闸自己跑起来。但我（写这个 CI 的人）**证明不了
GitHub Actions 真的会触发** —— 本机 `gh` 装了却没登录，也没法推一条分支去看结果。

于是能给出的最诚实的保证是这一句：

> **CI 会跑的那些命令，就是我在这里逐条跑过、并且跑通了的命令。**

这个脚本就是来兑现那句话的。它做三件事：

1. **静态校验**结构（是不是合法 workflow、有没有吞退出码、action 有没有钉版本…）；
2. **逐条执行**那些在本地跑得动的步骤，把真实退出码报出来；
3. **明说没验什么**（Actions 会不会触发、`npm ci` 在 ubuntu 上行不行…）。

## 为什么「不许吞退出码」是一条硬检查

`check-all.sh` 的退出码是**三态**：0 通过 / 1 失败 / **2 没跑成**。
CI 里三者都必须让 job 红。下面这些写法会让它悄悄变绿 —— 而且**都是本项目踩过的**：

- `continue-on-error: true` → 那一步红了也不算红；
- `... || true` → 退出码被吃掉；
- `bash scripts/check-all.sh | tail -20` → **`$?` 是 `tail` 的**，恒 0
  （2026-09-27 实测踩过一次：探针崩了也打印 `EXIT=0`）。

所以这三条各有一条断言，而且**各有一条故障注入证明它真会红**（见 `--self-test`）。

## 用法

    python3 scripts/verify-ci-workflow.py              # 静态校验 + 执行可本地执行的步骤
    python3 scripts/verify-ci-workflow.py --static     # 只静态校验（秒级）
    python3 scripts/verify-ci-workflow.py --self-test  # 证明上面的断言有牙齿（改副本，不碰真文件）
    python3 scripts/verify-ci-workflow.py --fingerprint  # 打印被测源码树的指纹（调试用）

退出码：0 全通过 / 1 有失败 / 2 **没跑成**（缺 PyYAML、找不到 workflow 文件、
**或跑的过程中被测文件被改动** —— 那一条红不可复现，绝不能冒充回归）。

## 「跑的时候别改文件」为什么是一条断言（2026-09-27 用一轮假红换来）

bash **按字节偏移增量读脚本**。边跑 `check-all.sh` 边改它，它就会从旧偏移继续读新内容
→ 报 `line 200: syntax error: unexpected end of file`（文件当时只有 194 行）。
事后 `bash -n` 是**绿的**，所以这条假红**没法复现** —— 只能靠跑前跑后比指纹识别。
**证明守卫有牙齿**：跑全量时另开一个终端 `touch scripts/check-all.sh`，应看到
「结论无效」+ 退出码 2（而**不是** 1）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

# 被测对象在**跑的过程中被改动** → 结论无效（见 `fingerprint()` 的注释）。
# 只盯「闸真正读到的东西」，不盯 `.workbuddy-ai/` 之类的旁支 ——
# 否则跑的时候写个记忆日志都会误报。
FINGERPRINT_DIRS = (
    "scripts",
    ".github/workflows",
    "print-server/src",
    "openprint/src",
    "designer-react/src",
)

# CI 里那一步「跑闸」必须是这条命令 —— 与本地入口**逐字相同**。
# 换一种写法就等于 CI 与本地各跑各的，慢慢漂开（那本身就是一种静默失败）。
GATE_COMMAND = "bash scripts/check-all.sh"

# 本地不执行、只静态校验的步骤：它们是**环境准备**，不是闸，
# 而且会重装 node_modules（本机沙箱装不出依赖，跑了只会得到假红）。
SKIP_LOCAL_PREFIXES = ("npm ci", "npm install")


class Unverifiable(Exception):
    """环境缺东西 → 退出码 2（「没跑成」），**不等于通过**。"""


def load_workflow(path: Path = WORKFLOW) -> dict:
    try:
        import yaml  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise Unverifiable(
            f"缺 PyYAML，无法解析 workflow：{e}\n"
            "（静态校验做不了就报「没跑成」，**不能**当成通过。）"
        ) from e
    if not path.is_file():
        raise Unverifiable(f"找不到 workflow 文件：{path}")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def iter_steps(wf: dict):
    """产出 (job名, 下标, step)。"""
    jobs = wf.get("jobs") or {}
    for job_name, job in jobs.items():
        for i, step in enumerate(job.get("steps") or []):
            yield job_name, i, step, job


def static_checks(wf: dict) -> list[str]:
    """返回问题列表（空 = 全过）。"""
    problems: list[str] = []

    if not wf.get("jobs"):
        problems.append("workflow 里没有 jobs")
        return problems

    # 触发条件必须包含 pull_request —— 否则闸只在 main 上跑，PR 阶段没有保护。
    on = wf.get("on") or wf.get(True)  # YAML 把裸 `on:` 解析成布尔 True
    on_text = json.dumps(on, ensure_ascii=False)
    if "pull_request" not in on_text:
        problems.append("触发条件里没有 pull_request（PR 阶段就没有闸了）")

    gate_steps = []
    for job_name, i, step, job in iter_steps(wf):
        where = f"{job_name}.steps[{i}]"

        has_run, has_uses = "run" in step, "uses" in step
        if has_run == has_uses:
            problems.append(f"{where}: 必须**恰好**有 run 或 uses 之一")
            continue

        if "runs-on" not in job:
            problems.append(f"{job_name}: 缺 runs-on")

        if has_uses:
            ref = str(step["uses"])
            if "@" not in ref:
                problems.append(f"{where}: uses 没钉版本（`{ref}`）—— 裸引用有供应链风险")
            continue

        # —— run 步骤 ——
        run = str(step["run"])

        # ⚠️ 不许吞退出码：三条各一条断言。
        if step.get("continue-on-error") is True:
            problems.append(f"{where}: continue-on-error: true —— 这步红了也不算红")
        if re.search(r"\|\|\s*(true|:)\s*$", run, re.M):
            problems.append(f"{where}: `|| true` 把退出码吃掉了")
        if re.search(r"\|\s*(tail|head|cat|tee)\b", run):
            problems.append(
                f"{where}: 闸的输出进了管道（`| tail/head/...`）—— "
                "`$?` 会变成管道最后一个命令的，恒 0"
            )

        # working-directory 必须真的存在
        wd = step.get("working-directory")
        if wd and not (ROOT / str(wd)).is_dir():
            problems.append(f"{where}: working-directory 不存在：{wd}")

        # run 里引用的仓库脚本必须存在
        for m in re.finditer(r"scripts/[A-Za-z0-9_.\-]+\.(sh|py)", run):
            if not (ROOT / m.group(0)).is_file():
                problems.append(f"{where}: 引用了不存在的脚本：{m.group(0)}")

        if run.strip() == GATE_COMMAND:
            gate_steps.append(where)

    if len(gate_steps) != 1:
        problems.append(
            f"「{GATE_COMMAND}」应当**恰好出现 1 次**，实际 {len(gate_steps)} 次 "
            f"({gate_steps})—— CI 必须跑与本地同一条命令，多一条/少一条都意味着两边会漂开"
        )

    return problems


def runnable_steps(wf: dict):
    """挑出可以在本地真跑的步骤：是 `run`、且不是装依赖。

    只挑「闸」类的（调用仓库脚本或 cargo）—— 装依赖在本地会重装 node_modules，
    而本机沙箱装不出依赖，跑了只会得到假红。
    """
    for job_name, i, step, _job in iter_steps(wf):
        run = step.get("run")
        if run is None:
            continue
        cmd = str(run).strip()
        if any(cmd.startswith(p) for p in SKIP_LOCAL_PREFIXES):
            yield job_name, i, cmd, step.get("working-directory"), "装依赖（环境准备，本地不重装）"
            continue
        if re.search(r"(bash|sh|python3?)\s+scripts/|cargo\s+test", cmd):
            yield job_name, i, cmd, step.get("working-directory"), None
        else:
            yield job_name, i, cmd, step.get("working-directory"), "不认识这步，本地不跑"


def execute(job_name, i, cmd, wd, skip_reason) -> tuple[bool, str]:
    where = f"{job_name}.steps[{i}]"
    if skip_reason:
        return True, f"跳过（{skip_reason}）：{cmd}"
    cwd = str(ROOT / str(wd)) if wd else str(ROOT)
    print(f"    ▸ {where}: {cmd}")
    print(f"      cwd={cwd}")
    # 刻意**不进管道** —— 要的就是它自己的退出码（这正是本脚本第 3 条断言的由来）。
    proc = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    tail = (proc.stdout or "").strip().splitlines()[-4:]
    for line in tail:
        print(f"      | {line}")
    if proc.returncode == 0:
        return True, f"{where} 退出码 0"
    return False, f"{where} 退出码 {proc.returncode}（stderr 末行：{(proc.stderr or '').strip().splitlines()[-1:] or '空'}）"


# ─────────────────────────── 故障注入：证明断言有牙齿 ───────────────────────────
#
# 每条注入改**副本**、不碰真文件。期望：静态校验**必须**报出对应的问题。
# 如果某条注入下校验仍然是绿的，说明那条断言是摆设。
INJECTIONS: list[tuple[str, str, str, str]] = [
    (
        "吞掉退出码：continue-on-error",
        "        run: bash scripts/check-all.sh",
        "        continue-on-error: true\n        run: bash scripts/check-all.sh",
        "continue-on-error",
    ),
    (
        "吞掉退出码：|| true",
        "run: bash scripts/check-all.sh",
        "run: bash scripts/check-all.sh || true",
        "|| true",
    ),
    (
        "吞掉退出码：闸的输出进管道",
        "run: bash scripts/check-all.sh",
        "run: bash scripts/check-all.sh | tail -20",
        "进了管道",
    ),
    (
        "闸命令被改掉（CI 与本地漂开）",
        "run: bash scripts/check-all.sh",
        "run: bash scripts/check-all.sh --fast",
        "恰好出现 1 次",
    ),
    (
        "action 没钉版本",
        "uses: actions/checkout@v4",
        "uses: actions/checkout",
        "没钉版本",
    ),
    (
        "working-directory 指向不存在的目录",
        "working-directory: designer-react",
        "working-directory: designer-react-nonexistent",
        "working-directory 不存在",
    ),
    (
        "引用了不存在的脚本",
        "run: bash scripts/check-all.sh",
        "run: bash scripts/check-all-typo.sh",
        "不存在的脚本",
    ),
]


def self_test() -> int:
    """故障注入：改**副本**、不碰真文件。

    （第一版是就地改真文件 + `finally` 还原 —— 那样一旦进程被杀，仓库里就留下一个
     被注入过的 workflow。改副本没有这个风险，而且同样能证明断言有牙齿。）
    """
    original = WORKFLOW.read_text(encoding="utf-8")
    print("故障注入：证明静态校验的每条断言都真的会红（改临时副本，不碰真文件）")
    caught = missed = 0
    with tempfile.TemporaryDirectory(prefix="ci-selftest-") as tmp:
        probe = Path(tmp) / "ci.yml"
        for name, old, new, expect in INJECTIONS:
            if original.count(old) != 1:
                print(f"  ✗ 锚点失效（匹配 {original.count(old)} 处）：{name}")
                missed += 1
                continue
            probe.write_text(original.replace(old, new, 1), encoding="utf-8")
            try:
                problems = static_checks(load_workflow(probe))
            except Unverifiable as e:
                problems = [str(e)]
            if any(expect in p for p in problems):
                print(f"  ✓ 如期变红  {name}")
                caught += 1
            else:
                print(f"  ✗ 没抓到！ {name}  —— 期望报出含「{expect}」的问题，实际：{problems}")
                missed += 1

        # 未注入的副本必须全绿 —— 否则上面那些「如期变红」可能来自别的原因。
        # ⚠️ 必须先把**原始内容**写回 probe：第一版忘了这一步，于是「基线」其实还在
        #    跑最后一条注入的内容 → 假红。（这就是「基线必须先绿」那条纪律的用处：
        #    它当场把脚本自己的 bug 抓了出来。）
        probe.write_text(original, encoding="utf-8")
        baseline = static_checks(load_workflow(probe))
        print(f"\n  基线复验（未注入的副本）：{'绿 ✓' if not baseline else f'红 ✗ {baseline}'}")
        if baseline:
            missed += 1

    # 真文件必须逐字节没变
    after = WORKFLOW.read_text(encoding="utf-8")
    same = after == original
    print(f"  真文件未被改动：{'✓' if same else '✗ —— 它被改了，这本身就是 bug'}")
    if not same:
        missed += 1

    # 「跑的时候文件被改动」这道守卫的**灵敏度** —— 它要是测不出变化，
    # 守卫就成了摆设（而且是最坏的那种：永远绿、永远说「没人动过」）。
    print("\n  指纹守卫灵敏度：")
    scratch = ROOT / "scripts" / ".fingerprint-probe.tmp"
    try:
        scratch.write_text("probe-a\n", encoding="utf-8")
        h1 = fingerprint()
        scratch.write_text("probe-b\n", encoding="utf-8")
        h2 = fingerprint()
        sensitive = h1 != h2
        print(f"    改一个字节后指纹{'变了 ✓' if sensitive else '没变 ✗ —— 守卫是摆设'}")
        if not sensitive:
            missed += 1
        # 反向：内容不变时指纹必须**稳定**，否则守卫会到处误报。
        scratch.write_text("probe-a\n", encoding="utf-8")
        stable = fingerprint() == h1
        print(f"    内容复原后指纹{'回到原值 ✓' if stable else '没回原值 ✗ —— 会误报'}")
        if not stable:
            missed += 1
    finally:
        scratch.unlink(missing_ok=True)

    print(f"\n{caught} 条抓到 / {missed} 条漏网")
    return 0 if missed == 0 else 1


def fingerprint() -> str:
    """被测源码树的指纹 —— 用来证明「跑的过程中没人动过它」。

    **为什么非要这个**（2026-09-27 实测踩过，代价是一轮 3.5 分钟的假红）：
    bash **按字节偏移增量读脚本**，不是先整份读进内存。所以边跑边改
    `check-all.sh` 会让它从「旧文件的某个偏移」继续读**新文件**的内容 ——
    于是报 `scripts/check-all.sh: line 200: syntax error: unexpected end of file`
    （那个文件当时只有 194 行，行号本身就说明读到的是拼接出来的乱码）。
    更坏的是：`bash -n` 事后是**绿的**，所以这条假红**没法复现**，只能靠指纹识别。

    判据：**结论不可复现的红，先问「跑的时候我是不是还在改文件」。**
    """
    h = hashlib.sha256()
    for rel in FINGERPRINT_DIRS:
        base = ROOT / rel
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file() or "node_modules" in p.parts:
                continue
            h.update(str(p.relative_to(ROOT)).encode("utf-8"))
            h.update(b"\0")
            h.update(p.read_bytes())
            h.update(b"\0")
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="校验 CI workflow，并执行它能跑的命令")
    ap.add_argument("--static", action="store_true", help="只静态校验，不执行任何命令")
    ap.add_argument("--self-test", action="store_true", help="故障注入：证明断言有牙齿")
    ap.add_argument("--fingerprint", action="store_true", help="打印被测源码树指纹后退出")
    args = ap.parse_args()

    if args.fingerprint:
        print(fingerprint())
        return 0

    if args.self_test:
        return self_test()

    try:
        wf = load_workflow()
    except Unverifiable as e:
        print(f"⚠ 没跑成：{e}", file=sys.stderr)
        return 2

    print(f"workflow：{WORKFLOW.relative_to(ROOT)}")

    print("\n── 1. 静态校验 ──")
    problems = static_checks(wf)
    if problems:
        for p in problems:
            print(f"  ✗ {p}")
        print(f"\n静态校验：{len(problems)} 个问题")
        return 1
    print("  ✓ 结构 / 不吞退出码 / action 钉版本 / 路径存在 / 闸命令唯一且与本地相同")

    if args.static:
        print("\n（--static：不执行任何命令）")
    else:
        print("\n── 2. 逐条执行「本地跑得动」的步骤 ──")
        before = fingerprint()
        ok = True
        for job_name, i, cmd, wd, skip in runnable_steps(wf):
            good, msg = execute(job_name, i, cmd, wd, skip)
            print(f"      {'✓' if good else '✗'} {msg}")
            ok = ok and good
        after = fingerprint()
        if before != after:
            # **不是**「失败」，是「没跑成」→ 2。这条红不可复现，别让它冒充回归。
            print(
                "\n⚠ 跑的过程中被测文件被改动过（指纹变了）—— 这一轮的结论**无效**，"
                "重跑一次再来下结论。\n"
                "  （bash 按字节偏移增量读脚本：边跑边改 = 读到新旧拼接的内容，"
                "会报莫名其妙的 syntax error，而事后 `bash -n` 是绿的。）"
            )
            return 2
        if not ok:
            print("\n有步骤在本地就失败了 —— 那 CI 上更不会过。")
            return 1

    print("\n── 3. 这个脚本**没有**验证什么（诚实标注）──")
    print("  · GitHub Actions 是否真的会触发（本机 gh 未登录，推分支看结果也不可得）")
    print("  · `npm ci` 在 ubuntu 上能不能装成功（本机沙箱装不出依赖，没跑过）")
    print("  · 设计器 UI 单测在 2 核 runner 上会不会因 CPU 争抢而超时（见 ci.yml 顶部）")
    print("  · 20 个 fault-inject / 17 个 verify **不在 CI 里**，所以 CI 的保证")
    print("    不多不少就是 `check-all.sh` 的保证。")
    print("\n✓ CI 会跑的命令，就是本脚本在上面逐条跑通的那些。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
