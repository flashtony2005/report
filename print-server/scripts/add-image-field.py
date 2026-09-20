#!/usr/bin/env python3
"""给所有「缺 image 字段」的结构体字面量补一行 `image: None,`。

为什么不用正则扫全文：结构体字面量和 `-> Foo {` 长得一样（项目里踩过），
正则很容易误伤。rustc 的 E0063 直接给出**精确到行列**的位置，拿它当输入，
就不会碰错地方。

用法：先 `cargo test --no-run`，把输出喂进来。
    cargo test --no-run 2>&1 | python3 scripts/add-image-field.py
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

ERR = re.compile(r"^error\[E0063\]: missing field `image` in initializer of `model::(\w+)`")
LOC = re.compile(r"^\s+--> (src/[\w/]+\.rs):(\d+):(\d+)")


def collect(text):
    """→ {文件: [(行, 列, 结构体名)]}"""
    sites = defaultdict(list)
    pending = None
    for line in text.splitlines():
        m = ERR.match(line)
        if m:
            pending = m.group(1)
            continue
        if pending:
            m = LOC.match(line)
            if m:
                sites[m.group(1)].append((int(m.group(2)), int(m.group(3)), pending))
                pending = None
    return sites


def insert_one(lines, lineno, col, ty):
    """在第 lineno 行的 col 列起的第一个 `{` 后面插一行。"""
    i = lineno - 1
    line = lines[i]
    brace = line.find("{", col - 1)
    if brace < 0:
        raise SystemExit(f"{ty}: 第 {lineno} 行第 {col} 列起找不到 `{{`，拒绝瞎猜\n  {line!r}")
    # 缩进抄「下一个非空行」的，保持和相邻字段对齐
    indent = None
    for nxt in lines[i + 1:]:
        if nxt.strip():
            indent = nxt[: len(nxt) - len(nxt.lstrip())]
            break
    if indent is None:
        indent = line[: len(line) - len(line.lstrip())] + "    "
    lines[i] = line[: brace + 1] + "\n" + indent + "image: None," + line[brace + 1:]


def main():
    sites = collect(sys.stdin.read())
    total = sum(len(v) for v in sites.values())
    if total == 0:
        print("没有 E0063 了，无需处理")
        return
    print(f"共 {total} 处，分布在 {len(sites)} 个文件")
    for path, hits in sites.items():
        p = Path(path)
        lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
        # 从后往前插，避免前面的插入让后面的行号失效
        for lineno, col, ty in sorted(hits, reverse=True):
            insert_one(lines, lineno, col, ty)
        p.write_text("".join(lines), encoding="utf-8")
        print(f"  {path}: 插入 {len(hits)} 处")


if __name__ == "__main__":
    main()
