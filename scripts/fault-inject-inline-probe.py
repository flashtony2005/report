#!/usr/bin/env python3
"""故障注入：证明 `verify-inline-dataset.py` 的每条断言**真的会红**。

探针第一次跑就全绿 —— 这本身不构成证据（本项目已经栽过两次「假绿」：
docx 的子元素顺序检查是死代码、part 闭合检查被 `Default Extension="xml"` 兜住）。
所以这里逐条打掉探针依赖的那几个「承重件」，要求**指定的用例变红**。

四条注入分别打掉：
1. 解析器的数值推断 → 「明细导出成数值格」必须红
2. 数值推断的**往返一致**守卫 → 「3.50 / 007 保持原样」必须红
3. 渲染请求不带 `datasets` → 「基础渲染」必须红
4. xlsx 导出不带 `datasets` → 「明细是数值格」必须红
   （3 和 4 分开：渲染对、导出错是完全可能的，两条路各自要有人守）
5. xlsx 读法改成 `raw: false` → 「货币格式金额是数字」必须红
6. xlsx 读法去掉 `cellDates` → 「日期是 `YYYY-MM-DD`」必须红
   （5 和 6 是 `parseWorkbookFile` 那两个选项的**唯一**证据。没有它们，
   那三行 options 就是「看着合理、没人守」的代码 —— 改回 `raw: false`
   会让货币格式的金额**静默变成文本**，而这正是本模块存在的理由。）

**第 3 条是被换过的**。原先写的是「探针不摘掉样例模板自带的 datasets」，
按「不摘就会测到旧数据」的假设 —— 结果**没红**，因为假设本身错了：
`render()` 是 `tpl.datasets.extend(ds)`（`mod.rs:114`），`BTreeMap::extend` 对同名键**是覆盖**，
所以请求体的 `ds1` 本来就压过模板自带的。
→ 那次「没红」的收获是**发现了一条真实语义**，已由
`case_request_datasets_override_template_embedded` 单独钉住，而不是让探针绕开它。
**教训：注入没红时，先想「是不是我的前提错了」，而不是急着改探针。**

前两条改 `openprint/src/report/dataset-import.ts` —— 探针用 node 的
`--experimental-strip-types` **直接读 .ts**，所以改完立刻生效，不需要编译。
后两条改探针自身。

用法（需要服务在 18888 上跑着）：
    python3 scripts/fault-inject-inline-probe.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARSER = ROOT / "openprint" / "src" / "report" / "dataset-import.ts"
PROBE = ROOT / "scripts" / "verify-inline-dataset.py"

PY = sys.executable or "python3"
ANSI = re.compile(r"\x1b\[[0-9;]*m")

# 两条注入共用同一个锚点（同一行），换的是替换内容
COERCE_LINE = "    if (Number.isFinite(n) && String(n) === t) return n"

INJECTIONS: list[tuple[str, Path, str, str, str]] = [
    (
        "解析器不再推断数值（CSV 金额全变字符串）",
        PARSER,
        COERCE_LINE,
        "    if (false && Number.isFinite(n) && String(n) === t) return n",
        "case_number_detail_is_numeric_in_xlsx",
    ),
    (
        "数值推断去掉「往返一致」守卫（007 → 7、3.50 → 3.5）",
        PARSER,
        COERCE_LINE,
        "    if (Number.isFinite(n)) return n",
        "case_parser_conservatism_survives_the_whole_chain",
    ),
    (
        "渲染请求不带 datasets（模板自带那份已被摘掉 → 根本没数据）",
        PROBE,
        '        "/api/report/render",\n        {"template": sample_template_without_datasets(), "datasets": {"ds1": rows}, "sources": None, "dump": None},',
        '        "/api/report/render",\n        {"template": sample_template_without_datasets(), "datasets": None, "sources": None, "dump": None},',
        "case_basic_inline_dataset_renders",
    ),
    (
        "xlsx 导出不带 datasets（只验到渲染、没验到导出）",
        PROBE,
        '        "/api/report/xlsx",\n        {"template": sample_template_without_datasets(), "datasets": {"ds1": rows}, "sources": None, "dump": None},',
        '        "/api/report/xlsx",\n        {"template": sample_template_without_datasets(), "datasets": None, "sources": None, "dump": None},',
        "case_number_detail_is_numeric_in_xlsx",
    ),
    (
        "xlsx 读法改成 raw:false（按显示格式读 → 货币金额变 '¥1,234.50' 字符串）",
        PARSER,
        "    raw: true,\n",
        "    raw: false,\n",
        "case_xlsx_currency_cell_is_numeric",
    ),
    (
        "xlsx 读法去掉 cellDates（日期变 Excel 序列号 45293.33）",
        PARSER,
        "{ type: 'array', cellDates: true }",
        "{ type: 'array', cellDates: false }",
        "case_xlsx_date_cell_is_date_string",
    ),
]


def run_probe() -> tuple[int, str]:
    env = dict(os.environ)
    proc = subprocess.run(
        [PY, str(PROBE)], cwd=ROOT, capture_output=True, text=True, env=env
    )
    return proc.returncode, ANSI.sub("", proc.stdout + proc.stderr)


def main() -> int:
    originals = {p: p.read_text(encoding="utf-8") for p in {PARSER, PROBE}}

    code, out = run_probe()
    print(f"基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 本来就是红的，先修基线'}")
    if code != 0:
        print(out[-3000:])
        return 2

    caught = 0
    rows: list[tuple[str, str, str]] = []

    try:
        for desc, target, old, new, expect in INJECTIONS:
            src = originals[target]
            n = src.count(old)
            if n != 1:
                # 锚点匹配 0 次会**伪装成「闸没抓到」**
                rows.append((desc, f"❌ 锚点匹配 {n} 次（应为 1）", "未验证"))
                print(f"\n=== {desc}\n   ❌ 锚点匹配 {n} 次，跳过")
                continue

            target.write_text(src.replace(old, new), encoding="utf-8")
            try:
                code, out = run_probe()
                red = [ln for ln in out.splitlines() if ln.startswith("✗ ")]
                hit = code != 0 and any(expect in ln for ln in red)
                if hit:
                    caught += 1
                rows.append(
                    (desc, "✅ 抓到" if hit else "❌ 漏过", f"红的是：{red}" if hit else f"exit={code} 红：{red}")
                )
                print(f"\n=== {desc}\n   exit={code}  期望「{expect}」{'✅ 变红' if hit else '❌ 没红'}")
                if not hit:
                    print("   ---- 输出尾部 ----")
                    print("\n".join(out.splitlines()[-25:]))
            finally:
                target.write_text(originals[target], encoding="utf-8")
    finally:
        for p, text in originals.items():
            p.write_text(text, encoding="utf-8")

    restored = all(p.read_text(encoding="utf-8") == t for p, t in originals.items())
    code, _ = run_probe()

    print("\n" + "=" * 72)
    for desc, verdict, detail in rows:
        print(f"{verdict}  {desc}\n        {detail}")
    print("=" * 72)
    print(f"注入 {len(INJECTIONS)} 条，抓到 {caught} 条")
    print(f"还原后逐字节一致：{restored}")
    print(f"还原后基线：exit={code} {'✅ 全绿' if code == 0 else '❌ 仍是红的'}")

    ok = caught == len(INJECTIONS) and restored and code == 0
    print("\n结果：" + ("全部通过 —— 每条注入都被指定用例抓到" if ok else "❌ 有漏网，见上"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
