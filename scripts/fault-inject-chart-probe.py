#!/usr/bin/env python3
"""
给**图表真机探针自己**做故障注入：往 Rust 里塞已知的错，确认
`verify-xlsx-chart.py` 真的会红。

为什么不注入就不知道探针有没有用：探针是「读 zip 里的 XML 下断言」的代码，
它自己算错了（列号推错、区块找错、正则写松）照样一片绿。
**「探针全绿」只有在「注入已知错误后它真的会红」的前提下才有意义** ——
这个项目已经在「测试全绿但产物是坏的」上栽过好几次。

覆盖面刻意按**错误类型**分组，而不是随便凑数：
- 常量（列偏移差一列）
- 接线（数值列取错列、声明没传到实例、锚点错位）
- 语义（空值补 0 —— 两处：xlsx 与 SVG）
- 漏判（图表格被当占位空格丢掉）
- 类型映射（柱状画成饼图）
- 重复（图表格跟着展开行复制成 N 份）
- 副作用（数据块没隐藏）

用法：python3 scripts/fault-inject-chart-probe.py
      会自己起 / 停 print-server（占用 18888，跑之前先确保没别的实例）
退出码：0 = 每条注入都如期变红；1 = 有注入没抓到（那就是探针的漏网）。
"""
import argparse
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from server_bin import resolve_server_bin  # noqa: E402
BIN = Path(resolve_server_bin())
XLSX = SERVER_DIR / "src/report/xlsx.rs"
ENGINE = SERVER_DIR / "src/report/engine.rs"
SVG = SERVER_DIR / "src/report/chart_svg.rs"
HEALTH = "http://127.0.0.1:18888/health"

# (说明, 文件, 原片段, 换成)
CASES = [
    (
        "数据块列偏移差一列（引用指到隔壁列）",
        XLSX,
        "    let helper_col: u16 = col_count + 1;",
        "    let helper_col: u16 = col_count;",
    ),
    (
        "数值序列取错列（引用与缓存对不上）",
        XLSX,
        "            let col = helper_col + 1 + s as u16;",
        "            let col = helper_col + s as u16;",
    ),
    (
        "空值补 0（xlsx 侧撒谎说「这里是 0」）",
        XLSX,
        "                if let Some(x) = v {\n"
        "                    ws.write_number(cursor + 1 + i as u32, cc, *x).map_err(|e| e.to_string())?;\n"
        "                }",
        "                ws.write_number(cursor + 1 + i as u32, cc, v.unwrap_or(0.0))\n"
        "                    .map_err(|e| e.to_string())?;",
    ),
    (
        "空值补 0（SVG 侧多画一根柱子）",
        SVG,
        "            let Some(Some(val)) = series.data.get(c) else { continue };",
        "            let val = series.data.get(c).copied().flatten().unwrap_or(0.0);",
    ),
    (
        "图表格被当成占位空格丢掉（整格消失）",
        ENGINE,
        # 锚点**覆盖整个函数体**（含收尾的 `}`）：只截第一行的话，以后往中间
        # 插入一个 `&& cell.xxx.is_none()`（条码格那次就是这么加的）会让锚点
        # 变成一个**更短的前缀**，照样匹配 1 处 → 只注入一半、还不报警。
        # 带上首尾行，任何中途插入都会让它匹配 0 处 —— 宁可吵，不要静默。
        "fn is_placeholder(cell: &CellTpl) -> bool {\n"
        "    cell.value.is_none()\n"
        "        && cell.model.is_none()\n"
        "        && cell.image.is_none()\n"
        "        && cell.chart.is_none()\n"
        "        && cell.barcode.is_none()\n"
        "}",
        "fn is_placeholder(cell: &CellTpl) -> bool {\n"
        "    cell.value.is_none()\n"
        "        && cell.model.is_none()\n"
        "        && cell.image.is_none()\n"
        "}",
    ),
    (
        "图表声明没从模板拷到实例（图静默不出）",
        ENGINE,
        # 锚点横跨 chart → barcode → value 三行：条码那次就是在 chart 和 value
        # **中间**插了一行，两行锚点当场匹配 0 处。带上中间的 barcode 行之后，
        # 以后再加一种声明（`inst.xxx = ...`）插在中间同样会匹配 0 处 —— 吵，不静默。
        "            inst.chart = cell.chart.clone().or_else(|| model.chart.clone());\n"
        "            inst.barcode = cell.barcode.clone().or_else(|| model.barcode.clone());\n"
        "            inst.value = match &model.field {",
        "            inst.barcode = cell.barcode.clone().or_else(|| model.barcode.clone());\n"
        "            inst.value = match &model.field {",
    ),
    (
        "柱状图映射成饼图（类型判断接错）",
        XLSX,
        "            // 认不出来的类型在解析期就报错了，这里兜底成柱状\n"
        "            _ => ChartType::Column,",
        "            _ => ChartType::Pie,",
    ),
    (
        "图表锚点错位（浮到 A1 上，不在图表格那格）",
        XLSX,
        "        ws.insert_chart_with_offset(r as u32, c as u16, &chart, 4, 4)\n"
        "            .map_err(|e| e.to_string())?;",
        "        ws.insert_chart_with_offset(0, 0, &chart, 4, 4).map_err(|e| e.to_string())?;",
    ),
    (
        "图表格跟着展开行复制（Excel 里 N 张图叠在同一格）",
        ENGINE,
        "        let mut seen: BTreeSet<String> = BTreeSet::new();\n"
        "        decls.retain(|(_, _, pos, _, _)| seen.insert(pos.clone()));",
        # 两行**一起**删掉才是「不去重」。只删 `let mut seen` 会留下一个用到
        # 不存在变量的 `retain` ⇒ 编译不过 ⇒ 被 runner 判「不算验过」（这是对的），
        # 白跑一轮。新文本为空串 = 整段消失。
        "",
    ),
    (
        "数据块不隐藏（混进报表正文）",
        XLSX,
        "    for k in 0..=widest {\n"
        "        ws.set_column_hidden(helper_col + k).map_err(|e| e.to_string())?;\n"
        "    }",
        "    let _ = widest;",
    ),
]


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=kw.pop("cwd", ROOT), capture_output=True, text=True, **kw)


def build() -> bool:
    # 先试离线：依赖都已在本地缓存时，省掉一次索引往返（本机网络很慢）。
    # 离线失败（缓存被清）再退回联网，别让驱动因为网络问题假装「注入没抓到」。
    r = run(["cargo", "build", "--offline"], cwd=SERVER_DIR)
    if r.returncode != 0:
        r = run(["cargo", "build"], cwd=SERVER_DIR)
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:])
    return r.returncode == 0


def start_server():
    p = subprocess.Popen(
        [str(BIN)], cwd=SERVER_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    for _ in range(60):
        time.sleep(0.25)
        try:
            urllib.request.urlopen(HEALTH, timeout=1)
            return p
        except (urllib.error.URLError, OSError):
            if p.poll() is not None:
                raise SystemExit("✗ print-server 起不来（端口被占？）")
    p.terminate()
    raise SystemExit("✗ print-server 起来了但 /health 一直不通")


def stop_server(p) -> None:
    p.terminate()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()


def probe() -> tuple[int, str]:
    r = run(["python3", "scripts/verify-xlsx-chart.py"])
    return r.returncode, (r.stdout + r.stderr).strip()


def anchor_report(cases) -> int:
    """只校验每条锚点在源文件里**恰好匹配 1 处**，不编译、不注入，秒级。

    为什么要单独这一档：锚点失效以前要等一轮 cargo build（几十秒）才报，
    而它报的形态是「跳过（**没验过**）」—— 一眼看容易被当成「这条过了」。
    在这里先跑一遍，腐坏的锚点在 CI 上前几十秒就红，不用等真注入。
    """
    bad = 0
    for name, path, old, _new in cases:
        n = path.read_text(encoding="utf-8").count(old)
        if n == 1:
            print(f"  ok   {name}  锚点唯一")
        else:
            bad += 1
            print(f"  BAD  {name}  锚点匹配 {n} 处（应恰好 1 处）")
    if bad:
        print(f"\n{bad} 条锚点失效 —— 它们现在**没被验过**，先修锚点再跑注入")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只列出注入，不执行")
    ap.add_argument(
        "--check-anchors",
        action="store_true",
        help="只校验每条锚点恰好匹配 1 处（不编译、不注入，秒级）",
    )
    ap.add_argument("--only", help="只跑名字含该子串的注入")
    args = ap.parse_args()

    if args.list:
        for name, _p, old, _n in CASES:
            print(f"  {name}")
        return 0

    picked = [c for c in CASES if not args.only or args.only in c[0]]
    if args.check_anchors:
        return anchor_report(picked)

    if not build():
        return 1
    srv = start_server()
    try:
        rc, out = probe()
        if rc != 0:
            print("✗ 基线就跑不过，先修好再来注入：")
            print(out)
            return 1
        print("基线 ✓（未注入时探针通过）\n")

        missed = []
        for name, path, old, new in picked:
            src = path.read_text(encoding="utf-8")
            n = src.count(old)
            # 0 处 = 锚点腐坏；>1 处 = replace(..., 1) 只会改第一处，
            # 另一处留着 ⇒ **只注入一半**，而探针可能照样红（看着像抓到了）。
            # 两种都算「没验过」，宁可当场红。
            if n != 1:
                print(f"✗ 锚点匹配 {n} 处（**没验过**）：{name}")
                missed.append(name)
                continue
            path.write_text(src.replace(old, new, 1), encoding="utf-8")
            stop_server(srv)
            try:
                if not build():
                    print(f"✗ 编译不过（锚点没打准，不算验过）：{name}")
                    missed.append(name)
                    continue
                srv = start_server()
                rc, out = probe()
                if rc == 0:
                    print(f"✗ **探针仍然是绿的**（这条注入没被抓到）：{name}")
                    missed.append(name)
                else:
                    first = next((l for l in out.splitlines() if l.startswith("  -")), "")
                    print(f"✓ 如期变红  {name}")
                    if first:
                        print(f"     {first.strip()}")
            finally:
                path.write_text(src, encoding="utf-8")
                stop_server(srv)
                srv = start_server()
    finally:
        stop_server(srv)

    print()
    if missed:
        print(f"有 {len(missed)} 条没抓到，探针有漏网：")
        for m in missed:
            print("  -", m)
        return 1
    print(f"全部 {len(CASES)} 条注入都被探针抓到。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
