"""print-server 可执行文件的解析 —— Python 侧的**唯一入口**。

## 为什么不在这里重写一遍查找逻辑

与 `node_bin.py` 同一个理由：这些故障注入脚本原先把二进制写死成
`~/.cargo/target/debug/print-server`。那条路**只在本机成立** ——
本机的 `~/.cargo/config.toml` 把 `target-dir` 指到了仓库外；CI 上没有那个文件，
cargo 用的是默认的 `print-server/target`。

写死的结果不是「变红」，是**起不来服务**：`FileNotFoundError`，或者更糟 ——
目录里有一个**上一次构建留下的旧二进制**，注入看起来永远不生效（假绿的一种）。
而「跑不起来的闸」和「永远绿的闸」在结果上是一回事：都给不出任何证据。

## 解析顺序（先问权威，再猜候选）

1. `$PRINT_SERVER_BIN` —— 调用方显式指定，最高优先；
2. `cargo metadata` 的 `target_directory` —— **权威答案**（它读的就是当前环境的
   `~/.cargo/config.toml`，本机与 CI 各自对得上）；
3. 两个候选路径：仓库内 `print-server/target`（CI 默认）、`~/.cargo/target`（本机）；
4. 都不存在 → 抛 `ServerBinNotFound`。**不猜、不静默退回**：拿一个来路不明的
   二进制去验注入，结论整个是废的。

只支持 Linux / macOS（这些脚本不在 Windows 上跑）。
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "print-server"


class ServerBinNotFound(RuntimeError):
    """找不到 print-server 可执行文件 —— 调用方应当直接退出，不要拿别的顶替。"""


def _from_cargo_metadata() -> Path | None:
    try:
        proc = subprocess.run(
            ["cargo", "metadata", "--no-deps", "--format-version", "1",
             "--manifest-path", str(SERVER_DIR / "Cargo.toml")],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    try:
        target_dir = json.loads(proc.stdout).get("target_directory")
    except json.JSONDecodeError:
        return None
    if not target_dir:
        return None
    cand = Path(target_dir) / "debug" / "print-server"
    return cand if cand.is_file() else None


def resolve_server_bin() -> str:
    """返回 print-server 可执行文件的绝对路径；找不到就抛 `ServerBinNotFound`。"""
    explicit = os.environ.get("PRINT_SERVER_BIN")
    if explicit:
        if not Path(explicit).is_file():
            raise ServerBinNotFound(
                f"$PRINT_SERVER_BIN 指向的文件不存在：{explicit}")
        return str(Path(explicit).resolve())

    found = _from_cargo_metadata()
    if found:
        return str(found)

    for cand in (SERVER_DIR / "target" / "debug" / "print-server",
                 Path.home() / ".cargo" / "target" / "debug" / "print-server"):
        if cand.is_file():
            return str(cand.resolve())

    raise ServerBinNotFound(
        "找不到 print-server 可执行文件。已试过：cargo metadata、"
        "print-server/target/debug/print-server、~/.cargo/target/debug/print-server。"
        "先 `cargo build --bin print-server`，或用 $PRINT_SERVER_BIN 显式指定。"
    )


if __name__ == "__main__":  # 手动核对用：python3 scripts/server_bin.py
    try:
        print(resolve_server_bin())
    except ServerBinNotFound as exc:
        raise SystemExit(f"❌ {exc}")
