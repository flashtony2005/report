#!/usr/bin/env python3
# 抽出 docx 的**元素顺序表**（ECMA-376 的 CT_* 内容模型），给 `verify-docx.py` 当判据。
#
# ## 为什么要有这个东西
#
# Word 对 **子元素顺序敏感**：`<w:pPr>` 放在 `<w:r>` 后面、`<w:sz>` 放在 `<w:color>`
# 前面，Word 直接报「不可读内容」—— 不是「格式有点怪」，是**整个文件打不开**。
# 而这类错在 Rust 单测里**完全不可见**（单测只能断言「写了 N 字节 / 没 panic」）。
#
# ## 为什么从 python-docx 抽，而不是我手写
#
# 手写 = 凭记忆。而这个项目里凭记忆写下的断言已经被证伪过（png.rs / barcode.rs
# 的 MSRV 理由）。python-docx 的 `_tag_seq` 是**它的作者按 ECMA-376 整理**的，
# 是一条**独立于我**的来源 —— 用它可以把我「记错了顺序」这个风险挪走。
#
# ⚠️ 它也不是权威：只是**另一批人**读同一份规范的结果。所以下面手工补的 5 条
# 会明确标出来，别把整张表当成「规范原文」。
#
# ## 用法
#
#   python3 scripts/docx-order-table.py            # 打印 JSON
#   python3 scripts/docx-order-table.py -o f.json  # 写文件
#
# 退出码：0 = 抽出成功；2 = python-docx 不在（**不允许静默跳过** —— 判据缺了
# 就等于这条检查是摆设，必须让人看见）。
import argparse
import glob
import json
import os
import re
import sys

VENV = "/Users/lushaohui/.workbuddy-ai/binaries/python/envs/default"

# python-docx 里**没有** `_tag_seq` 的五个（它用别的机制表达），手工补。
# 这五条结构简单、歧义小，但**来源是我**，所以要标出来。
HAND_WRITTEN = {
    # CT_P: 可选 pPr 打头，之后是 EG_PContent（run / 书签 / 超链接 …）
    "CT_P": ["w:pPr"],
    # CT_R: 可选 rPr 打头，之后是 EG_RunInnerContent（t / br / tab / drawing …）
    "CT_R": ["w:rPr"],
    # CT_Tbl: tblPr → tblGrid → 若干 tr。tblGrid 是**必填**且必须在 tr 之前
    "CT_Tbl": ["w:tblPr", "w:tblGrid", "w:tr"],
    # CT_Tr: 可选 trPr 打头，之后是 EG_ContentCellContent（tc …）
    "CT_Tr": ["w:trPr", "w:tc"],
    # CT_Tc: tcPr 打头，之后是块级内容（p / tbl）。**tc 不能直接装文本**
    "CT_Tc": ["w:tcPr", "w:p"],
}
HAND_WRITTEN_NOTE = (
    "这 5 条是手工写的（python-docx 没给 _tag_seq），来源是本仓不是规范原文；"
    "其余条来自 python-docx 的 _tag_seq，是独立来源。"
)


def find_docx_package() -> str:
    """定位 python-docx 安装位置。找不到就 exit 2 —— 别静默退化成空表。"""
    site = os.path.join(VENV, "lib")
    if not os.path.isdir(site):
        raise SystemExit(f"✗ 找不到隔离 venv：{VENV}\n  先：{VENV}/bin/pip install --only-binary=:all: python-docx")
    for cand in glob.glob(os.path.join(site, "python3*/site-packages/docx")):
        if os.path.isdir(cand):
            return cand
    raise SystemExit(
        "✗ python-docx 不在隔离 venv 里。\n"
        f"  装它：{VENV}/bin/pip install --only-binary=:all: python-docx\n"
        "  （--only-binary 是为了**不触发本地编译**：装不上就明说，别悄悄编一堆 C）"
    )


def extract(pkg: str) -> dict:
    """从 python-docx 源码里抠出每个 CT_* 类的 `_tag_seq`。"""
    out = {}
    for path in sorted(glob.glob(os.path.join(pkg, "oxml", "**", "*.py"), recursive=True)):
        lines = open(path, encoding="utf-8").read().split("\n")
        cur = None
        for i, line in enumerate(lines):
            m = re.match(r"^class (CT_\w+)\(", line)
            if m:
                cur = m.group(1)
            if "_tag_seq" in line and cur:
                buf, j = line, i
                while ")" not in buf and j + 1 < len(lines):
                    j += 1
                    buf += "\n" + lines[j]
                seq = re.findall(r'"([\w:]+)"', buf)
                # 同一个类里可能出现多个短序列（那是 ZeroOrOne 的定义），
                # 只留**最长的**那条 —— 它才是完整的顺序表。
                if seq and len(seq) > len(out.get(cur, [])):
                    out[cur] = seq
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", help="写到文件（默认打印到 stdout）")
    args = ap.parse_args()

    pkg = find_docx_package()
    table = extract(pkg)
    if not table:
        raise SystemExit("✗ 一条 _tag_seq 都没抠出来 —— python-docx 版本可能变了，检查脚本")

    table.update(HAND_WRITTEN)
    payload = {
        "来源": {
            "python-docx": pkg,
            "手工补的": sorted(HAND_WRITTEN),
            "说明": HAND_WRITTEN_NOTE,
        },
        "顺序表": table,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(text + "\n")
        print(f"写入 {args.out}：{len(table)} 条内容模型")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
