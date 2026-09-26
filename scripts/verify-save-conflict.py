#!/usr/bin/env python3
"""真机探针：**覆盖已有报表必须被服务端拦住，除非显式带 force**。

## 为什么必须起真服务

单测覆盖的是 `store::save_new` 这个函数。它**证明不了**下面这三件事，
而这三件恰恰是「这道闸到底有没有用」的全部：

1. **HTTP 状态码真的是 409** —— UI 靠状态码分辨「弹错误」还是「弹覆盖确认框」。
   函数返回 `SaveError::Conflict` 而 handler 把它映射成 400 的话，单测照样全绿，
   而线上那个确认框**永远弹不出来**。
2. **`?force=1` 真的能穿透** —— 反向也成立：闸要是把 force 也拦了，
   用户点了「覆盖」还是存不了。两条路都得走通，闸才算装对了。
3. **查询串解析的口径** —— `?force=flase`（typo）、`?force=0`、`?force`（空值）
   必须**都不算**强制。这条只有真发一次请求才验得到：
   axum 的 `Query` 反序列化、字符串比较、大小写，全在 Rust 侧。

单测里那段「假服务端」是我自己写的，它按我**以为**的规则回 409 ——
所以它只能证明 UI 的接线对，证明不了服务端的规则对。这个探针补的就是那一段。

## 判据

| # | 请求 | 期望 | 为什么 |
| --- | --- | --- | --- |
| 1 | 新建（无 force） | 200 | 闸不能把正常新建也拦了 |
| 2 | 同名再存（无 force） | **409** + 文件**逐字节没变** | 拒绝必须零副作用 |
| 3 | 同名再存 `?force=1` | 200 + 内容**变了** | 确认之后要真的能覆盖 |
| 4 | `?force=0` / `?force=flase` / `?force` | 仍 **409** | 「提过这事」≠「证明你知道」 |
| 5 | `?force=true` / `?force=yes` | 200 | 口径与 Rust `SaveQuery::forced` 一致 |
| 6 | 非法 id（`bad/id`） | **400**，不是 409 | 先校验再查存在性；报成 409 会把用户指向错误方向 |

第 2 条的「逐字节没变」是核心：只断言状态码 409 的话，
「先覆盖了再返回 409」这种实现也能过 —— 那就成了**又毁数据又报错**。

用法：python3 scripts/verify-save-conflict.py
退出码：0 = 契约成立；1 = 有缺陷；2 = 没验成（服务起不来 / 二进制不在）。
"""

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"
BIN = Path.home() / ".cargo/target/debug/print-server"
REPORTS = SERVER_DIR / "reports"

PROBE_ID = "conflict-probe"

BASE = "http://127.0.0.1:18888"
HEALTH = f"{BASE}/api/report/sample-template"
SAVE = f"{BASE}/api/reports/save"

# ⚠️ 沙箱里 HTTP_PROXY 指向本地代理，探 127.0.0.1 会被拦成 502 —— 必须绕过
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_failures: list[str] = []


def req(method: str, url: str, body: bytes | None = None, timeout: float = 10):
    r = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with _OPENER.open(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        return None, str(e).encode()


def _port_pid() -> int | None:
    r = subprocess.run(
        ["lsof", "-nP", "-iTCP:18888", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True,
    )
    out = r.stdout.strip()
    return int(out.splitlines()[0]) if out else None


def clear_port() -> None:
    """起服务前先确保 18888 上是空的 —— 否则探针会打到**上一轮残留的旧进程**上，
    症状是「服务死了但活干完了」那种自相矛盾。见 `fault-injection-verify` 的反面模式。
    """
    subprocess.run(["pkill", "-f", str(BIN)], capture_output=True, text=True)
    before = _port_pid()
    if before is not None:
        print(f"   （先清端口：杀掉占着 18888 的 pid={before}）")
    for _ in range(40):
        if _port_pid() is None:
            return
        time.sleep(0.25)
    raise SystemExit("✗ 清端口超时：18888 上仍有进程占着")


def start_server():
    clear_port()
    p = subprocess.Popen(
        [str(BIN)], cwd=SERVER_DIR,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(80):
        time.sleep(0.25)
        code, _ = req("GET", HEALTH, timeout=1)
        if code is not None:
            # ★ 答上来的必须**是我起的这个**
            owner = _port_pid()
            if owner != p.pid:
                stop_server(p)
                raise SystemExit(
                    f"✗ 端口答话的不是我起的进程（我起的 pid={p.pid}，占端口的是 "
                    f"pid={owner}）—— 继续跑下去会验到旧进程上"
                )
            return p
        if p.poll() is not None:
            raise SystemExit(f"✗ print-server 起不来（退出码 {p.returncode}）")
    stop_server(p)
    raise SystemExit("✗ print-server 起来了但一直连不上")


def stop_server(p) -> None:
    if p.poll() is None:
        p.terminate()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait(timeout=5)


def payload(description: str, rid: str = PROBE_ID) -> bytes:
    return json.dumps(
        {
            "format": "openprint.report",
            "version": 1,
            "id": rid,
            "name": "冲突探针",
            "description": description,
            "template": {"sheets": []},
        },
        ensure_ascii=False,
    ).encode()


def check(ok: bool, expect: str) -> None:
    """`expect` 必须写成**「应当成立的那件事」**，不能写成「出问题时的现象」。

    这条不是文风问题：写反了会印出「✓ 被拒绝的保存把文件改了」这种行 ——
    绿着，但读起来像在报告一个缺陷。探针的输出是给人看的证据，
    **一行绿字必须能当句子读**，否则以后没人敢信它。
    """
    print(("  ✓ " if ok else "  ✗ ") + expect)
    if not ok:
        _failures.append(expect)


def main() -> int:
    if not BIN.exists():
        print(f"✗ 找不到二进制 {BIN}，先 cargo build")
        return 2

    target = REPORTS / f"{PROBE_ID}.json"
    # 清掉上一轮残留（含 .bak/.tmp），否则第 1 步就会被 409 顶回来
    for suffix in ("", ".bak", ".tmp"):
        f = REPORTS / f"{PROBE_ID}.json{suffix}"
        if f.is_dir():
            import shutil

            shutil.rmtree(f)
        elif f.exists():
            f.unlink()

    p = start_server()
    try:
        # ── 1. 新建：不带 force 必须放行 ──────────────────────────────
        print("1) 新建（不带 force）→ 期望 200")
        st, body = req("PUT", SAVE, payload("v1"))
        check(st == 200, f"新建应当 200，实际 {st} {body[:160]!r}")
        if st != 200:
            return 2
        v1 = target.read_bytes()
        print(f"   落盘 {len(v1)} 字节")

        # ── 2. 同名再存：不带 force 必须 409，且**文件一个字节都不许动** ──
        print("2) 同名再存（不带 force）→ 期望 409，且文件逐字节不变")
        st, body = req("PUT", SAVE, payload("v2"))
        check(st == 409, f"应当 409，实际 {st} {body[:160]!r}")
        check(b"force" in body, f"409 的说明里应当提到 force，实际 {body[:200]!r}")
        after = target.read_bytes()
        # 这一条是核心：只断言状态码的话，「先覆盖了再返回 409」也能过 ——
        # 那就成了又毁数据又报错，比不报错还坏。
        check(
            after == v1,
            f"被拒绝的保存必须让文件**逐字节不变**（拒绝前的 {len(v1)} 字节 vs 拒绝后的 {len(after)} 字节）",
        )
        check(
            not (REPORTS / f"{PROBE_ID}.json.bak").exists(),
            "被拒绝的保存不该留下 .bak（有 .bak 说明它其实已经动过盘了）",
        )

        # ── 3. 显式 force：必须穿透 ────────────────────────────────
        print("3) 同名再存（?force=1）→ 期望 200，且内容真的换了")
        st, body = req("PUT", f"{SAVE}?force=1", payload("v3"))
        check(st == 200, f"带 force 应当 200，实际 {st} {body[:160]!r}")
        v3 = target.read_bytes()
        check(
            v3 != v1,
            f"带 force 之后内容必须真的变了（{len(v1)} 字节 → {len(v3)} 字节）",
        )
        check(
            b'"v3"' in v3 or b"v3" in v3,
            "force 覆盖之后文件里应当是新内容",
        )

        # ── 4. 「提过这事」不等于「证明你知道」 ───────────────────────
        # 这几个值都**不算**强制。判错方向的代价是静默覆盖，所以一律往「当没带」倒。
        print("4) force 的非真值 / typo → 必须仍然 409")
        for raw in ("0", "flase", "false", "no", ""):
            url = f"{SAVE}?force={raw}" if raw != "" else f"{SAVE}?force"
            st, body = req("PUT", url, payload("v4"))
            check(
                st == 409,
                f"?force={raw!r} 应当仍被拒（409），实际 {st} —— "
                f"typo 被当成授权就等于这道闸不存在",
            )

        # ── 5. 口径与 Rust `SaveQuery::forced` 一致 ──────────────────
        print("5) force 的真值写法（true / yes / 1，含大小写与空白）→ 必须放行")
        for raw in ("true", "TRUE", "yes", "%201%20"):
            st, _ = req("PUT", f"{SAVE}?force={raw}", payload("v5"))
            check(st == 200, f"?force={raw!r} 应当放行（200），实际 {st}")

        # ── 6. 非法 id：400，不是 409 ──────────────────────────────
        # 顺序反了的话（先查存在性再校验），非法 id 会报成「已存在」，
        # 把用户指向完全错误的方向；更糟的是 `path_of` 会拿未校验的 id 拼路径。
        print("6) 非法 id（bad/id）→ 期望 400，不是 409")
        st, body = req("PUT", SAVE, payload("v6", rid="bad/id"))
        check(st == 400, f"非法 id 应当 400，实际 {st} {body[:160]!r}")
        check(b"id \xe4\xb8\x8d\xe5\x90\x88\xe6\xb3\x95" in body, "400 应当说明是 id 不合法")
    finally:
        stop_server(p)
        # 收尾：别把探针报表留在用户的报表目录里
        req("DELETE", f"{BASE}/api/reports/{PROBE_ID}")

    print()
    if _failures:
        print(f"✗ 有 {len(_failures)} 条不成立：")
        for m in _failures:
            print(f"   - {m}")
        return 1
    print("✓ 覆盖冲突契约成立：无 force 被拒且零副作用、有 force 能穿透、")
    print("  typo 不当授权、非法 id 是 400 而不是 409。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
