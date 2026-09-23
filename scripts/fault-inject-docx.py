#!/usr/bin/env python3
"""给 Word 导出（docx）做故障注入：往 Rust 里塞**已知的错**，
确认两道闸真的会红。

## 为什么不注入就不知道闸有没有用

docx 的失败是**全有或全无**的：Word 遇到结构错不是「排版有点怪」，是直接报
「不可读内容」。而这类错在单测里天然看不见（单测只能断言「写了 N 字节 / 含某个
子串」）。所以「探针是绿的」这句话，只有在**证明过它会红**之后才有意义 ——
本项目在「测试全绿但功能是坏的」上栽过好几次（Univer 橙色边框过了 11 条单测）。

## 两道闸，分工不同，所以跑矩阵

- `cargo test --bin print-server -- report::docx`
  —— 能测**纯函数**：转义、控制字符、换行、单位换算、合并的角色。
- `scripts/verify-docx.py`
  —— 真机打 `/api/report/docx`，用 Python 的 `zipfile` + `ElementTree`
    （**另一个实现**）把产物读回来：part 闭合、r:id 闭合、子元素顺序、内容回读。
    这些在 Rust 侧**结构上看不见**（zip 是二进制、内容要按 OOXML 语义读）。

**「只有探针红」不是缺陷，是分工**；但「两道闸都是绿的」说明这条注入根本没被抓到
—— 那才是漏网，必须报出来。

用法：python3 scripts/fault-inject-docx.py
      （会自己起 / 停 print-server，占用 18888，跑之前先确保没别的实例）
退出码：0 = 每条注入都被至少一道闸抓到，且基线两闸都绿；1 = 有漏网。
"""
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"
DOCX = SERVER_DIR / "src/report/docx.rs"
BIN = Path.home() / ".cargo/target/debug/print-server"
PY = os.environ.get(
    "PY_BIN", "/Users/lushaohui/.workbuddy-ai/binaries/python/envs/default/bin/python"
)
# ⚠️ 沙箱里 HTTP_PROXY 指向本地代理，探 127.0.0.1 会被拦成 502 —— 必须绕过
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
HEALTH = "http://127.0.0.1:18888/health"

# (说明, 原片段, 换成)
CASES = [
    (
        "Content_Types 漏声明主文档（Word 直接报不可读内容）",
        '<Override PartName=\\"/word/document.xml\\" ContentType=\\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\\"/>',
        "",
    ),
    (
        "包级关系指向不存在的 part（悬空 r:id）",
        'Target=\\"word/document.xml\\"/>',
        'Target=\\"word/missing.xml\\"/>',
    ),
    (
        "tblPr 子元素顺序倒挂（jc 插到 tblW 之前）",
        "         <w:tblPr>\\\n         <w:tblW",
        "         <w:tblPr>\\\n         <w:jc w:val=\\\"center\\\"/>\\\n         <w:tblW",
    ),
    (
        "tcPr 子元素顺序倒挂（vAlign 插到 tcW 之前）",
        '    pr.push_str("<w:tcW w:w=\\"0\\" w:type=\\"auto\\"/>");',
        '    pr.push_str("<w:vAlign w:val=\\"center\\"/>");\n    pr.push_str("<w:tcW w:w=\\"0\\" w:type=\\"auto\\"/>");',
    ),
    (
        "纵向合并首格退化成续格（去掉 w:val=restart）",
        '        VMerge::Restart => pr.push_str("<w:vMerge w:val=\\"restart\\"/>"),',
        '        VMerge::Restart => pr.push_str("<w:vMerge/>"),',
    ),
    (
        "续格不输出 vMerge（Word 里整列错位）",
        '        VMerge::Continue => pr.push_str("<w:vMerge/>"),',
        "        VMerge::Continue => {}",
    ),
    (
        "横向合并不写 gridSpan",
        "    if o.colspan > 1 {\n        pr.push_str(&format!(\"<w:gridSpan w:val=\\\"{}\\\"/>\", o.colspan));\n    }",
        "    if false {\n        pr.push_str(&format!(\"<w:gridSpan w:val=\\\"{}\\\"/>\", o.colspan));\n    }",
    ),
    (
        "窄行不补齐（渲染出来的行本来就是锯齿状的）",
        "        for _ in span..grid_cols {",
        "        for _ in 0..0 {",
    ),
    (
        "文本不转义 &（裸 & 让 XML 解析失败）",
        "            '&' => out.push_str(\"&amp;\"),",
        "            '&' => out.push('&'),",
    ),
    (
        "保留 XML 1.0 不允许的控制字符",
        "        if !is_xml_char(c) {\n            continue; // 见 `is_xml_char` 的取舍说明\n        }",
        "        if false {\n            continue;\n        }",
    ),
    (
        "换行不转 w:br（w:t 里的 \\n 在 Word 里不换行）",
        '            body.push_str("<w:br/>");',
        "            body.push('\\n');",
    ),
    (
        "纸张单位错（把 mm 当 twips 写）",
        "    let w = (ps.width_mm * TWIPS_PER_MM).round() as u32;",
        "    let w = ps.width_mm.round() as u32;",
    ),
    (
        "页边距四边写反（top 用了 left 的值）",
        "        let t = (m.top * TWIPS_PER_MM).round() as u32;",
        "        let t = (m.left * TWIPS_PER_MM).round() as u32;",
    ),
    (
        "单元格文本写错（每格多一个字符）",
        "        para_of(&o.cell.text)",
        '        para_of(&format!("{}!", o.cell.text))',
    ),
]


def build() -> None:
    p = subprocess.run(["cargo", "build", "--bin", "print-server"], cwd=SERVER_DIR,
                       capture_output=True, text=True)
    if p.returncode != 0:
        print("✗ 编译失败：\n" + p.stdout[-2000:] + p.stderr[-2000:], file=sys.stderr)
        raise SystemExit(2)


def start_server() -> subprocess.Popen:
    srv = subprocess.Popen([str(BIN)], cwd=SERVER_DIR,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            with _OPENER.open(HEALTH, timeout=1):
                return srv
        except Exception:
            time.sleep(0.25)
    srv.kill()
    raise SystemExit("✗ print-server 起不来（18888 被占？）")


def stop_server(srv: subprocess.Popen | None) -> None:
    if srv is None:
        return
    srv.terminate()
    try:
        srv.wait(timeout=5)
    except subprocess.TimeoutExpired:
        srv.kill()


def gate_rust() -> tuple[bool, str]:
    p = subprocess.run(["cargo", "test", "--bin", "print-server", "--", "report::docx"],
                       cwd=SERVER_DIR, capture_output=True, text=True)
    ok = p.returncode == 0
    return ok, ("" if ok else (p.stdout + p.stderr)[-400:])


def gate_probe() -> tuple[bool, str]:
    p = subprocess.run([PY, "scripts/verify-docx.py"], cwd=ROOT, capture_output=True, text=True)
    ok = p.returncode == 0
    return ok, ("" if ok else (p.stdout + p.stderr)[-600:])


def run_all_gates(srv) -> tuple[bool, list[str], list[str]]:
    caught, detail = [], []
    ok, msg = gate_rust()
    if not ok:
        caught.append("rust")
        detail.append(msg.strip().splitlines()[-1] if msg.strip() else "")
    ok, msg = gate_probe()
    if not ok:
        caught.append("probe")
        detail.append(msg.strip().splitlines()[-1] if msg.strip() else "")
    return (not caught), caught, detail


def kill_port() -> None:
    """先把 18888 上可能还活着的实例清掉 —— 否则探针打的是**旧进程**，
    注入看起来就永远不生效（这是最容易骗过自己的一种假绿）。"""
    subprocess.run(["sh", "-c", "lsof -ti:18888 | xargs kill -9 2>/dev/null"], check=False)
    time.sleep(0.5)


def main() -> int:
    kill_port()
    build()
    srv = start_server()
    missed: list[str] = []
    rows: list[str] = []
    src = DOCX.read_text(encoding="utf-8")  # 供 finally 兜底还原

    try:
        ok, caught, detail = run_all_gates(srv)
        if not ok:
            print(f"✗ 基线不绿（{'/'.join(caught)}），先修好再注入：", file=sys.stderr)
            for d in detail:
                print("   ", d, file=sys.stderr)
            return 2
        print("基线：两道闸都绿\n")

        for i, (name, old, new) in enumerate(CASES, 1):
            src = DOCX.read_text(encoding="utf-8")
            if src.count(old) != 1:
                # **锚点必须恰好命中 1 处** —— 命中 0 处说明代码变了、注入根本没生效，
                # 那会伪装成「闸没抓到」，是最容易骗过自己的一种假象。
                print(f"✗ #{i} 锚点命中 {src.count(old)} 处（应为 1）：{name}")
                missed.append(name)
                continue
            DOCX.write_text(src.replace(old, new), encoding="utf-8")
            try:
                stop_server(srv)
                build()
                srv = start_server()
                ok, caught, detail = run_all_gates(srv)
                if caught:
                    rows.append(f"✓ #{i:<2} {'+'.join(caught):<12} {name}")
                    for d in detail:
                        if d:
                            rows.append(f"        {d[:140]}")
                else:
                    print(f"✗ #{i} **两道闸都是绿的**（这条注入没被抓到）：{name}")
                    missed.append(name)
            finally:
                DOCX.write_text(src, encoding="utf-8")

        stop_server(srv)
        build()
        srv = start_server()
        ok, caught, detail = run_all_gates(srv)
    finally:
        stop_server(srv)
        # 兜底：无论怎么退出，都保证文件还原
        if DOCX.read_text(encoding="utf-8") != src:
            DOCX.write_text(src, encoding="utf-8")

    print("\n".join(rows))
    print()
    if not ok:
        print("✗ 还原后基线不绿 —— 注入没清干净：", file=sys.stderr)
        for d in detail:
            print("   ", d, file=sys.stderr)
        return 1
    print("还原后基线 ✓")

    if missed:
        print(f"\n有 {len(missed)} 条没抓到，闸门有漏网：")
        for m in missed:
            print("  -", m)
        return 1
    print(f"\n全部 {len(CASES)} 条注入都被至少一道闸抓到。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
