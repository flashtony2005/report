#!/usr/bin/env python3
"""真机探针：**`updatedAt` 乐观锁（`?base=`）真的拦住了「别人改过之后我还存」**。

## 为什么必须起真服务

单测覆盖的是 `store::save` 与 `SaveQuery::expect` 两个**纯函数**。它证明不了
下面这四件事，而这四件恰恰是「这把锁到底有没有用」的全部：

1. **状态码真的是 412**，且**不是 409**。这两条路要求调用方做**完全不同**的事：
   409 是「你没说可以覆盖，说了就行」—— 客户端**原样重发**即可；
   412 是「你手上的东西过期了」—— 原样重发**毫无意义**。
   单测里 `SaveError::Stale` 分得再清楚，handler 把它映射成 409 的话单测照样全绿，
   而 UI 会把它当成「要不要覆盖」弹出去 —— 用户点「覆盖」就把别人的改动盖掉了。
2. **412 的响应体带 `expected` / `actual`**。函数层的 `Stale { expected, actual }`
   到 HTTP 那一步要经过 serde 序列化，字段名（`camelCase`）、`None` 的形态
   （是 `null` 还是缺字段）都只有真发一次请求才验得到。
   没有这两个字段，UI 只能说「对不上」，说不出「对不上什么」。
3. **`base` 真的压过 `force`**。单测验的是纯函数；这里验的是**查询串解析之后**
   还是这个结论（axum 的 `Query` 反序列化、`Option<String>` 的形态都在 Rust 侧）。
4. **被拒绝时零副作用** —— 只断言状态码的话，「先覆盖了再返回 412」也能过。

## 判据

| # | 请求 | 期望 |
| --- | --- | --- |
| 1 | 新建 | 200，拿到 V1 |
| 2 | `?base=V1`（版本对得上） | 200，且**新版本 ≠ V1**、内容真的换了 |
| 3 | 再用 `?base=V1`（已过期） | **412** + body 里 `expected=V1` / `actual=<当前>` + 文件**逐字节不变** + 无 `.bak` |
| 4 | `?base=<乱填>` | 412 |
| 5 | `?base=V1&force=1` | **412**（base 压过 force，真机再验一遍） |
| 6 | 用**响应里**的新版本当 base 接着存 | 200（回填链路通，否则第二次保存会 412 自己） |
| 7 | `?base=`（空值） | 落回「没带 base」那条路 → 不带 force 时 **409** |
| 8 | 对一个**不存在**的报表带 base | **412**，且 `actual` 是 `null`（不是「当成新建」） |

第 2 条的「新版本 ≠ V1」不是凑数：保存后 token 不变的话，客户端把响应里的
`updatedAt` 回填成下一次的 base 之后，**下一次保存会拿一个和当前相同的版本去比**，
永远撞自己 —— 而第 6 条正是那个流程。

用法：python3 scripts/verify-optimistic-lock.py
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

PROBE_ID = "cas-probe"

BASE = "http://127.0.0.1:18888"
HEALTH = f"{BASE}/api/report/sample-template"
SAVE = f"{BASE}/api/reports/save"

# ⚠️ 沙箱里 HTTP_PROXY 指向本地代理，探 127.0.0.1 会被拦成 502 —— 必须绕过
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_failures: list[str] = []


class Broken(Exception):
    """**前面的步骤就不成立**，后面的步骤没法接着验。

    ⚠️ 这必须和「没验成」分开：`没验成`（退出码 2）的意思是
    「服务起不来 / 二进制不在 —— 我什么结论都没有」；而这里的意思是
    「契约**已经**被破坏了，只是坏在我还没走到后面那几步」。
    混成一个码的后果很具体：注入脚本把「2」当成「没验过」，
    于是**一条真实的回归被报成「这条注入没抓到」** ——
    看起来像注入写坏了，其实是探针在替被测代码遮掩。
    （第一版就是 `return 2`，L9 那条注入当场暴露了它。）
    """


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
    症状是「服务死了但活干完了」那种自相矛盾。
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
            "name": "乐观锁探针",
            "description": description,
            "template": {"sheets": []},
        },
        ensure_ascii=False,
    ).encode()


def check(ok: bool, expect: str) -> None:
    """`expect` 必须写成**「应当成立的那件事」**，不能写成「出问题时的现象」。

    写反了会印出「✓ 被拒绝了却把文件改了」这种行 —— 绿着，但读起来像在报告缺陷。
    探针的输出是给人看的证据，**一行绿字必须能当句子读**。
    """
    print(("  ✓ " if ok else "  ✗ ") + expect)
    if not ok:
        _failures.append(expect)


def stamp_of(body: bytes) -> str | None:
    """从保存响应里取 `updatedAt`。取不到就返回 None（调用方会判）。"""
    try:
        return json.loads(body).get("updatedAt")
    except Exception:
        return None


def main() -> int:
    if not BIN.exists():
        print(f"✗ 找不到二进制 {BIN}，先 cargo build")
        return 2

    target = REPORTS / f"{PROBE_ID}.json"
    bak = REPORTS / f"{PROBE_ID}.json.bak"

    def wipe() -> None:
        for f in (target, bak, REPORTS / f"{PROBE_ID}.json.tmp"):
            if f.is_dir():
                import shutil

                shutil.rmtree(f)
            elif f.exists():
                f.unlink()

    wipe()
    p = start_server()
    try:
        # ── 1. 新建，拿到第一个版本 ────────────────────────────────
        print("1) 新建 → 期望 200，并拿到 V1")
        st, body = req("PUT", SAVE, payload("v1"))
        check(st == 200, f"新建应当 200，实际 {st} {body[:160]!r}")
        v1 = stamp_of(body)
        check(v1 is not None, f"保存响应里必须带 updatedAt，实际 {body[:200]!r}")
        if st != 200 or v1 is None:
            # 不是「没验成」—— 契约已经坏了，只是坏得没法再往下验
            raise Broken
        print(f"   V1 = {v1}")

        # ── 2. 版本对得上 → 放行，且**换出新版本** ────────────────────
        print("2) ?base=V1（版本对得上）→ 期望 200，且新版本 ≠ V1")
        st, body = req("PUT", f"{SAVE}?base={v1}", payload("v2"))
        check(st == 200, f"版本对得上应当 200，实际 {st} {body[:160]!r}")
        v2 = stamp_of(body)
        check(
            v2 is not None and v2 != v1,
            f"保存后必须换出**不同**的版本号（{v1} → {v2}）—— 不变的话客户端回填 base 会永远撞自己",
        )
        check(b"v2" in target.read_bytes(), "版本对上了却没把内容写进去")
        if v2 is None:
            raise Broken

        # ── 3. 版本过期 → 412，且零副作用 ─────────────────────────
        # ⚠️ 前两步的覆盖**自己会留下 .bak**。不清掉它，「有没有 .bak」就再也
        # 回答不了「这次被拒绝的保存动没动过盘」—— 断言会一直在测**上一次**保存。
        # （单测里第一版就是这么写错的。）判据必须只由被测机制决定。
        print("3) 再用 ?base=V1（已过期）→ 期望 412 + 带 expected/actual + 零副作用")
        assert bak.exists(), "前提没搭对：第 2 步的覆盖本该留下 .bak"
        bak.unlink()
        before = target.read_bytes()

        st, body = req("PUT", f"{SAVE}?base={v1}", payload("v3-stale"))
        check(
            st == 412,
            f"版本过期应当 **412**（不是 409），实际 {st} {body[:200]!r}",
        )
        check(
            st != 409,
            "版本过期报成了 409 —— UI 会把它当成「要不要覆盖」弹出去，"
            "用户点「覆盖」就把别人的改动盖掉了",
        )
        try:
            cas = json.loads(body)
        except Exception:
            cas = None
        check(cas is not None, f"412 的响应体必须是 JSON（UI 要读字段），实际 {body[:200]!r}")
        if cas is not None:
            check(
                cas.get("expected") == v1,
                f"412 的 expected 应当是调用方声明的版本 {v1}，实际 {cas.get('expected')!r}",
            )
            check(
                cas.get("actual") == v2,
                f"412 的 actual 应当是服务端当前版本 {v2}，实际 {cas.get('actual')!r}",
            )
        check(
            target.read_bytes() == before,
            "被拒绝的保存必须让文件**逐字节不变**（不然就是又毁数据又报错）",
        )
        check(
            not bak.exists(),
            "被拒绝的保存不该留下 .bak（有 .bak 说明它其实已经动过盘了）",
        )

        # ── 4. 乱填的 base → 412 ──────────────────────────────────
        print("4) ?base=<乱填> → 期望 412")
        st, _ = req("PUT", f"{SAVE}?base=1970-01-01T00:00:00.000Z", payload("v4"))
        check(st == 412, f"乱填的 base 应当 412，实际 {st}")

        # ── 5. base 压过 force ────────────────────────────────────
        print("5) ?base=V1&force=1 → 期望 412（base 压过 force）")
        st, body = req("PUT", f"{SAVE}?base={v1}&force=1", payload("v5"))
        check(
            st == 412,
            f"两个都带时应当按 base 走（412），实际 {st} {body[:200]!r} —— "
            f"按 force 走的话，一个带 base 的请求会**静默退化成盲覆盖**",
        )

        # ── 6. 回填：用响应里的新版本接着存 ───────────────────────────
        print("6) 用响应里的新版本当 base 接着存 → 期望 200")
        st, body = req("PUT", f"{SAVE}?base={v2}", payload("v6"))
        check(
            st == 200,
            f"回填新版本之后应当能接着存（200），实际 {st} {body[:200]!r} —— "
            f"412 了就说明保存响应里的 updatedAt 不能当下一轮的 base",
        )
        v3 = stamp_of(body)
        check(v3 is not None and v3 != v2, f"第三次保存也该换出新版本（{v2} → {v3}）")

        # ── 7. 空 base 当没带 ─────────────────────────────────────
        print("7) ?base=（空值）→ 期望落回「没带 base」那条路（不带 force → 409）")
        st, _ = req("PUT", f"{SAVE}?base=", payload("v7"))
        check(
            st == 409,
            f"空 base 应当当没带 → 目标已存在且没授权 → 409，实际 {st}",
        )

        # ── 8. 对不存在的报表带 base → 412（不是「当成新建」）──────────
        print("8) 对不存在的报表带 base → 期望 412，且 actual 为 null")
        missing = "cas-probe-missing"
        mf = REPORTS / f"{missing}.json"
        if mf.exists():
            mf.unlink()
        st, body = req(
            "PUT", f"{SAVE}?base={v1}", payload("v8", rid=missing)
        )
        check(
            st == 412,
            f"base 指向的文件不存在时应当 412（基础已没了），实际 {st} {body[:200]!r}",
        )
        try:
            cas8 = json.loads(body)
        except Exception:
            cas8 = None
        check(
            cas8 is not None and cas8.get("actual", "缺字段") is None,
            f"文件不存在时 actual 必须是 null，实际 {body[:200]!r}",
        )
        check(
            not mf.exists(),
            "被拒绝的保存不该凭空造出文件（那是「当成新建」的症状）",
        )
    except Broken:
        # 契约已经坏了（前面那几步的 ✗ 已经记进 `_failures`），
        # 照实报成失败 —— **不能报成「没验成」**
        pass
    finally:
        stop_server(p)
        # 收尾：别把探针报表留在用户的报表目录里
        req("DELETE", f"{BASE}/api/reports/{PROBE_ID}")
        wipe()
        for f in (REPORTS / "cas-probe-missing.json",):
            if f.exists():
                f.unlink()

    print()
    if _failures:
        print(f"✗ 有 {len(_failures)} 条不成立：")
        for m in _failures:
            print(f"   - {m}")
        return 1
    print("✓ 乐观锁契约成立：版本对得上放行并换出新版本、过期报 412（带 expected/actual）")
    print("  且零副作用、base 压过 force、响应里的新版本可以回填当下一轮的 base。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
