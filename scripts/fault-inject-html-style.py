#!/usr/bin/env python3
"""HTML 样式渲染的故障注入：逐条改坏产品代码，确认**两道门禁真的会红**。

## 两道门禁，覆盖的不是同一批 bug

| 门禁 | 跑什么 | 能看见 | 看不见 |
| --- | --- | --- | --- |
| A 单测 | `cargo test`（直接喂 `RenderedSheet` 给 `to_html`） | 映射 / 校验 / 顺序 / 字段覆盖 | HTTP 状态码、分页那条路、`/api/report/render` 到底有没有把 `html` 带回来 |
| B 探针 | `scripts/verify-html-style.py`（真起服务、POST `/api/report/render`） | 上面全部 + 端到端接线 | 某些只在单测里枚举的分支（如 `v_align: middle`） |

所以判据是「**至少一道**抓住」，并且逐条打印**哪道抓住了** —— 那张矩阵本身
就是结论：某条注入两道全绿，说明那段代码**没有任何门禁在守**。

特意留了两条**只有探针能抓**的注入（`status-500` / `pages-drop-style`），
它们就是「探针不是摆设」的证据：单测看不见它们。

## 为什么要单独一个驱动

`to_html` 这次从「不读样式」变成「读样式」，新增的断言全是**字符串匹配**。
字符串断言最容易写成「永远为真」——比如拿整份 HTML 去 `contains(" style=\\"")`，
而 `<table>` 自带 `style="border-collapse:collapse"`，于是断言恒真。
（写这组用例时真踩了一次，两条用例先红后修。）所以必须逐条注入证明它抓得住。

## ⚠️ 编译失败不算「被抓住」

把注入写成语法错误 / 类型错误，`cargo test` 同样非 0 退出，看起来像「用例红了」——
其实**根本没跑到用例**。本驱动显式识别 `error[E...]` / `could not compile`，
把它算作 **没抓住**（注入本身不合格），而不是通过。

## 用法

    python3 scripts/fault-inject-html-style.py            # 跑全部，两道门禁
    python3 scripts/fault-inject-html-style.py --only bold
    python3 scripts/fault-inject-html-style.py --list
    python3 scripts/fault-inject-html-style.py --no-probe   # 只跑单测（快）

退出码：0 = 每条注入都至少被一道门禁抓住；1 = 有注入两道全绿。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "print-server"
MOD = "print-server/src/report/mod.rs"
BIN = Path.home() / ".cargo/target/debug/print-server"

PROBE_PORT = 18907

OK = "\033[32m✓\033[0m"
BAD = "\033[31m✗\033[0m"
DIM = "\033[2m"
OFF = "\033[0m"

# (名字, 类别, 说明, 原文, 替换)  —— 全部注入在 mod.rs
INJECTIONS = [
    (
        "style-drop",
        "样式丢弃",
        "整段样式不渲染（退回改动前的行为）→ 预览里再也看不到任何样式",
        '    if st.is_empty() {\n        return Ok(String::new());\n    }',
        '    if true {\n        return Ok(String::new());\n    }',
    ),
    (
        "always-attr",
        "多写属性",
        "没有可画字段时也吐 `style=\"\"` → 「没样式时输出逐字节不变」那条守不住",
        '    if css.is_empty() {\n        return Ok(String::new());\n    }',
        '    if false {\n        return Ok(String::new());\n    }',
    ),
    (
        "ignore-color",
        "漏字段",
        "字色不写 → 条件格式的「标红」在预览里消失（本次改动的**主要目的**失效）",
        '        css.push(format!("color:{c}"));',
        '        let _ = c;',
    ),
    (
        "ignore-bg",
        "漏字段",
        "底色不写",
        '        css.push(format!("background-color:{b}"));',
        '        let _ = b;',
    ),
    (
        "ignore-bold",
        "漏字段",
        "加粗不写",
        '        css.push("font-weight:bold".to_string());',
        '        let _ = ();',
    ),
    (
        "bold-normal",
        "语义错",
        "`Some(false)` 也写 `font-weight` → 与 xlsx 侧语义分叉",
        '    if st.bold == Some(true) {',
        '    if st.bold.is_some() {',
    ),
    (
        "no-color-validate",
        "漏校验",
        "颜色不校验 → 认不出的颜色静默画出去（xlsx 侧仍报错，两边不一致）",
        '        if !is_hex_color(c) {\n            return Err(format!("格子 {pos} 的 style.color「{c}」不是 #RRGGBB"));\n        }\n',
        '',
    ),
    (
        "no-size-validate",
        "漏校验",
        "字号不校验 → 0 磅 / 负数字号静默通过",
        '        if !(0.0..=409.0).contains(&sz) || sz <= 0.0 {',
        '        if false {',
    ),
    (
        "font-unit",
        "映射错",
        "字号单位 pt 写成 px",
        '        css.push(format!("font-size:{sz}pt"));',
        '        css.push(format!("font-size:{sz}px"));',
    ),
    (
        "valign-middle",
        "映射错",
        "垂直居中映射成 center（CSS 里 `vertical-align:center` 不合法，等于没设）",
        '                VAlign::Middle => "middle",',
        '                VAlign::Middle => "center",',
    ),
    (
        "halign-right",
        "映射错",
        "右对齐映射成左对齐",
        '                HAlign::Right => "right",',
        '                HAlign::Right => "left",',
    ),
    (
        "wrong-cell",
        "位置错",
        "把**全表第一个**样式套到每一格 → 样式串到隔壁格",
        '                let style_attr = html_style_attr(cell.style.as_ref(), &cell.pos)?;',
        '                let style_attr = html_style_attr(\n                    sheet.rows.iter().flatten().find_map(|x| x.style.as_ref()),\n                    &cell.pos,\n                )?;',
    ),
    # ---- 以下两条**只有探针能抓**（单测直接调 to_html，看不见 HTTP 层与分页接线）----
    (
        "status-500",
        "接线错（仅探针）",
        "render_handler 把校验失败报成 500 → 单测只调 to_html，看不见状态码",
        # 锚点必须带上函数签名：`.map(Json)\n.map_err(|e| (StatusCode::BAD_REQUEST, e))`
        # 这个组合在 mod.rs 里有 **3 处**（render / reports_get / reports_save），
        # 只写那两行会「锚点匹配到 3 处」而拒绝注入（本驱动第一次跑就撞上了）。
        'pub async fn render_handler(\n'
        '    State(state): State<AppState>,\n'
        '    Json(req): Json<RenderRequest>,\n'
        ') -> Result<Json<RenderResponse>, (StatusCode, String)> {\n'
        '    render_with_sources(&state, req)\n'
        '        .await\n'
        '        .map(Json)\n'
        '        .map_err(|e| (StatusCode::BAD_REQUEST, e))',
        'pub async fn render_handler(\n'
        '    State(state): State<AppState>,\n'
        '    Json(req): Json<RenderRequest>,\n'
        ') -> Result<Json<RenderResponse>, (StatusCode, String)> {\n'
        '    render_with_sources(&state, req)\n'
        '        .await\n'
        '        .map(Json)\n'
        '        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))',
    ),
    (
        "pages-drop-style",
        "接线错（仅探针）",
        "分页那条路把样式清掉 → 既有单测只断言 pages_html 里有 `<table`，抓不住",
        '        for p in &all_pages {\n            v.push(to_html(std::slice::from_ref(p))?);\n        }',
        '        for p in &all_pages {\n'
        '            let mut p2 = p.clone();\n'
        '            for r in p2.rows.iter_mut() {\n'
        '                for c in r.iter_mut() {\n'
        '                    c.style = None;\n'
        '                }\n'
        '            }\n'
        '            v.push(to_html(std::slice::from_ref(&p2))?);\n'
        '        }',
    ),
]


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def run_tests() -> tuple[bool, str]:
    """门禁 A：跑 Rust 用例。返回 (是否绿, 输出)。"""
    r = sh(["cargo", "test", "--offline"], cwd=SERVER)
    return r.returncode == 0, r.stdout + r.stderr


def is_compile_break(out: str) -> bool:
    """编译不过 ≠ 用例抓住了 —— 必须区分，否则「注入语法错误」会被读成通过。"""
    return "could not compile" in out or re.search(r"^error\[E\d+\]", out, re.M) is not None


# ---------------------------------------------------------------- 门禁 B：探针


def kill_probe_server() -> None:
    """把占着探针端口的旧进程清掉。

    **不做这一步会「假绿」**：上一轮注入的二进制还活着，探针打的是**旧代码**，
    于是注入看起来「没被抓住」—— 其实是根本没跑注入后的二进制。
    """
    r = sh(["pgrep", "-f", f"print-server --port {PROBE_PORT}"])
    for pid in r.stdout.split():
        try:
            os.kill(int(pid), signal.SIGKILL)
        except (ProcessLookupError, ValueError):
            pass
    # 等端口真的空出来（TIME_WAIT 不影响 listen，但进程退出有延迟）
    for _ in range(50):
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{PROBE_PORT}/health")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            opener.open(req, timeout=0.3)
        except Exception:  # noqa: BLE001 —— 连不上才是我们要的状态
            return
        time.sleep(0.1)


def start_probe_server() -> str | None:
    """起注入后的二进制。返回错误文案（None = 起成功）。"""
    kill_probe_server()
    log = Path("/tmp/fault-inject-html-style-server.log")
    with log.open("wb") as f:
        subprocess.Popen(
            [str(BIN), "--port", str(PROBE_PORT)],
            cwd=SERVER,
            stdout=f,
            stderr=subprocess.STDOUT,
        )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(60):
        try:
            with opener.open(f"http://127.0.0.1:{PROBE_PORT}/health", timeout=0.5) as r:
                json.loads(r.read())
                return None
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    return f"服务 5 秒内没起来，日志：{log.read_text(errors='ignore')[-400:]!r}"


def run_probe() -> tuple[bool, str]:
    """门禁 B：重新编译 + 重启服务 + 跑端到端探针。返回 (是否绿, 输出)。"""
    b = sh(["cargo", "build", "--offline"], cwd=SERVER)
    if b.returncode != 0:
        return False, "构建失败：\n" + b.stdout + b.stderr
    err = start_probe_server()
    if err:
        return False, err
    r = sh([sys.executable, str(REPO / "scripts/verify-html-style.py"), "--port", str(PROBE_PORT)], cwd=REPO)
    return r.returncode == 0, r.stdout + r.stderr


# ---------------------------------------------------------------- 主流程


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只跑名字含该子串的注入")
    ap.add_argument("--list", action="store_true", help="只列出注入，不执行")
    ap.add_argument(
        "--check-anchors",
        action="store_true",
        help="只校验每条锚点在 mod.rs 里恰好匹配 1 处（不编译、不跑用例，秒级）",
    )
    ap.add_argument("--no-probe", action="store_true", help="只跑门禁 A（单测），快")
    ap.add_argument("--no-unit", action="store_true", help="只跑门禁 B（探针）")
    args = ap.parse_args()

    picked = [i for i in INJECTIONS if not args.only or args.only in i[0]]
    if args.list:
        for name, cls, desc, _, _ in picked:
            print(f"  {name:20} [{cls}] {desc}")
        return 0

    path = REPO / MOD
    original = path.read_text(encoding="utf-8")

    if args.check_anchors:
        # 锚点失效要在**跑注入之前**就发现：否则要等一轮编译（几十秒）才知道
        bad = 0
        for name, cls, desc, old, new in picked:
            n = original.count(old)
            if n == 1 and old != new:
                print(f"  {OK} {name:22} [{cls}] 锚点唯一")
            else:
                bad += 1
                print(f"  {BAD} {name:22} [{cls}] 锚点匹配 {n} 处" + ("，且新旧相同（等于没注入）" if old == new else ""))
        return 1 if bad else 0

    do_unit = not args.no_unit
    do_probe = not args.no_probe

    if do_unit:
        print("== 基线（门禁 A：单测）==")
        green, out = run_tests()
        if not green:
            print(f"{BAD} 基线就是红的 —— 先修基线，注入实验才有意义")
            print(out[-2000:])
            return 1
        m = re.search(r"test result: ok\. (\d+) passed", out)
        if not m or int(m.group(1)) == 0:
            print(f"{BAD} 基线没跑出用例（exit=0 但 0 passed）")
            return 1
        print(f"{OK} 基线全绿（{m.group(1)} passed）")

    if do_probe:
        print("== 基线（门禁 B：探针）==")
        green, out = run_probe()
        if not green:
            print(f"{BAD} 探针基线就是红的 —— 先修基线")
            print(out[-2000:])
            return 1
        print(f"{OK} 探针基线全绿")

    print("\n== 逐条注入 ==")
    caught = 0
    problems: list[str] = []
    probe_only = 0
    matrix: list[tuple[str, str, str, str]] = []  # name, cls, unit, probe
    try:
        for name, cls, desc, old, new in picked:
            n = original.count(old)
            if n != 1:
                print(f"  {BAD} {name:20} [{cls}] 锚点匹配到 {n} 处（应当恰好 1 处）")
                problems.append(f"{name}: 锚点失效")
                continue
            path.write_text(original.replace(old, new, 1), encoding="utf-8")

            u_res = "-"
            if do_unit:
                green_u, out_u = run_tests()
                if green_u:
                    u_res = "绿"
                elif is_compile_break(out_u):
                    u_res = "编译失败"
                else:
                    u_res = "红"

            p_res = "-"
            if do_probe:
                # 单测已经证明编译不过时不必再试 —— 但**必须显式记下来**，
                # 否则「没跑」会被读成「没抓住」
                if u_res == "编译失败":
                    p_res = "跳过(编译失败)"
                else:
                    green_p, out_p = run_probe()
                    if green_p:
                        p_res = "绿"
                    elif is_compile_break(out_p):
                        p_res = "编译失败"
                    else:
                        p_res = "红"

            hit = [r for r in (u_res, p_res) if r == "红"]
            if not hit:
                print(f"  {BAD} {name:20} [{cls}] → 两道门禁**全绿**（{desc}）")
                problems.append(f"{name}: 没抓住（单测={u_res} 探针={p_res}）")
            else:
                caught += 1
                if u_res != "红" and p_res == "红":
                    probe_only += 1
                print(f"  {OK} {name:20} [{cls}] → 单测={u_res} 探针={p_res}")

            matrix.append((name, cls, u_res, p_res))
            path.write_text(original, encoding="utf-8")
    finally:
        path.write_text(original, encoding="utf-8")

    print("\n== 还原后复验 ==")
    if do_unit:
        green, out = run_tests()
        if not green:
            print(f"{BAD} 还原后单测基线是红的 —— 工作树可能没恢复干净！")
            print(out[-2000:])
            return 1
        print(f"{OK} 还原后单测基线回到全绿")
    if do_probe:
        green, out = run_probe()
        if not green:
            print(f"{BAD} 还原后探针基线是红的 —— 工作树可能没恢复干净！")
            print(out[-2000:])
            return 1
        print(f"{OK} 还原后探针基线回到全绿")

    # 矩阵：这张表本身就是结论 —— 哪段代码靠哪道门禁守着
    print("\n== 门禁矩阵（红 = 抓住了）==")
    print(f"  {'注入':22} {'类别':16} {'单测':>6} {'探针':>14}")
    for name, cls, u, p in matrix:
        print(f"  {name:22} {cls:16} {u:>6} {p:>14}")
    print(f"\n  {DIM}探针独有（单测全绿而探针红）的注入：{probe_only} 条{OFF}")
    if probe_only == 0 and do_unit and do_probe:
        print(f"  {BAD} 没有任何注入是「只有探针能抓」的 —— 探针可能是摆设，检查一下")

    print(f"\n注入 {len(picked)} 条，至少被一道门禁抓住 {caught} 条")
    if problems:
        print(f"{BAD} 有 {len(problems)} 条没被抓住：")
        for p in problems:
            print(f"    - {p}")
        return 1
    print(f"{OK} 每条注入都让至少一道门禁红了 —— 两道门禁都有牙齿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
