#!/usr/bin/env python3
"""真机探针：**写盘被打断时，报表文件必须还是上一版的完整内容**。

## 为什么必须起真服务

单测能覆盖「写入失败」（把 `.tmp` 占成目录 → `fs::write` 报 EISDIR），
但覆盖不了**最要命的那一种**：进程写到一半**直接死掉**。
那一瞬间 `std::fs::write` 已经把目标文件 `truncate` 成 0 了 ——
而 `truncate` 是不可逆的。要复现它，必须让一个**真进程**在**真写盘**的中途被杀。

## 怎么造出「写一半死掉」

`RLIMIT_FSIZE` + SIGXFSZ：

```python
resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))   # 子进程只能写 LIMIT 字节
```

写超过这个上限时内核发 **SIGXFSZ**，而它的默认处置是**终止进程** ——
正好就是「写到一半死掉」。于是：

| 实现 | 目标文件 | 结果 |
| --- | --- | --- |
| 非原子（`fs::write` 直接写目标） | 先被 truncate 成 0，再灌进 LIMIT 字节，然后进程死 | **截断的 JSON，解析失败** |
| 原子（写 `.tmp` → `rename`） | **压根没被碰过** | 上一版完整内容 |

探针断言后者。判据是**文件字节逐字节不变**，不是「能解析」——
「能解析」在旧内容恰好也合法时会给出假绿。

## 关于「服务必须真的死了」

如果服务**没死**，说明这次写入根本没被打断，**探针什么都没验到**。
那种情况必须报「**没验过**」并退出码 2，绝不能当成通过 ——
这正是本项目最忌讳的那种绿：跑完了、没报错、但其实什么都没检查。

用法：python3 scripts/verify-atomic-save.py
退出码：0 = 原子性成立；1 = 旧文件被写坏了（真缺陷）；2 = 没验成（服务没被打断 / 起不来）。
"""

import json
import resource
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

PROBE_ID = "atomic-save-probe"
# 子进程能写的单文件上限。取 256 KiB：
#   - 够大，服务自己启动时不写任何东西（配置已存在，也不打日志文件）
#   - 够小，我们那个 1 MiB 的报表必然写不完
LIMIT = 256 * 1024
BIG = 1024 * 1024  # 1 MiB，远大于 LIMIT

BASE = "http://127.0.0.1:18888"
HEALTH = f"{BASE}/api/report/sample-template"
SAVE = f"{BASE}/api/reports/save"
# 覆盖已有报表要**显式**带 force：服务端 `store::save_new` 对「已存在且没带 force」
# 一律回 409（这是防静默覆盖的那道闸）。本探针第 2 步就是**故意覆盖** v1，
# 所以必须带 —— 不带的话会在真正测「写一半崩」之前就先被 409 拦掉，
# 而那看起来会像「原子性没验成」，其实是探针没带对参数。
SAVE_FORCE = f"{SAVE}?force=1"
GET = f"{BASE}/api/reports/{PROBE_ID}"

# ⚠️ 沙箱里 HTTP_PROXY 指向本地代理，探 127.0.0.1 会被拦成 502 —— 必须绕过
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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
        # 服务被打死时就是这个（连接被重置 / 空回复）
        return None, str(e).encode()


def _limit_filesize(nbytes: int):
    def pre():
        resource.setrlimit(resource.RLIMIT_FSIZE, (nbytes, nbytes))
    return pre


def _port_pid() -> int | None:
    """占着 18888 的那个进程的 PID（没人占则 None）。"""
    r = subprocess.run(
        ["lsof", "-nP", "-iTCP:18888", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True,
    )
    out = r.stdout.strip()
    return int(out.splitlines()[0]) if out else None


def clear_port() -> None:
    """起服务前先确保 18888 上是空的。

    ⚠️ **这一步不是顺手清理，是正确性要求。** 少了它会出一个自相矛盾的输出：
    「服务进程已退出 = True」**同时**「写入成功」。原因是我起的那个进程（带着
    `RLIMIT_FSIZE`）在 bind 时失败退出了，而 health 检查与后面的 PUT 全被
    **上一轮残留的旧进程**答上了 —— 那个进程没有限额，于是写了个完整的大文件。

    这个坑在 `fault-injection-verify` 的反面模式里写着（「复用上一轮的端口而不先
    杀进程」），我这次又踩了一遍：症状是「服务死了但活干完了」。
    """
    killed = subprocess.run(
        ["pkill", "-f", str(BIN)], capture_output=True, text=True
    )
    before = _port_pid()
    if before is not None:
        # 不静默杀进程：这可能是用户自己开着做手工验证的那一个。
        # 但**必须**杀 —— 否则探针会打到旧进程上（见上面那段）。
        print(f"   （先清端口：杀掉占着 18888 的 pid={before}）")
    for _ in range(40):
        if _port_pid() is None:
            return
        time.sleep(0.25)
    print("⚠ 清端口超时：18888 上仍有进程占着")
    if killed.stdout.strip() or killed.stderr.strip():
        print(f"  pkill 输出：{killed.stdout.strip()} {killed.stderr.strip()}")


def start_server(limit: int | None = None):
    """起服务，并**确认占着端口的就是我起的这个进程**。`limit` 不为 None 时加 RLIMIT_FSIZE。"""
    clear_port()
    kwargs = {}
    if limit is not None:
        kwargs["preexec_fn"] = _limit_filesize(limit)
    p = subprocess.Popen(
        [str(BIN)],
        cwd=SERVER_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **kwargs,
    )
    for _ in range(80):
        time.sleep(0.25)
        code, _ = req("GET", HEALTH, timeout=1)
        if code is not None:
            # ★ 关键一步：答上来的必须**是我起的这个**，不能是别人。
            # 只查「端口有人答话」是不够的 —— 那正是上面那个坑的入口。
            owner = _port_pid()
            if owner != p.pid:
                stop_server(p)
                raise SystemExit(
                    f"✗ 端口答话的不是我起的进程（我起的 pid={p.pid}，占端口的是 "
                    f"pid={owner}）—— 继续跑下去会验到旧进程上"
                )
            return p
        if p.poll() is not None:
            raise SystemExit(f"✗ print-server 起不来（退出码 {p.returncode}，端口被占？）")
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


def def_payload(description: str) -> bytes:
    """一个最小的合法 ReportDef。description 用来灌大体积。"""
    return json.dumps(
        {
            "format": "openprint.report",
            "version": 1,
            "id": PROBE_ID,
            "name": "原子写探针",
            "description": description,
            "template": {"sheets": []},
        },
        ensure_ascii=False,
    ).encode()


def main() -> int:
    if not BIN.exists():
        print(f"✗ 找不到二进制 {BIN}，先 cargo build")
        return 2

    target = REPORTS / f"{PROBE_ID}.json"
    # 清掉上一轮的残留，别让它们影响判断
    for suffix in ("", ".bak", ".tmp"):
        f = REPORTS / f"{PROBE_ID}.json{suffix}"
        if f.is_dir():
            import shutil

            shutil.rmtree(f)
        elif f.exists():
            f.unlink()

    # ── 1. 存一版小的（v1），确认它落盘完整 ──────────────────────────
    print("1) 存第一版（小）…")
    p = start_server()
    try:
        code, body = req("PUT", SAVE, def_payload("v1"))
        if code != 200:
            print(f"✗ 保存 v1 失败：HTTP {code} {body[:200]!r}")
            return 2
    finally:
        stop_server(p)

    if not target.exists():
        print(f"✗ 目标文件没落盘：{target}")
        return 2
    v1_bytes = target.read_bytes()
    print(f"   v1 落盘 {len(v1_bytes)} 字节，可解析 = {_parses(v1_bytes)}")

    # ── 2. 带 RLIMIT_FSIZE 起服务，写一版巨大的（v2）→ 期望服务被打死 ──
    print(f"2) 带 RLIMIT_FSIZE={LIMIT} 起服务，存第二版（{BIG} 字节 description）…")
    p = start_server(limit=LIMIT)
    code, body = req("PUT", SAVE_FORCE, def_payload("x" * BIG), timeout=15)
    died = p.poll() is not None
    stop_server(p)
    print(f"   PUT 返回：{'（连接断了）' if code is None else f'HTTP {code}'}")
    print(f"   服务进程已退出 = {died}")

    if not died:
        print()
        print("⚠ **没验成**：服务没被打断，这次写入根本没走到「写一半」那一步。")
        print("   常见原因：LIMIT 太大（报表没超过它）/ 服务没换成新二进制。")
        print("   —— 这种情况**不等于通过**，别当绿读。")
        return 2

    # ── 3. 重启服务，读回来 ────────────────────────────────────────────
    print("3) 重启服务，读回这份报表…")
    p = start_server()
    try:
        code, body = req("GET", GET)
    finally:
        stop_server(p)

    after = target.read_bytes() if target.exists() else b""
    same = after == v1_bytes
    print(f"   目标文件 {len(after)} 字节（v1 是 {len(v1_bytes)}）")
    print(f"   与 v1 逐字节相同 = {same}")
    print(f"   GET 返回 HTTP {code}，可解析 = {_parses(body)}")

    # 清理探针留下的东西
    for suffix in ("", ".bak", ".tmp"):
        f = REPORTS / f"{PROBE_ID}.json{suffix}"
        if f.is_dir():
            import shutil

            shutil.rmtree(f)
        elif f.exists():
            f.unlink()

    print()
    if not same:
        print("✗ **原子性不成立**：写盘被打断后目标文件变了 —— 上一版被写坏了。")
        print(f"  现在文件里是 {len(after)} 字节，前 120 字节：{after[:120]!r}")
        return 1
    if code != 200:
        print(f"✗ 文件字节没变但读不出来（HTTP {code}）：{body[:200]!r}")
        return 1
    print("✓ 原子性成立：写盘被打断，上一版仍然**逐字节完好**且可读。")
    return 0


def _parses(data: bytes) -> bool:
    try:
        json.loads(data)
        return True
    except Exception:
        return False


if __name__ == "__main__":
    sys.exit(main())
