#!/usr/bin/env python3
"""
核对 Rust 模型与 TypeScript 镜像是否一致。**两层**：

  A. 形状层 —— 逐字段比对类型声明（`PAIRS`，24 组）
  B. 语义层 —— 规则类事实：**同一份白名单/上限在两个语言里各写了一遍**的那些表

用法：
    python3 scripts/mirror-check.py

背景：
    print-server（Rust）是展开/计算的唯一实现，openprint 与 designer-react 前端
    只描述模板、展示结果。两边靠 JSON 契约对齐，一旦字段漂移，编译期查不出来
    （Rust 端 serde 有 default，多余字段会被忽略），只能靠人工对齐。

    本脚本在无法跑 tsc / vitest 的环境里充当契约检查的替代品。

## 为什么要有 B 层（形状层不够）

形状层只对「字段名」。而**规则类事实**（图表类型白名单、码制别名、字节上限、
条件运算符、页脚上限……）两边各写了一遍 —— 这类漂移形状层**完全看不见**：
`KINDS` 从 `pie` 改成 `donut`，字段一个没变，编译也过，只是服务端能编的图表
设计器下拉里没有。所以 A 层过 ≠ 镜像一致。

## ⚠️ 两条纪律（都来自实测踩坑）

1. **锚点必须恰好匹配 1 处**。匹配 0 处（常量改名了）或 ≥2 处（正则写松了）
   都算**抽取失败**，并且**计为红**。理由是：静默跳过会让这条检查退化成
   「永远绿、但根本没在检查」—— 比红闸更坏，因为它产出的是**空头的信心**。
   判据：抽取失败的消息里必须说清「这条检查没生效」，不能只说「一致」。

2. **比对方向一律单向蕴含**，不要一律用相等。清单**故意更窄**是合法设计
   （设计器只认服务端认的一部分别名是允许的），用相等断言会把合法设计判成漂移。
   方向写在每个事实的 `mode` 上，并附一句「为什么」。

已知等价关系（不视为漂移）：
    - Rust `NumFmt`          <-> TS `CellFormatSpec`（同一 shape，名字不同）
    - Rust `ReportSource`    带 #[serde(rename_all = "camelCase")]，故 conn_id -> connId
"""
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
RUST_DIR = ROOT / "print-server" / "src" / "report"
TS_FILE = ROOT / "openprint" / "src" / "report" / "grid-report.ts"

# (rust 文件, rust 类型名, ts 类型名)
PAIRS = [
    ("model.rs", "CellModel", "CellModel"),
    ("model.rs", "CellTpl", "CellTpl"),
    ("model.rs", "RowTpl", "RowTpl"),
    ("model.rs", "SheetTpl", "SheetTpl"),
    ("model.rs", "ReportTemplate", "ReportTemplate"),
    ("model.rs", "PageConfig", "PageConfig"),
    ("model.rs", "PageMargins", "PageMargins"),
    ("model.rs", "ResolvedPageSetup", "ResolvedPageSetup"),
    ("model.rs", "GridCell", "GridCell"),
    ("model.rs", "CellImage", "CellImage"),
    ("model.rs", "CellChart", "CellChart"),
    ("model.rs", "CellChartSeries", "CellChartSeries"),
    ("model.rs", "CellBarcode", "CellBarcode"),
    ("model.rs", "CellConditional", "CellConditional"),
    ("model.rs", "ResolvedChart", "ResolvedChart"),
    ("model.rs", "ResolvedChartSeries", "ResolvedChartSeries"),
    ("model.rs", "ResolvedBarcode", "ResolvedBarcode"),
    ("model.rs", "RenderedSheet", "RenderedSheet"),
    ("model.rs", "NumFmt", "CellFormatSpec"),
    ("mod.rs", "RenderRequest", "RenderRequest"),
    ("mod.rs", "RenderResponse", "RenderResponse"),
    ("store.rs", "ReportDef", "ReportDef"),
    ("store.rs", "ReportOptions", "ReportOptions"),
    ("store.rs", "ReportSummary", "ReportSummary"),
]

# 这些 Rust 类型声明了 rename_all = "camelCase"，JSON key 与字段名不同
CAMEL_CASED = {"ReportSource", "ReportDef", "ReportOptions", "ReportSummary"}


def snake_to_camel(s: str) -> str:
    head, *rest = s.split("_")
    return head + "".join(p.title() for p in rest)


def rust_fields(path: Path, name: str) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    start = next(
        (i for i, l in enumerate(lines) if re.match(rf"pub struct\s+{name}\s*\{{", l)),
        None,
    )
    if start is None:
        return []
    depth, out = 0, []
    for line in lines[start:]:
        depth += line.count("{") - line.count("}")
        m = re.match(r"\s*pub\s+([a-z_][A-Za-z0-9_]*)\s*:", line)
        if m:
            field = m.group(1)
            out.append(snake_to_camel(field) if name in CAMEL_CASED else field)
        if depth == 0 and line.strip() == "}":
            break
    return out


def ts_fields(path: Path, name: str) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    start = next(
        (
            i
            for i, l in enumerate(lines)
            if re.match(rf"export (interface|type)\s+{name}\s*\{{", l)
        ),
        None,
    )
    if start is None:
        return []
    depth, out = 0, []
    for line in lines[start:]:
        depth += line.count("{") - line.count("}")
        stripped = line.strip()
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:", line)
        if m and not stripped.startswith(("//", "*", "/*")):
            out.append(m.group(1))
        if depth == 0 and stripped in ("}", "};"):
            break
    return out


# ───────────────────────── B 层：规则类事实 ─────────────────────────
#
# 每个抽取器返回 `Optional[list[str]]`：
#   - `None`        = **抽取失败**（锚点没匹配到 / 匹配到多处）→ 计为红
#   - `list[str]`   = 抽到的规范形式（用 `key=value` 字符串表示，便于通用比对）
#
# 刻意**不**返回 `[]` 表示「没抽到」—— 那会和「这个清单合法地为空」混在一起。


def _one(pattern: str, text: str, flags: int = 0) -> Optional[re.Match]:
    """**恰好匹配 1 处**才返回，否则 None（= 抽取失败）。

    见文件头纪律 1：匹配 0 次会伪装成「没漂移」，匹配多次说明正则写松了、
    抽到的东西不可信。两种都必须红。
    """
    ms = list(re.finditer(pattern, text, flags))
    if len(ms) != 1:
        return None
    return ms[0]


def _blank_strings(src: str) -> str:
    """把字符串字面量的**内容**换成等长空格，只为了数花括号时不被骗到。

    为什么必须做：`normalise_symbology` 里有 `format!("...{raw}...", ...)` 和 `"{}"`，
    直接数字符会把字符串里的 `{}` 也算进去。这里那两处**恰好**是配对的所以没出事，
    但只要有人加一个含**不平衡**花括号的字符串（比如 `"{"`），
    `_fn_body` 就会静默切错位置 → 抽到别的函数的臂 → 可能给出**假 OK**。
    （本项目最怕的就是「工具自己静默失准」。）

    **等长替换**是关键：索引不变，所以切出来的片段仍能按原下标去原串里取。
    """
    def repl(m: re.Match) -> str:
        s = m.group(0)
        return s[0] + " " * (len(s) - 2) + s[-1]

    src = re.sub(r'"(?:\\.|[^"\\])*"', repl, src)  # Rust / TS 双引号
    src = re.sub(r"'(?:\\.|[^'\\])*'", repl, src)  # TS 单引号
    src = re.sub(r"`(?:\\.|[^`\\])*`", repl, src)  # TS 模板串
    return src


def _fn_body(src: str, decl_pattern: str) -> Optional[str]:
    """从函数签名处按花括号配对取整个函数体（含外层花括号）。

    数花括号在 `_blank_strings` 之后的副本上做，切的位置用于**原串**。
    """
    m = _one(decl_pattern, src)
    if m is None:
        return None
    start = src.find("{", m.start())
    if start < 0:
        return None
    counts = _blank_strings(src)
    depth = 0
    for i in range(start, len(src)):
        c = counts[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
    return None


def rust_str_array(path: Path, const: str) -> Optional[list[str]]:
    """`pub const NAME: [&str; N] = ["a", "b"];`（也容忍 `&'static str`）"""
    src = path.read_text(encoding="utf-8")
    m = _one(
        rf"pub const {const}\s*:\s*\[\s*&(?:'static\s+)?str\s*;\s*\d+\s*\]\s*=\s*\[(.*?)\];",
        src,
        re.S,
    )
    if m is None:
        return None
    return re.findall(r'"([^"]+)"', m.group(1))


def ts_str_array(path: Path, const: str) -> Optional[list[str]]:
    """`export const NAME: readonly T[] = ['a', 'b']`"""
    src = path.read_text(encoding="utf-8")
    m = _one(rf"export const {const}\b[^=]*=\s*\[(.*?)\]", src, re.S)
    if m is None:
        return None
    return re.findall(r"'([^']+)'", m.group(1))


def rust_paper_names(path: Path) -> Optional[list[str]]:
    """`PAPERS` 表的名字列（每个元组的第一个元素）。"""
    src = path.read_text(encoding="utf-8")
    m = _one(r"pub const PAPERS: &\[\(&str, f64, f64, u8\)\] = &\[(.*?)\];", src, re.S)
    if m is None:
        return None
    return re.findall(r'\(\s*"([^"]+)"\s*,', m.group(1))


# 字节上限：Rust 是**两个独立常量**，TS 是**一张 Record**，名字对不上，
# 所以这里显式写出对应关系。少一个常量 → 抽取失败（不是「少一项」）。
BYTE_LIMIT_CONSTS = {"qr": "MAX_QR_BYTES", "code128": "MAX_CODE128_BYTES"}


def rust_byte_limits(path: Path) -> Optional[list[str]]:
    src = path.read_text(encoding="utf-8")
    out = []
    for sym, const in BYTE_LIMIT_CONSTS.items():
        m = _one(rf"const {const}\s*:\s*usize\s*=\s*(\d+)\s*;", src)
        if m is None:
            return None
        out.append(f"{sym}={m.group(1)}")
    return out


def ts_byte_limits(path: Path) -> Optional[list[str]]:
    src = path.read_text(encoding="utf-8")
    m = _one(r"export const BARCODE_MAX_BYTES\b[^=]*=\s*\{(.*?)\n\}", src, re.S)
    if m is None:
        return None
    pairs = re.findall(r"^\s*(\w+)\s*:\s*(\d+)\s*,", m.group(1), re.M)
    return [f"{k}={v}" for k, v in pairs]


def rust_symbology_aliases(path: Path) -> Optional[list[str]]:
    """`normalise_symbology` 里 `"a" | "b" => "canon"` 那些臂 → `a=canon`。"""
    src = path.read_text(encoding="utf-8")
    body = _fn_body(src, r"pub fn normalise_symbology\s*\(")
    if body is None:
        return None
    out = []
    for m in re.finditer(r'((?:\s*"[^"]+"\s*\|)*\s*"[^"]+")\s*=>\s*"([^"]+)"', body):
        canon = m.group(2)
        for alias in re.findall(r'"([^"]+)"', m.group(1)):
            out.append(f"{alias}={canon}")
    # 这个函数**必然**有别名臂；抽不到就说明锚点/正则失效了，不是「合法为空」
    return out or None


def ts_symbology_aliases(path: Path) -> Optional[list[str]]:
    """`normaliseSymbology` 里 `if (raw === 'a' || ...) return 'canon'` → `a=canon`。"""
    src = path.read_text(encoding="utf-8")
    body = _fn_body(src, r"export function normaliseSymbology\s*\(")
    if body is None:
        return None
    out = []
    for m in re.finditer(r"if\s*\(([^)]*)\)\s*return\s*'([^']+)'", body):
        canon = m.group(2)
        for alias in re.findall(r"raw === '([^']+)'", m.group(1)):
            out.append(f"{alias}={canon}")
    return out or None


def rust_footer_limit(path: Path) -> Optional[list[str]]:
    src = path.read_text(encoding="utf-8")
    m = _one(r"escaped_len\s*\+\s*2\s*>\s*(\d+)", src)
    return [m.group(1)] if m else None


def ts_footer_limit(path: Path) -> Optional[list[str]]:
    src = path.read_text(encoding="utf-8")
    m = _one(r"escaped\s*\+\s*2\s*>\s*(\d+)", src)
    return [m.group(1)] if m else None


def rust_issue_codes(path: Path) -> Optional[list[str]]:
    src = path.read_text(encoding="utf-8")
    codes = re.findall(r'pub const (CODE_\w+)\s*:\s*&str\s*=\s*"([^"]+)"\s*;', src)
    return [v for _, v in codes] or None


def ts_issue_codes(path: Path) -> Optional[list[str]]:
    src = path.read_text(encoding="utf-8")
    m = _one(r"export type IssueCode\s*=\s*\n((?:\s*\|[^\n]*\n)+)", src)
    if m is None:
        return None
    return re.findall(r"'([^']+)'", m.group(1)) or None


@dataclass
class Fact:
    label: str
    rust: Callable[[Path], Optional[list[str]]]
    rust_path: Path
    ts: Callable[[Path], Optional[list[str]]]
    mode: str  # equal | set_equal | ts_subset
    note: str  # 为什么是这个方向


FACTS: list[Fact] = [
    Fact(
        "纸张名清单",
        rust_paper_names,
        RUST_DIR / "model.rs",
        lambda p: ts_str_array(p, "PAPER_NAMES"),
        "equal",
        "同一张表（Rust 是真相源，TS 那份喂下拉框）。顺序也是用户可见的（下拉顺序）",
    ),
    Fact(
        "图表类型",
        lambda p: rust_str_array(p, "KINDS"),
        RUST_DIR / "chart.rs",
        lambda p: ts_str_array(p, "CHART_KINDS"),
        "equal",
        "两边都是白名单，且 TS 那份直接生成下拉项 → 顺序与内容都要一致",
    ),
    Fact(
        "码制白名单",
        lambda p: rust_str_array(p, "SYMBOLOGIES"),
        RUST_DIR / "barcode.rs",
        lambda p: ts_str_array(p, "BARCODE_SYMBOLOGIES"),
        "equal",
        "同上：服务端认的码制，设计器下拉必须一模一样",
    ),
    Fact(
        "字节上限",
        rust_byte_limits,
        RUST_DIR / "barcode.rs",
        ts_byte_limits,
        "equal",
        "**必须相等**：设计器按它显示「n / N 字节」并拦截，服务端按它报错。"
        "TS 更宽 → 界面放行、服务端拒绝；TS 更窄 → 能编的被界面拦住",
    ),
    Fact(
        "条件运算符",
        lambda p: rust_str_array(p, "NAMES"),
        RUST_DIR / "model.rs",
        lambda p: ts_str_array(p, "CONDITION_OPS"),
        "equal",
        "两边都是 8 个规范名，TS 那份生成下拉项",
    ),
    Fact(
        "码制别名",
        rust_symbology_aliases,
        RUST_DIR / "barcode.rs",
        ts_symbology_aliases,
        "ts_subset",
        "**TS ⊆ Rust**（单向）：服务端是真相源，设计器**不允许比服务端更宽** —— "
        "更宽会让界面放行一个服务端会拒绝的值。反过来更窄是合法设计",
    ),
    Fact(
        "页脚字符上限",
        rust_footer_limit,
        RUST_DIR / "model.rs",
        ts_footer_limit,
        "equal",
        "同一个 Excel 限制（255）。两边不一致时，一边拦一边放行，超了会被 Excel 静默丢掉",
    ),
    Fact(
        "诊断 code 词表",
        rust_issue_codes,
        RUST_DIR / "issue.rs",
        ts_issue_codes,
        "set_equal",
        "同一张词表。用**集合**比：TS 是 union 类型，顺序无语义（Rust 侧另有钉子测试钉值）",
    ),
]


def compare(fact: Fact) -> Optional[str]:
    """返回 None 表示一致，否则返回一句差异说明。"""
    r = fact.rust(fact.rust_path)
    t = fact.ts(TS_FILE)
    if r is None or t is None:
        # 抽取失败 = 这条检查**没有生效**，必须红。见文件头纪律 1。
        side = []
        if r is None:
            side.append(f"Rust({fact.rust_path.name})")
        if t is None:
            side.append("TS")
        return f"抽取失败：{' + '.join(side)} 的锚点没匹配到（**这条检查没有生效**，不是「一致」）"

    if fact.mode == "equal":
        if r != t:
            return f"rust={r}\n       ts  ={t}"
    elif fact.mode == "set_equal":
        if set(r) != set(t):
            only_r = [x for x in r if x not in t]
            only_t = [x for x in t if x not in r]
            return f"rust 独有={only_r}  ts 独有={only_t}"
    elif fact.mode == "ts_subset":
        extra = [x for x in t if x not in r]
        if extra:
            return f"TS 比 Rust **更宽**（不允许）：{extra}"
    else:
        return f"未知 mode：{fact.mode}"
    return None


def main() -> int:
    if not TS_FILE.exists():
        print(f"找不到 TS 镜像：{TS_FILE}", file=sys.stderr)
        return 2

    bad = 0
    print("── A. 形状层：类型逐字段 ──")
    for rust_file, rust_name, ts_name in PAIRS:
        r = rust_fields(RUST_DIR / rust_file, rust_name)
        t = ts_fields(TS_FILE, ts_name)
        if not r and not t:
            print(f"--   {rust_name}: 两边都不存在")
            continue
        only_rust = [x for x in r if x not in t]
        only_ts = [x for x in t if x not in r]
        if only_rust or only_ts:
            bad += 1
            label = rust_name if rust_name == ts_name else f"{rust_name} <-> {ts_name}"
            print(f"DIFF {label}  (rust={len(r)} ts={len(t)})")
            if only_rust:
                print(f"       rust 独有（TS 缺失）: {only_rust}")
            if only_ts:
                print(f"       TS 独有（多余）    : {only_ts}")
        else:
            print(f"OK   {rust_name:16s} {len(r)} 字段")

    # 语义层：规则类事实。漂了的话形状层**完全看不见**（字段一个都没变），
    # 症状是「服务端能编的，设计器里没有」这类 —— 界面上看不出来。
    print()
    print("── B. 语义层：规则类事实（白名单 / 上限 / 别名）──")
    for fact in FACTS:
        why = compare(fact)
        if why is None:
            n = len(fact.rust(fact.rust_path) or [])
            print(f"OK   {fact.label:16s} {n} 项")
        else:
            bad += 1
            print(f"DIFF {fact.label:16s} ({fact.mode})")
            print(f"       {why}")
            print(f"       方向依据：{fact.note}")

    print()
    print("结果：", "镜像一致（形状 + 语义）" if bad == 0 else f"{bad} 处漂移")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
