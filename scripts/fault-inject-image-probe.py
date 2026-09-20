#!/usr/bin/env python3
"""
给**真机探针自己**做故障注入：往 Rust 里塞已知的错，确认
`verify-xlsx-image.py` 真的会红。

不注入就不知道探针是「守住了」还是「碰巧是绿的」——
这个项目已经在「测试全绿但功能是坏的」上栽过好几次（尤其是产物是
zip / 字节流、单测读不到内容的那类）。

用法：python3 scripts/fault-inject-image-probe.py
      会自己起 / 停 print-server（占用 18888，跑之前先确保没别的实例）
退出码：0 = 每条注入都如期变红；1 = 有注入没抓到（那就是探针的漏网）。
"""
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"
BIN = Path.home() / ".cargo/target/debug/print-server"
XLSX = SERVER_DIR / "src/report/xlsx.rs"
HEALTH = "http://127.0.0.1:18888/health"

# (说明, 文件, 原片段, 换成, )
CASES = [
    (
        "不缩图（偏移按缩完的算、图按原尺寸插 → 盖到右边那列）",
        XLSX,
        "                            .set_alt_text(alt)\n"
        "                            .set_scale_to_size(f64::from(pl.w), f64::from(pl.h), true);",
        "                            .set_alt_text(alt);",
    ),
    (
        "不撑列宽（图缩成 61px 宽）",
        XLSX,
        "            if d.w <= span_pixels(widths, c, cell.colspan) {\n                continue;\n            }",
        "            if true {\n                continue;\n            }",
    ),
    (
        "不撑行高（图被高度兜底压扁）",
        XLSX,
        "        grow_rows_for_images(&mut row_pts, &sheet.rows, &sizes, &widths);",
        "        let _ = &sizes;",
    ),
    (
        "px→字符用四舍五入（列比图窄 3px）",
        XLSX,
        "    let c = (f64::from(px) - 5.5) / MAX_DIGIT_WIDTH;\n    c.ceil()",
        "    let c = f64::from(px.saturating_sub(CELL_PADDING)) / MAX_DIGIT_WIDTH;\n    c.round()",
    ),
    (
        "忽略图片 dpi（203dpi 的图大 2.1 倍）",
        XLSX,
        "    (img.width() * 96.0 / dw, img.height() * 96.0 / dh)",
        "    (img.width(), img.height())",
    ),
    (
        "列宽不夹上限（1000px 的图把列撑到 7000px，打印缩成一团）",
        XLSX,
        "    c.ceil().clamp(f64::from(MIN_COL_WIDTH), f64::from(MAX_COL_WIDTH)) as u16",
        "    c.ceil().max(f64::from(MIN_COL_WIDTH)) as u16",
    ),
]


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=kw.pop("cwd", ROOT), capture_output=True, text=True, **kw)


def build() -> bool:
    r = run(["cargo", "build"], cwd=SERVER_DIR)
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:])
    return r.returncode == 0


def start_server():
    p = subprocess.Popen([str(BIN)], cwd=SERVER_DIR,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    r = run(["python3", "scripts/verify-xlsx-image.py"])
    return r.returncode, (r.stdout + r.stderr).strip()


def main() -> int:
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
        for name, path, old, new in CASES:
            src = path.read_text(encoding="utf-8")
            if old not in src:
                print(f"✗ 锚点没找到，跳过（**没验过**）：{name}")
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
