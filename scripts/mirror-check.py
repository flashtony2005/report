#!/usr/bin/env python3
"""
核对 Rust 模型与 TypeScript 镜像是否逐字段一致。

用法：
    python3 scripts/mirror-check.py

背景：
    print-server（Rust）是展开/计算的唯一实现，openprint 与 designer-react 前端
    只描述模板、展示结果。两边靠 JSON 契约对齐，一旦字段漂移，编译期查不出来
    （Rust 端 serde 有 default，多余字段会被忽略），只能靠人工对齐。

    本脚本在无法跑 tsc / vitest 的环境里充当契约检查的替代品：
    它直接解析两边的类型声明，逐字段比对，报告 rust-only / ts-only 差异。

已知等价关系（不视为漂移）：
    - Rust `NumFmt`          <-> TS `CellFormatSpec`（同一 shape，名字不同）
    - Rust `ReportSource`    带 #[serde(rename_all = "camelCase")]，故 conn_id -> connId
"""
import re
import sys
from pathlib import Path

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
    ("model.rs", "GridCell", "GridCell"),
    ("model.rs", "RenderedSheet", "RenderedSheet"),
    ("model.rs", "NumFmt", "CellFormatSpec"),
    ("mod.rs", "RenderRequest", "RenderRequest"),
    ("mod.rs", "RenderResponse", "RenderResponse"),
]

# 这些 Rust 类型声明了 rename_all = "camelCase"，JSON key 与字段名不同
CAMEL_CASED = {"ReportSource"}


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


def main() -> int:
    if not TS_FILE.exists():
        print(f"找不到 TS 镜像：{TS_FILE}", file=sys.stderr)
        return 2

    bad = 0
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

    print()
    print("结果：", "镜像一致" if bad == 0 else f"{bad} 个类型存在漂移")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
