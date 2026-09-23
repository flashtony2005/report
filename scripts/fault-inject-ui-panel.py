#!/usr/bin/env python3
"""反证：证明设计器面板的 UI 用例**真的有牙齿** —— 故意注入故障，确认用例会红。

用法：
    python3 scripts/fault-inject-ui-panel.py
    python3 scripts/fault-inject-ui-panel.py --only gs1
    python3 scripts/fault-inject-ui-panel.py --list

## 为什么 UI 用例也要反证

`grid-report-cell-barcode.spec.tsx` / `grid-report-cell-chart.spec.tsx` 全绿
只说明**当前实现是对的**，不说明**用例能发现错**。本项目在这一点上吃过亏
（带着画不出的橙色边框过了 11 条单测并提交），所以照 Rust 探针的做法反证一遍。

## 三条纪律（见 skill `fault-injection-verify`）

1. **基线先绿**，还原后**复验绿**；
2. **锚点必须恰好匹配 1 处**，否则报「锚点失效」并**算作没抓到**；
3. **注入造成的行为差异必须能被某条断言观察到** —— 红不出来先怀疑注入点，
   别先怀疑用例。

## 沙箱注意

vitest 走 vite 工具链，**必须挂 preload**，否则会卡几十分钟然后报一堆
`CODEBUDDY_BROKER_DENY`（看着像「测试全挂了」）。见 skill
`sandbox-broker-workarounds` 第 2b 节。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_bin import resolve_node  # noqa: E402  （必须在 sys.path 之后）

ROOT = Path(__file__).resolve().parent.parent
MODAL = "designer-react/src/modals/GridReportModal.tsx"
GR = "openprint/src/report/grid-report.ts"
BARCODE_SPEC = "src/modals/grid-report-cell-barcode.spec.tsx"
CHART_SPEC = "src/modals/grid-report-cell-chart.spec.tsx"
# 服务端错误文案要活着到界面（#74 的客户端一侧）
ERROR_SPEC = "src/modals/grid-report-render-error.spec.tsx"

# node 路径**不写死**：版本后缀是环境发的，写死过一次就整个跑不起来（见 node_bin.py）
NODE = resolve_node()
# 不挂这两个 preload，vitest 会被 broker 拦（见模块注释）
PRELOAD = (
    f"--require {ROOT / 'scripts/vite-safe-delete-bypass.cjs'} "
    f"--require {ROOT / 'scripts/broker-mkdir-throttle.cjs'}"
)

# (名字, 错误类, 说明, 文件, 原串, 新串, 应当变红的 spec)
INJECTIONS = [
    (
        "barcode-clear",
        "摘字段",
        "切回「不出码」时留个空 barcode（服务端会出一格 `[条码: 内容为空]`）",
        MODAL,
        "                  if (!v) {\n                    patch({ barcode: undefined })\n                    return\n                  }",
        "                  if (!v) {\n                    patch({ barcode: { from: 'literal', value: '' } })\n                    return\n                  }",
        BARCODE_SPEC,
    ),
    (
        "gs1-leak",
        "摘字段",
        "切回二维码时不摘 gs1 → 模板里留一个设了不起作用的开关",
        MODAL,
        "                    if (!isGs1Relevant(v)) next.gs1 = undefined",
        "                    if (false) next.gs1 = undefined",
        BARCODE_SPEC,
    ),
    (
        "gs1-always",
        "显示条件错",
        "GS1 开关对二维码也显示（「设了没反应」）",
        MODAL,
        "              {!!bc && isGs1Relevant(sym) && (",
        "              {!!bc && (",
        BARCODE_SPEC,
    ),
    (
        "no-capacity-check",
        "漏校验",
        "条码不做容量 / 字符集校验 → 作者填完要等一次导出才知道填错了",
        MODAL,
        "        const problem = barcodeProblem(bc)",
        "        const problem = null as string | null",
        BARCODE_SPEC,
    ),
    (
        "chart-clear",
        "摘字段",
        "切回「不出图」时留个空 chart（服务端会出一格 `[图表: 原因]`）",
        MODAL,
        "                  if (!v) {\n                    patch({ chart: undefined })\n                    return\n                  }",
        "                  if (!v) {\n                    patch({ chart: { kind: 'bar', series: [] } })\n                    return\n                  }",
        CHART_SPEC,
    ),
    (
        "chart-no-series",
        "接线漏拷",
        "开图表时不带空序列 → 下面没有输入行可填，作者以为配好了",
        MODAL,
        "                      series: ch?.series?.length ? ch.series : [{ from: '' }],",
        "                      series: ch?.series ?? [],",
        CHART_SPEC,
    ),
    (
        "chart-cats-not-split",
        "语义错",
        "类目输入不按逗号切分（`A3,A4` 变成一个坐标）",
        MODAL,
        "                            .split(',')\n",
        "                            .split('\\u0000')\n",
        CHART_SPEC,
    ),
    (
        "chart-no-problem",
        "漏校验",
        "图表不做声明校验（坐标填成值也不说）",
        MODAL,
        "        const problem = chartProblem(ch)",
        "        const problem = null as string | null",
        CHART_SPEC,
    ),
    (
        "conflict-threshold",
        "优先级错",
        "冲突提示的门槛改成 3 → 同时设两个也不提示",
        MODAL,
        "        if (kinds.length < 2) return null",
        "        if (kinds.length < 3) return null",
        BARCODE_SPEC,
    ),
    (
        "pos-not-validated",
        "漏校验",
        "坐标不校验形状（填「华东」这种值也放行）",
        GR,
        "  const badPos = [...cats, ...series.map((s) => s.from.trim())].find((p) => parsePos(p) === null)\n",
        "  const badPos = undefined as string | undefined\n",
        CHART_SPEC,
    ),
    # ---- #74 的客户端一侧：服务端「报错点名哪一格」白做，除非界面把它显示出来 ----
    (
        "render-error-detail",
        "吞掉错误文案",
        "预览失败时不回落到纯文本错误体 → 只剩「服务端返回 400」，格子名丢了",
        MODAL,
        "          const detail = (payload as { message?: string }).message || text.trim()\n"
        "          throw new Error(detail || `服务端返回 ${res.status}`)",
        "          throw new Error((payload as { message?: string }).message || `服务端返回 ${res.status}`)",
        ERROR_SPEC,
    ),
    (
        "export-error-detail",
        "吞掉错误文案",
        "导出失败时不读错误体 → 只剩「导出失败：400」",
        MODAL,
        "        const detail = (await res.text()).trim()\n"
        "        throw new Error(detail ? `导出失败：${detail}` : `导出失败：${res.status}`)",
        "        throw new Error(`导出失败：${res.status}`)",
        ERROR_SPEC,
    ),
]

OK = "\033[32m✓\033[0m"
BAD = "\033[31m✗\033[0m"


def run_spec(spec: str) -> bool:
    """跑一个 spec，返回是否全绿"""
    env = dict(os.environ, NODE_OPTIONS=PRELOAD)
    r = subprocess.run(
        [NODE, "node_modules/.bin/vitest", "run", spec],
        cwd=ROOT / "designer-react",
        env=env,
        capture_output=True,
        text=True,
    )
    return r.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只跑名字里含这个子串的注入")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for name, cls, desc, *_ in INJECTIONS:
            print(f"{name:<22} [{cls}] {desc}")
        return 0

    picked = [i for i in INJECTIONS if not args.only or args.only in i[0]]
    if not picked:
        print(f"没有匹配 --only {args.only!r} 的注入")
        return 1

    # 基线：两个 spec 都得绿，否则「注入后红」毫无意义
    print("== 基线 ==")
    specs = sorted({i[6] for i in picked})
    for spec in specs:
        if not run_spec(spec):
            print(f"{BAD} 基线就是红的（{spec}）—— 注入实验没有意义，先修基线")
            return 1
    print(f"{OK} 基线全绿（{len(specs)} 个 spec）")

    results: list[tuple[str, str, bool, str]] = []
    for name, cls, desc, rel, old, new, spec in picked:
        path = ROOT / rel
        original = path.read_text(encoding="utf-8")
        # 锚点失配**算作没抓到**，别静默跳过
        if original.count(old) != 1:
            print(f"{BAD} {name}: 注入锚点在 {rel} 里匹配到 {original.count(old)} 处（应当恰好 1 处）")
            results.append((name, cls, False, "锚点失效"))
            continue
        path.write_text(original.replace(old, new, 1), encoding="utf-8")
        try:
            red = not run_spec(spec)
            results.append((name, cls, red, "用例红了" if red else "用例没红"))
            if red:
                print(f"  {OK} {name:<20} [{cls}] → 用例红了")
            else:
                print(f"  {BAD} {name:<20} [{cls}] → 用例**没红**（这条检查是摆设）")
        finally:
            path.write_text(original, encoding="utf-8")

    # 还原后必须回到全绿，否则说明还原没干净
    print("\n== 还原后复验 ==")
    for spec in specs:
        if not run_spec(spec):
            print(f"{BAD} 还原后 {spec} 还是红的 —— 有文件没恢复干净")
            return 1
    print(f"{OK} 还原后 {len(specs)} 个 spec 都回到全绿")

    missed = [r for r in results if not r[2]]
    print()
    print(f"注入 {len(results)} 条，被用例抓住 {len(results) - len(missed)} 条")
    if missed:
        print(f"{BAD} 这些注入**没被抓住**，说明对应的检查是摆设：")
        for name, cls, _, why in missed:
            print(f"  - {name} [{cls}] {why}")
        return 1
    print(f"{OK} 每条注入都让用例红了 —— 用例有牙齿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
