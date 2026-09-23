"""node 可执行文件的解析 —— Python 侧的**唯一入口**。

## 为什么不在这里重写一遍查找逻辑

`scripts/node-bin.sh` 已经是那条逻辑的家（三个 shell 闸 source 它）。
Python 再抄一份 = 两份必然会漂移的实现，而且漂移的方向恰好是最坏的那种：
抄的那份被修好、原件还坏着，或者反过来。

所以这里**直接调那个 shell 函数**，保证两边永远同一套顺序。

## 事故背景（为什么值得单独成文件）

这些探针 / 故障注入脚本原先把 node 路径写死成
`…/node/versions/22.22.2-2/bin/node`。2026-09-23 环境重新发放，
目录名变成 `22.22.2-3`、`-2` 整个消失 —— 于是它们**连启动都启动不了**。

注意这不是「变红」，是**根本跑不起来**。而「跑不起来的闸」和「永远绿的闸」
在结果上是一回事：都给不出任何证据，却都容易让人以为检查过了。
所以这类脚本必须**大声失败**（`resolve_node()` 抛 `NodeNotFound`），
不能悄悄退回一个来路不明的 node。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_SHELL_RESOLVER = ROOT / "scripts" / "node-bin.sh"


class NodeNotFound(RuntimeError):
    """找不到可用的 node —— 调用方应当直接退出，不要拿别的 node 顶替。"""


def resolve_node() -> str:
    """返回 node 可执行文件的绝对路径；找不到就抛 `NodeNotFound`。

    解析顺序与 `scripts/node-bin.sh` 完全一致（`$NODE_BIN` → `versions/current`
    → 扫 `versions/*/bin/node` → `PATH`）。
    """
    # 1) 先让 shell 版回答 —— 那是唯一的事实来源
    if _SHELL_RESOLVER.is_file():
        proc = subprocess.run(
            ["sh", "-c", f'. "{_SHELL_RESOLVER}" && resolve_node'],
            capture_output=True,
            text=True,
        )
        found = proc.stdout.strip()
        if proc.returncode == 0 and found:
            return found

    # 2) shell 版不在（或它自己坏了）：只剩 $NODE_BIN 可以信，
    #    因为那是调用方显式指定的，不是我们猜的
    explicit = os.environ.get("NODE_BIN")
    if explicit and Path(explicit).is_file():
        return explicit

    raise NodeNotFound(
        "找不到可用的 node。"
        f"（已试过 {_SHELL_RESOLVER}、$NODE_BIN。）"
        "托管 node 在 ~/.workbuddy-ai/binaries/node/versions/ 下，"
        "版本后缀会随环境重发而变 —— 别把路径写死。"
    )


if __name__ == "__main__":  # 手动核对用：python3 scripts/node_bin.py
    try:
        print(resolve_node())
    except NodeNotFound as exc:
        raise SystemExit(f"❌ {exc}")
