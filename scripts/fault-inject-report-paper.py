#!/usr/bin/env python3
"""给「报表页面设置」这套东西做故障注入：往 Rust 里塞已知的错，
确认**单测与真机探针**真的会红。

不注入就不知道这两道闸是「守住了」还是「碰巧是绿的」——
本项目已经在「测试全绿但功能是坏的」上栽过好几次，而页面设置恰好是最容易
「看着对、印出来不对」的那类（单位差 25.4 倍、参数顺序、页脚码转义顺序）。

**四道闸，强弱不同，所以跑矩阵**：
- `cargo test --offline`：能测纯函数（尺寸换算、转义顺序、页码下标、options 合并）。
- `scripts/verify-report-paper.py`：拆 zip 读 `sheetN.xml`。xlsx 的内容是 deflate 的，
  单测**读不到**，所以「xlsx 侧真正落地了没有」只有它能测。
- `scripts/ts-test.sh`（openprint 纯函数层）：设计器的页面设置预检 `pageSetupProblem`
  在这一层 —— 它和服务端是**两份实现**，最容易悄悄漂开。
- designer-react 的 `grid-report-request.spec.ts`：**接线**层。
  「页面设置有没有进 `rawTemplate`」只有它能测（Rust 侧完全看不见这条路）。

**「只探针红」不是缺陷、是这些闸的分工**；但「只单测红」就说明探针有漏网，
而「全是绿的」说明这条注入根本没被抓到 —— 两种都要报出来。

用法：python3 scripts/fault-inject-report-paper.py
      （会自己起 / 停 print-server，占用 18888，跑之前先确保没别的实例）
退出码：0 = 每条注入都被至少一道闸抓到，且基线四道闸都绿；1 = 有漏网。
"""
import re
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"
BIN = Path.home() / ".cargo/target/debug/print-server"
MODEL = SERVER_DIR / "src/report/model.rs"
STORE = SERVER_DIR / "src/report/store.rs"
MOD = SERVER_DIR / "src/report/mod.rs"
XLSX = SERVER_DIR / "src/report/xlsx.rs"
# TS 镜像侧（页面设置的预检与存盘接线都在这一层）
GR_TS = ROOT / "openprint/src/report/grid-report.ts"
REQ_TS = ROOT / "designer-react/src/modals/grid-report-request.ts"
NODE = os.environ.get(
    "NODE_BIN", "/Users/lushaohui/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin/node"
)
# vitest 走 vite 工具链，不挂这两个 preload 会被 broker 拦（见 skill sandbox-broker-workarounds）
PRELOAD = (
    f"--require {ROOT / 'scripts/vite-safe-delete-bypass.cjs'} "
    f"--require {ROOT / 'scripts/broker-mkdir-throttle.cjs'}"
)
# ⚠️ 沙箱里 HTTP_PROXY 指向本地代理，探 127.0.0.1 会被拦成 502 —— 必须绕过
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
HEALTH = "http://127.0.0.1:18888/api/report/sample-template"

# (说明, 文件, 原片段, 换成)
CASES = [
    (
        "没写页边距时填 DEFAULT_MARGINS（替作者做了决定）",
        MODEL,
        "        let margin_mm = self.margin_mm;",
        "        let margin_mm = Some(self.margin_mm.unwrap_or(DEFAULT_MARGINS));",
    ),
    (
        "页脚码先替换后转义（&P 被翻成 &&P，页码变乱码）",
        MODEL,
        '            tpl.replace(\'&\', "&&")\n'
        '                .replace("{page}", "&P")\n'
        '                .replace("{pages}", "&N")',
        '            tpl.replace("{page}", "&P")\n'
        '                .replace("{pages}", "&N")\n'
        '                .replace(\'&\', "&&")',
    ),
    (
        "B5 改回 ISO 176×250（但 Excel 码仍是 13 → 两边不同纸）",
        MODEL,
        # 必须带上表头行才唯一 —— 单测 `paper_table_is_pinned` 里有一份同样的列表
        'pub const PAPERS: &[(&str, f64, f64, u8)] = &[\n'
        '    ("A3", 297.0, 420.0, 8),\n'
        '    ("A4", 210.0, 297.0, 9),\n'
        '    ("A5", 148.0, 210.0, 11),\n'
        '    ("B5", 182.0, 257.0, 13),',
        'pub const PAPERS: &[(&str, f64, f64, u8)] = &[\n'
        '    ("A3", 297.0, 420.0, 8),\n'
        '    ("A4", 210.0, 297.0, 9),\n'
        '    ("A5", 148.0, 210.0, 11),\n'
        '    ("B5", 176.0, 250.0, 13),',
    ),
    (
        "with_pagination_of 改回整份替换（页面设置被 options 抹掉）",
        MODEL,
        "            rows_per_page: other.rows_per_page,\n"
        "            repeat_header_rows: other.repeat_header_rows,\n"
        "            repeat_footer_rows: other.repeat_footer_rows,\n"
        "            ..self.clone()",
        "            ..other.clone()",
    ),
    (
        "apply_options 不用 with_pagination_of（调用点漏了）",
        STORE,
        "            let old = s.page.take().unwrap_or_default();\n"
        "            s.page = Some(old.with_pagination_of(p));",
        "            s.page = Some(p.clone());",
    ),
    (
        "页码恒为 1（每页都印「第 1 页」）",
        MOD,
        "                        i + 1,\n"
        "                        n,",
        "                        1,\n"
        "                        n,",
    ),
    (
        "页码用扁平下标（第二张表的首页印成第 4 页）",
        MOD,
        "                for (i, grid) in grids.into_iter().enumerate() {",
        "                let _base = all_pages.len();\n"
        "                for (i, grid) in grids.into_iter().enumerate() {\n"
        "                    let i = _base + i;",
    ),
    (
        "effective 恒 true（没真分页也印页码，印的是错的）",
        MOD,
        "                let effective = cfg.is_effective(rows.len());",
        "                let effective = true;",
    ),
    (
        "@page 的 size 无条件吐（没写纸张也替作者选 A4）",
        MOD,
        "        if setup.paper.is_some() {",
        "        if true {",
    ),
    (
        "set_margins 参数顺序错（left/right/top/bottom 写反）",
        XLSX,
        "                ws.set_margins(\n"
        "                    m.left / MM_PER_INCH,\n"
        "                    m.right / MM_PER_INCH,\n"
        "                    m.top / MM_PER_INCH,\n"
        "                    m.bottom / MM_PER_INCH,",
        "                ws.set_margins(\n"
        "                    m.top / MM_PER_INCH,\n"
        "                    m.right / MM_PER_INCH,\n"
        "                    m.left / MM_PER_INCH,\n"
        "                    m.bottom / MM_PER_INCH,",
    ),
    (
        "页边距不换英寸（差 25.4 倍）",
        XLSX,
        "                ws.set_margins(\n"
        "                    m.left / MM_PER_INCH,\n"
        "                    m.right / MM_PER_INCH,\n"
        "                    m.top / MM_PER_INCH,\n"
        "                    m.bottom / MM_PER_INCH,\n"
        "                    0.3,\n"
        "                    0.3,\n"
        "                );",
        "                ws.set_margins(m.left, m.right, m.top, m.bottom, 0.3, 0.3);",
    ),
    (
        "页脚漏掉 &C（不居中段，Excel 会当成左段）",
        XLSX,
        '                ws.set_footer(format!("&C{footer}"));',
        '                ws.set_footer(format!("{footer}"));',
    ),
    (
        "xlsx 表头行数不判分页（只配纸张时表头从 2 行掉到 1 行）",
        MOD,
        "        .and_then(|s| s.page.as_ref())\n"
        "        .filter(|p| p.rows_per_page > 0)\n"
        "        .map_or_else(|| tpl.header_row_count().max(1), |p| p.repeat_header_rows.max(1))",
        "        .and_then(|s| s.page.as_ref())\n"
        "        .map_or_else(|| tpl.header_row_count().max(1), |p| p.repeat_header_rows.max(1))",
    ),
    (
        "纸张名改回大小写敏感（`a4` 服务端认、设计器却拦 —— 预检误报）",
        MODEL,
        "        .find(|(n, _, _, _)| n.eq_ignore_ascii_case(name.trim()))\n"
        "        .map(|(_, w, h, _)| (*w, *h))",
        "        .find(|(n, _, _, _)| *n == name.trim())\n"
        "        .map(|(_, w, h, _)| (*w, *h))",
    ),
    (
        "设计器预检的纸张比对改回大小写敏感（与服务端口径漂开）",
        GR_TS,
        "  if (paper && !(PAPER_NAMES as readonly string[]).some((n) => n.toLowerCase() === paper.toLowerCase())) {",
        "  if (paper && !(PAPER_NAMES as readonly string[]).includes(paper)) {",
    ),
    (
        "页面设置不进 rawTemplate（存了 A3，重开显示「不指定」，再存真抹掉）",
        REQ_TS,
        "  template = withPageSetup(template, page)\n",
        "",
    ),
]


def run(cmd, cwd=ROOT):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def build() -> bool:
    r = run(["cargo", "build", "--offline"], cwd=SERVER_DIR)
    if r.returncode != 0:
        print(r.stdout[-1500:], r.stderr[-1500:])
    return r.returncode == 0


def start_server():
    p = subprocess.Popen(
        [str(BIN)], cwd=SERVER_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    for _ in range(80):
        time.sleep(0.25)
        try:
            _OPENER.open(HEALTH, timeout=1)
            return p
        except urllib.error.HTTPError:
            return p  # 4xx 也算活着（说明端口上有服务）
        except (urllib.error.URLError, OSError):
            if p.poll() is not None:
                raise SystemExit("✗ print-server 起不来（端口被占？）")
    p.terminate()
    raise SystemExit("✗ print-server 起来了但一直连不上")


def stop_server(p) -> None:
    p.terminate()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()


def gate_tests() -> tuple[bool, str]:
    r = run(["cargo", "test", "--offline"], cwd=SERVER_DIR)
    ok = r.returncode == 0
    out = r.stdout + r.stderr
    failed = re.findall(r"^    report::\S+", out, re.M)
    return ok, ("失败: " + ", ".join(failed[:3])) if failed else ""


def gate_probe() -> tuple[bool, str]:
    r = run(["python3", "scripts/verify-report-paper.py"])
    ok = r.returncode == 0
    out = r.stdout + r.stderr
    first = next((l.strip() for l in out.splitlines() if l.startswith("  -")), "")
    return ok, first


def gate_ts_engine() -> tuple[bool, str]:
    """openprint 纯函数层（`grid-report.spec.ts`）—— `pageSetupProblem` 那类预检在这层。"""
    r = run(["bash", "scripts/ts-test.sh"])
    out = r.stdout + r.stderr
    first = next((l.strip() for l in out.splitlines() if l.startswith("FAIL")), "")
    return r.returncode == 0, first


def gate_ts_designer() -> tuple[bool, str]:
    """设计器侧的接线（`grid-report-request.spec.ts`）—— 页面设置有没有进 rawTemplate 在这层。

    ⚠️ 必须 `cwd=designer-react` 且挂 preload；不挂 preload 会被 broker 拦成
    「一堆 CODEBUDDY_BROKER_DENY」，看着像测试挂了。
    """
    r = subprocess.run(
        [NODE, "node_modules/.bin/vitest", "run", "src/modals/grid-report-request.spec.ts"],
        cwd=ROOT / "designer-react",
        env=dict(os.environ, NODE_OPTIONS=PRELOAD),
        capture_output=True,
        text=True,
    )
    out = r.stdout + r.stderr
    first = next((l.strip() for l in out.splitlines() if l.startswith("FAIL")), "")
    return r.returncode == 0, first


# 四道闸，强弱与覆盖范围都不同 —— 矩阵的意义就是看「哪道闸抓到的」
GATES: list[tuple[str, object]] = [
    ("单测", gate_tests),
    ("探针", gate_probe),
    ("TS引擎", gate_ts_engine),
    ("TS设计器", gate_ts_designer),
]


def run_all_gates() -> tuple[bool, list[str], list[str]]:
    """跑四道闸 → (是否全绿, 抓到它的闸名, 摘要行)"""
    caught: list[str] = []
    detail: list[str] = []
    for name, fn in GATES:
        ok, msg = fn()  # type: ignore[operator]
        if not ok:
            caught.append(name)
            if msg:
                detail.append(f"[{name}] {msg}")
    return not caught, caught, detail


def patch(path: Path, old: str, new: str) -> tuple[bool, str]:
    """锚点必须**恰好匹配 1 处**：0 处 = 没打准，>1 处 = 改错地方（静默改到别处）。"""
    src = path.read_text(encoding="utf-8")
    n = src.count(old)
    if n != 1:
        return False, f"锚点匹配 {n} 处（要求恰好 1 处）"
    path.write_text(src.replace(old, new), encoding="utf-8")
    return True, ""


def main() -> int:
    if not build():
        return 1
    srv = start_server()
    backups: dict[Path, str] = {}
    missed: list[str] = []
    rows: list[str] = []
    try:
        ok_all, _, detail = run_all_gates()
        if not ok_all:
            print("✗ 基线就不绿，先修好再来注入：")
            for d in detail:
                print("   ", d)
            return 1
        print("基线 ✓（未注入时四道闸都绿）\n")

        for i, (name, path, old, new) in enumerate(CASES, 1):
            if path not in backups:
                backups[path] = path.read_text(encoding="utf-8")
            ok, why = patch(path, old, new)
            if not ok:
                print(f"✗ #{i} 锚点没打准，跳过（**没验过**）：{name} —— {why}")
                missed.append(name)
                continue

            # TS 注入不影响服务端二进制，别白重启一次
            touched_rust = path.suffix == ".rs"
            if touched_rust:
                stop_server(srv)
                if not build():
                    # **编译不过不算「被抓住」**：那说明锚点把代码改坏了，
                    # 而不是断言发现了行为差异。
                    print(f"✗ #{i} 编译不过（不算验过）：{name}")
                    missed.append(name)
                    path.write_text(backups[path], encoding="utf-8")
                    build()
                    srv = start_server()
                    continue
                srv = start_server()

            ok_all, caught_by, detail = run_all_gates()
            if caught_by:
                rows.append(f"✓ #{i:<2} {'+'.join(caught_by):<20} {name}")
                for d in detail:
                    rows.append(f"        {d[:150]}")
            else:
                print(f"✗ #{i} **四道闸都是绿的**（这条注入没被抓到）：{name}")
                missed.append(name)

            path.write_text(backups[path], encoding="utf-8")
            if touched_rust:
                stop_server(srv)
                build()
                srv = start_server()
    finally:
        for path, src in backups.items():
            path.write_text(src, encoding="utf-8")
        stop_server(srv)

    print("\n".join(rows))
    print()
    # 复核：注入全部还原后，四道闸必须重新变绿（否则「还原」本身没生效）
    build()
    srv = start_server()
    try:
        ok_all, _, detail = run_all_gates()
    finally:
        stop_server(srv)
    if not ok_all:
        print("✗ 还原后基线不绿 —— 注入没清干净：")
        for d in detail:
            print("   ", d)
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
