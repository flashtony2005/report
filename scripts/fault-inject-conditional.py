#!/usr/bin/env python3
"""条件格式故障注入：逐条改坏产品代码，确认探针 / 用例**真的会红**。

## 为什么必须有这一层

「探针全绿」这句话在下面两种情况下毫无价值：
1. 探针根本没跑（早退、被 try/except 吞掉、路径写错）；
2. 探针跑了但断言是空的（`check(True, ...)`、比错了东西、只断言「没报错」）。

本仓库对这件事有硬要求：**每条注入都必须让检查变红**，红不出来就说明那条检查是摆设。
（本次写探针时真踩过一次假绿：`/api/report/xlsx` 请求失败那条路只 `print` 没记 `fails`，
脚本以 0 退出、还打印「全部通过」—— 这正是这个驱动要防的东西。）

## 注入分两类

| 类别 | 验证方式 | 注入 |
| --- | --- | --- |
| 规则优先级 | 探针 | 反过来遍历规则（最后一条命中生效） |
| 非数值守卫 | 探针 | `None` 当 0 用（空格 / 文本格被误标） |
| 区间语义 | 探针 | `between` 改成开区间（端点不含） |
| 样式合并 | 探针 | 整格替换而不是逐字段叠加（作者样式被抹掉） |
| 空样式遮蔽 | 探针 | 空样式规则留着（挡住后面那条） |
| 报错静默 | 探针 | 认不出的比较方式直接跳过、不告警 |
| 报错静默 | 探针 | `value2` 用错地方不告警 |
| 边界错 | 探针 | 上下界写反不交换（区间为空、永不命中） |
| 接线错 | 探针 | 按模板坐标查规则改成按第 0 列查 |
| UI 顺序 | 用例 | 上下移动只改界面不动数组 |
| UI 摘字段 | 用例 | 规则删光后留空数组 |
| UI 默认值 | 用例 | 新规则不带样式 |
| UI 显示条件 | 用例 | `value2` 输入框常显 |

## 用法

    python3 scripts/fault-inject-conditional.py              # 跑全部
    python3 scripts/fault-inject-conditional.py --only swap
    python3 scripts/fault-inject-conditional.py --list

退出码：0 = 每条注入都让检查红了（说明检查有牙齿）；1 = 有注入没被抓住。
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "print-server"
BIN = Path.home() / ".cargo/target/debug/print-server"
PORT = 18905
PY = "/Users/lushaohui/.workbuddy-ai/binaries/python/envs/default/bin/python"
# 沙箱里 vite 工具链必须挂这两个 preload，否则 vitest 卡死或 SIGKILL
NODE_OPTIONS = (
    "--require /Users/lushaohui/project/report/scripts/vite-safe-delete-bypass.cjs "
    "--require /Users/lushaohui/project/report/scripts/broker-mkdir-throttle.cjs"
)
SPEC = "src/modals/grid-report-cell-conditional.spec.tsx"

ENGINE = "print-server/src/report/engine.rs"
MODEL = "print-server/src/report/model.rs"
UI = "designer-react/src/modals/GridReportModal.tsx"

# (名字, 验证方式, 类别, 说明, 文件, 原文, 替换)
INJECTIONS = [
    (
        "precedence",
        "probe",
        "规则优先级",
        "规则从后往前遍历 → 变成「最后一条命中的生效」（1200 本该红，会变蓝）",
        ENGINE,
        "    for r in rules {",
        "    for r in rules.iter().rev() {",
    ),
    (
        "non-numeric",
        "probe",
        "非数值守卫",
        "`num` 是 None 时当 0 用 → 空格 / 文本格被 `lt 100`、`ge 0` 误标",
        ENGINE,
        "    let Some(x) = num else {\n        return base.filter(|s| !s.is_empty());\n    };",
        "    let x = num.unwrap_or(0.0);",
    ),
    (
        "between-closed",
        "probe",
        "区间语义",
        "between 改成开区间（端点不含）→ 100 / 200 两个端点不再命中",
        MODEL,
        "            CondOp::Between => x >= a && x <= b,",
        "            CondOp::Between => x > a && x < b,",
    ),
    (
        "merge-replace",
        "probe",
        "样式合并",
        "命中后整格替换而不是逐字段叠加 → 作者设的粗体 / 字号被抹掉",
        ENGINE,
        "            let merged = base.clone().unwrap_or_default().merged_over(&r.style);\n"
        "            return Some(merged).filter(|s| !s.is_empty());",
        "            return Some(r.style.clone());",
    ),
    (
        "empty-style-shadow",
        "probe",
        "空样式遮蔽",
        "空样式的规则留着不刷掉 → 它命中后把后面真正想生效的规则挡住",
        ENGINE,
        "        if style.is_empty() {\n"
        "            warns.push(format!(\n"
        '                "{pos} 的条件格式第 {n} 条没生效：没有样式（style 为空），命中也不会改变外观"\n'
        "            ));\n"
        "            continue;\n"
        "        }\n",
        "",
    ),
    (
        "silent-unknown-op",
        "probe",
        "报错静默",
        "认不出的比较方式直接跳过、不告警 → 规则配了却什么都没变，且无人提示",
        ENGINE,
        "            Err(e) => {\n"
        '                warns.push(format!("{pos} 的条件格式第 {n} 条没生效：{e}"));\n'
        "                continue;\n"
        "            }",
        "            Err(_e) => {\n                continue;\n            }",
    ),
    (
        "silent-value2",
        "probe",
        "报错静默",
        "`value2` 用在单值比较方式上不告警 → 作者以为在按区间比",
        ENGINE,
        "        } else if d.value2.is_some() {\n"
        "            // 静默忽略 = 作者以为在按区间比，其实只用了下界\n"
        "            warns.push(format!(\n"
        '                "{pos} 的条件格式第 {n} 条：value2 只对 between / not_between 有意义，已忽略"\n'
        "            ));\n"
        "        }",
        "        }",
    ),
    (
        "no-swap",
        "probe",
        "边界错",
        "上下界写反不交换 → 区间为空、永远不命中（静默失效）",
        ENGINE,
        "                std::mem::swap(&mut a, &mut b);",
        "                // std::mem::swap(&mut a, &mut b);",
    ),
    (
        "wiring-coord",
        "probe",
        "接线错",
        "按模板坐标查规则改成按第 0 列查 → 只有第一列的格子会带上样式",
        ENGINE,
        "                    conds.get(&(inst.tpl_row, inst.tpl_col)).map(|v| v.as_slice()).unwrap_or(&[]),",
        "                    conds.get(&(inst.tpl_row, 0)).map(|v| v.as_slice()).unwrap_or(&[]),",
    ),
    (
        "ui-move",
        "ui",
        "UI 顺序",
        "上下移动只重渲染、不改数组 → 界面上看着挪了，导出结果没变",
        UI,
        "          const next = [...rules]\n"
        "          const t = next[i]!\n"
        "          next[i] = next[j]!\n"
        "          next[j] = t\n"
        "          setRules(next)",
        "          setRules([...rules])",
    ),
    (
        "ui-empty-array",
        "ui",
        "UI 摘字段",
        "规则删光后留空数组 → JSON 里看着像配了条件格式，其实什么都没配",
        UI,
        "          patch({ conditional: next.length ? next : undefined })",
        "          patch({ conditional: next })",
    ),
    (
        "ui-no-default-style",
        "ui",
        "UI 默认值",
        "新规则不带样式 → 配出来一条「命中却什么都不改」的规则，服务端会告警",
        UI,
        "                    { when: 'gt', value: 1000, style: { color: '#FF0000' } },",
        "                    { when: 'gt', value: 1000 },",
    ),
    (
        "ui-value2-always",
        "ui",
        "UI 显示条件",
        "`value2` 输入框常显 → 单值比较方式下也让人以为在按区间比",
        UI,
        "                  {conditionOpNeedsSecond(op) && (",
        "                  {true && (",
    ),
    # ---- 探针自身的注入：确认探针的断言不是摆设 ----
    #
    # 写这个探针时真踩过两次「检查是摆设」：
    # 1. 请求失败那条早退只 `print` 没记 `fails` → 脚本以 0 退出还打印「全部通过」；
    # 2. 取颜色的正则写成 `<color rgb=`（区分大小写）→ **所有底色都读成 None**，
    #    于是「底色对不对」那条断言其实一直在比 None。
    # 两条都补了，这里把它们钉住：谁再把探针改回去，下面两条会红。
    (
        "probe-expect-bg",
        "probe",
        "探针自身",
        "把期望值改错（900 那行本该蓝）→ 探针必须红，否则它压根没在比这个",
        "scripts/verify-xlsx-conditional.py",
        "    (BLUE, None),",
        "    (RED, None),",
    ),
    (
        "probe-color-regex",
        "probe",
        "探针自身",
        "取颜色的正则改回区分大小写（`<color rgb=`）→ 底色全读成 None，那条断言失效",
        "scripts/verify-xlsx-conditional.py",
        "    m = re.search(r'color rgb=\"([0-9A-Fa-f]{6,8})\"', fragment, re.I)",
        "    m = re.search(r'<color rgb=\"([0-9A-Fa-f]{6,8})\"', fragment)",
    ),
]

OK = "\033[32m✓\033[0m"
BAD = "\033[31m✗\033[0m"


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------- 探针侧


def start_server() -> bool:
    stop_server()
    log = open("/tmp/cond-inject-server.log", "w")
    subprocess.Popen(
        [str(BIN), "--port", str(PORT)],
        cwd=SERVER,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    # **必须绕开代理**：沙箱里 http_proxy 是设着的，urllib 默认会走它，
    # 127.0.0.1 的 /health 会被代理成 502（看着像服务没起）
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(40):
        time.sleep(0.25)
        try:
            with opener.open(f"http://127.0.0.1:{PORT}/health", timeout=2):
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


def run_probe() -> list[str]:
    r = sh([PY, str(REPO / "scripts/verify-xlsx-conditional.py"), "--port", str(PORT)], cwd=REPO)
    return [] if r.returncode == 0 else ["verify-xlsx-conditional"]


# ---------------------------------------------------------------- UI 侧


def run_ui() -> list[str]:
    env = dict(os.environ, NODE_OPTIONS=NODE_OPTIONS)
    r = sh(
        ["node", "node_modules/vitest/vitest.mjs", "run", SPEC],
        cwd=REPO / "designer-react",
        env=env,
    )
    out = r.stdout + r.stderr
    if r.returncode == 0:
        # 退出码 0 也要确认**真的跑了用例**（0 个用例时 vitest 也可能退 0）
        m = re.search(r"Tests\s+(\d+) passed", out)
        if not m or int(m.group(1)) == 0:
            return [f"vitest 没跑出用例（exit=0 但 Tests=0）：{out[-400:]}"]
        return []
    return ["grid-report-cell-conditional.spec"]


# ---------------------------------------------------------------- 驱动


def baseline(kinds: set[str]) -> tuple[bool, str]:
    """基线：先确认检查本身是绿的 —— 基线本来就红的话，后面「注入后红」毫无意义"""
    if "probe" in kinds:
        if sh(["cargo", "build", "--offline"], cwd=SERVER).returncode != 0:
            return False, "基线编译不过"
        if not start_server():
            return False, "基线起不了服务"
        red = run_probe()
        stop_server()
        if red:
            return False, f"基线就是红的（{red}）—— 注入实验没有意义"
    if "ui" in kinds:
        red = run_ui()
        if red:
            return False, f"基线就是红的（{red}）"
    return True, ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只跑名字里含这个子串的注入")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for name, kind, cls, desc, *_ in INJECTIONS:
            print(f"{name:<20} [{kind}/{cls}] {desc}")
        return 0

    picked = [i for i in INJECTIONS if not args.only or args.only in i[0]]
    if not picked:
        print(f"没有匹配 --only {args.only!r} 的注入")
        return 1

    kinds = {i[1] for i in picked}
    print("== 基线 ==")
    ok, why = baseline(kinds)
    if not ok:
        print(f"{BAD} {why}")
        return 1
    print(f"{OK} 基线全绿（{', '.join(sorted(kinds))}）")

    results: list[tuple[str, str, list[str], str]] = []
    for name, kind, cls, desc, rel, old, new in picked:
        path = REPO / rel
        original = path.read_text(encoding="utf-8")
        n = original.count(old)
        if n != 1:
            print(f"{BAD} {name}: 注入锚点在 {rel} 里匹配到 {n} 处（应当恰好 1 处）")
            results.append((name, cls, [], "锚点失效"))
            continue
        path.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            if kind == "probe":
                build = sh(["cargo", "build", "--offline"], cwd=SERVER)
                if build.returncode != 0:
                    results.append((name, cls, [], "编译失败"))
                    print(f"  · {name}: 注入后编译不过（算抓住，但不是探针抓的）")
                    continue
                if not start_server():
                    results.append((name, cls, [], "服务起不来"))
                    print(f"  · {name}: 注入后服务起不来（算抓住）")
                    continue
                red = run_probe()
                stop_server()
            else:
                red = run_ui()
            results.append((name, cls, red, "检查红了" if red else "检查没红"))
            if red:
                print(f"  {OK} {name:<20} [{cls}] → {', '.join(red)} 红了")
            else:
                print(f"  {BAD} {name:<20} [{cls}] → 检查**没红**（这条检查是摆设）")
        finally:
            path.write_text(original, encoding="utf-8")

    # 还原后必须回到全绿，否则说明还原没干净
    print("\n== 还原后复验 ==")
    ok, why = baseline(kinds)
    if not ok:
        print(f"{BAD} 还原后不是全绿：{why}")
        return 1
    print(f"{OK} 还原后 {', '.join(sorted(kinds))} 都回到全绿")

    missed = [r for r in results if not r[2]]
    print()
    print(f"注入 {len(results)} 条，被抓住 {len(results) - len(missed)} 条")
    if missed:
        print(f"{BAD} 这些注入**没被抓住**，说明对应的检查是摆设：")
        for name, cls, _, why in missed:
            print(f"  - {name} [{cls}] {why}")
        return 1
    print(f"{OK} 每条注入都让检查红了 —— 检查有牙齿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
