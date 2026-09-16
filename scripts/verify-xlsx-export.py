#!/usr/bin/env python3
"""校验导出的 xlsx 真的带上了边框与「打印时表头跨页重复」。

为什么要这个脚本：这两件事**单测证明不了** —— 内容是 zip 压缩过的，
Rust 侧只能断言 `to_xlsx` 不报错。而「导出后是裸表」「第 2 页起没有表头」
这类问题靠肉眼看截图也容易漏。所以直接拆 zip 读 XML 来判断。

用法：
    python3 scripts/verify-xlsx-export.py 导出的文件.xlsx [--expect-repeat N]

    --expect-repeat N  断言重复的表头行数是 N（对应模板的 repeat_header_rows）

退出码：全部通过 0，任何一项不满足 1。
"""
import argparse
import re
import sys
import zipfile


def cellxfs_entries(styles_xml: str) -> list[str]:
    m = re.search(r'<cellXfs count="\d+">(.*?)</cellXfs>', styles_xml, re.S)
    if not m:
        return []
    # 条目可能是自闭合 <xf .../>，也可能带 <alignment> 子节点
    return re.findall(r'<xf\b.*?(?:/>|</xf>)', m.group(1), re.S)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--expect-repeat", type=int, default=None)
    args = ap.parse_args()

    try:
        z = zipfile.ZipFile(args.xlsx)
    except (OSError, zipfile.BadZipFile) as e:
        print(f"✗ 打不开 {args.xlsx}: {e}")
        return 1

    errors: list[str] = []

    # ---- 1. 边框 ----
    styles = z.read("xl/styles.xml").decode("utf8", "ignore")
    borders = re.findall(r"<border>.*?</border>", styles, re.S)
    thin = [b for b in borders if "thin" in b]
    if not thin:
        errors.append("styles.xml 里没有 thin 边框 —— 导出的是「裸表」")

    entries = cellxfs_entries(styles)
    if not entries:
        errors.append("styles.xml 里解析不到 cellXfs")

    # ---- 2. 每个被单元格用到的格式都得有边框 ----
    used: set[int] = set()
    for name in z.namelist():
        if name.startswith("xl/worksheets/") and name.endswith(".xml"):
            sh = z.read(name).decode("utf8", "ignore")
            used |= {int(s) for s in re.findall(r'<c [^>]*s="(\d+)"', sh)}
            # 没有 s 属性 = 用默认格式 = **没有边框**。
            # 只盯着 s="…" 会漏掉这一类（去掉边框后整列单元格都变成没有 s），
            # 探针验证时正是这样「通过」的，所以必须单独数。
            cells = re.findall(r"<c\b[^>]*>", sh)
            bare = [c for c in cells if not re.search(r'\bs="', c)]
            if bare:
                errors.append(f"{name}: {len(bare)}/{len(cells)} 个单元格没有格式（默认样式=无边框）")
    if not used:
        errors.append("工作表里没有带格式的单元格（s 属性一个都没有）")
    for i in sorted(used):
        if i >= len(entries):
            errors.append(f"单元格引用了不存在的格式 xf[{i}]")
            continue
        bid = re.search(r'borderId="(\d+)"', entries[i])
        if not bid or bid.group(1) == "0":
            errors.append(f"xf[{i}] 没有边框（borderId={bid.group(1) if bid else '?'}）—— 网格会有缺口")

    # ---- 3. 打印时表头跨页重复 ----
    wb = z.read("xl/workbook.xml").decode("utf8", "ignore")
    titles = re.findall(
        r'<definedName[^>]*name="_xlnm\.Print_Titles"[^>]*>([^<]*)<', wb
    )
    if not titles:
        errors.append("workbook.xml 里没有 _xlnm.Print_Titles —— 打印时表头不会跨页重复")
    elif args.expect_repeat is not None:
        want = f"$1:${args.expect_repeat}"
        bad = [t for t in titles if not t.endswith(want)]
        if bad:
            errors.append(f"重复表头行数不对：期望 {want}，实际 {bad}")

    print(f"文件        : {args.xlsx}")
    print(f"thin 边框   : {len(thin)} 个定义")
    print(f"单元格格式  : 用到 {sorted(used)}，全部带边框 = {not any('边框' in e for e in errors)}")
    print(f"重复表头    : {titles or '（无）'}")

    # ---- 4. 缩放：列多时否则会溢出到右侧多出半页 ----
    for name in z.namelist():
        if name.startswith("xl/worksheets/") and name.endswith(".xml"):
            sh = z.read(name).decode("utf8", "ignore")
            # 注意 `fitToWidth="1"` 是 XML 的**默认值**，写文件时会被省掉 ——
            # 所以不能断言这个属性存在，真正要看的是 `pageSetUpPr fitToPage="1"`
            #（它是 fit-to-page 模式的开关）和 `fitToHeight="0"`（纵向不限页数）。
            ps = re.search(r"<pageSetup\b[^>]*>", sh)
            fit = re.search(r'<pageSetUpPr fitToPage="1"/>', sh)
            if not fit:
                errors.append(f"{name}: 缺 pageSetUpPr fitToPage=1 —— 宽表会打印溢出")
            if not ps or 'fitToHeight="0"' not in ps.group(0):
                errors.append(f"{name}: pageSetup 缺 fitToHeight=0（纵向会被压成一页）")
            w = re.search(r'fitToWidth="(\d+)"', ps.group(0)) if ps else None
            if w and w.group(1) != "1":
                errors.append(f"{name}: fitToWidth={w.group(1)}，期望 1（缩放到一页宽）")
    if errors:
        print("\n✗ 不通过：")
        for e in errors:
            print("  -", e)
        return 1
    print("\n✓ 通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
