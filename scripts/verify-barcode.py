#!/usr/bin/env python3
"""用 zxing 解码 oracle 验证条码编码器（自研，零依赖）。

## 为什么必须有这一层

`barcode.rs` 里 40 多条单测全绿，只能证明**内部自洽**：
- 图案表抄错一个数字 —— 单测还是绿的（它自己和自己比）；
- 之字形扫描方向反了 —— 单测还是绿的；
- 掩码算完忘了应用 —— 单测还是绿的。

这些错误在屏幕上全都看不出来（图还是个方块），只有**真正的解码器**
说「读出来是这串」才算数。所以这个脚本把编码器倒出来的位矩阵栅格化成
PNG，交给 zxing-cpp（C++ 移植版，业界通用实现）解回来，逐条比对原文。

## 判据

1. 每个样本都必须**解出恰好一个**条码（解出 0 个 = 编码器坏了；
   解出 2 个 = 静区/边界有问题，扫码枪会挑错）。
2. 解出来的文本必须**逐字节等于**原文（含中文 UTF-8、含控制字符）。
3. 解出来的码制必须与声明一致（qr / code128），不能「碰巧解成别的」。

## 用法

    /Users/lushaohui/.workbuddy-ai/binaries/python/envs/default/bin/python \
        scripts/verify-barcode.py [--keep]

先由 Rust 侧倒出位矩阵（`BARCODE_DUMP_DIR` 指向临时目录），再跑本脚本。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "print-server"
VENV_PY = Path("/Users/lushaohui/.workbuddy-ai/binaries/python/envs/default/bin/python")

# 栅格化倍数：二维码方形，一维码已经很扁，倍数要小一些
QR_SCALE = 8
BAR_SCALE = 3


def fail(msg: str) -> None:
    print(f"✗ {msg}")
    sys.exit(1)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def dump_matrices(out_dir: Path) -> None:
    """跑 Rust 侧的 `#[ignore]` 脚手架，把样本位矩阵倒出来。"""
    env = dict(os.environ, BARCODE_DUMP_DIR=str(out_dir))
    r = run(
        ["cargo", "test", "--offline", "report::barcode::tests::dump_matrices_for_external_oracle",
         "--", "--ignored", "--nocapture"],
        cwd=SERVER, env=env,
    )
    if r.returncode != 0:
        # --offline 在依赖缺失时会失败，回落一次联网构建
        r = run(
            ["cargo", "test", "report::barcode::tests::dump_matrices_for_external_oracle",
             "--", "--ignored", "--nocapture"],
            cwd=SERVER, env=env,
        )
    if r.returncode != 0:
        fail(f"倒出位矩阵失败:\n{r.stdout}\n{r.stderr}")
    if not (out_dir / "index.tsv").exists():
        fail(f"没有生成 index.tsv，实际内容：{sorted(p.name for p in out_dir.iterdir())}")


def rasterize(text: str, scale: int):
    """位矩阵文本（'1' = 黑）→ PIL 灰度图。白底黑条，四周留白。"""
    from PIL import Image

    rows = [ln for ln in text.splitlines() if ln.strip()]
    h, w = len(rows), len(rows[0])
    for i, ln in enumerate(rows):
        if len(ln) != w:
            fail(f"矩阵第 {i} 行长度 {len(ln)} 与首行 {w} 不一致")

    img = Image.new("L", (w * scale, h * scale), 255)
    px = img.load()
    for r, ln in enumerate(rows):
        for c, ch in enumerate(ln):
            if ch == "1":
                for dy in range(scale):
                    for dx in range(scale):
                        px[c * scale + dx, r * scale + dy] = 0
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留临时目录（排查用）")
    args = ap.parse_args()

    try:
        import zxingcpp  # noqa: F401
    except ImportError:
        fail(
            "缺少 zxingcpp（解码 oracle）。装法：\n"
            f"  {VENV_PY} -m pip install zxing-cpp"
        )

    tmp = Path(tempfile.mkdtemp(prefix="barcode-verify-"))
    print(f"· 临时目录 {tmp}")
    try:
        dump_matrices(tmp)

        index = (tmp / "index.tsv").read_text(encoding="utf-8").strip().splitlines()
        if not index:
            fail("index.tsv 是空的")

        failures: list[str] = []
        checks = 0

        for line in index:
            name, sym, w, h = line.split("\t")
            text = (tmp / f"{name}.txt").read_text(encoding="utf-8")
            payload = (tmp / f"{name}.payload").read_bytes()
            scale = QR_SCALE if sym == "qr" else BAR_SCALE
            img = rasterize(text, scale)

            results = zxingcpp.read_barcodes(img)
            checks += 1

            if len(results) != 1:
                failures.append(
                    f"{name}: 应当解出恰好 1 个条码，实际 {len(results)} 个"
                    f"（{int(w)}×{int(h)} 模块，放大 {scale}×）"
                )
                continue

            got = results[0]
            # zxing 给的 bytes 是原始字节，中文/控制字符靠它才不丢
            if got.bytes != payload:
                failures.append(
                    f"{name}: 解出的内容与原文不符\n"
                    f"    期望 {payload!r}\n"
                    f"    实际 {got.bytes!r}\n"
                    f"    （zxing 的文本解读：{got.text!r}）"
                )
                continue

            # zxing 的 format 是给人看的枚举名（"QR Code" / "Code 128"），
            # 归一化成小写字母数字再比，别把空格写成下划线去凑
            fmt = "".join(ch for ch in str(got.format).lower() if ch.isalnum())
            want_fmt = "qrcode" if sym == "qr" else "code128"
            if want_fmt not in fmt:
                failures.append(f"{name}: 码制解成了 {got.format}，应当是 {want_fmt}")
                continue

            print(f"  ✓ {name:<12} {int(w):>3}×{int(h):<3} → {got.format}  {len(payload)} 字节")

        print()
        print(f"· 样本 {checks} 个，失败 {len(failures)} 个")
        if failures:
            print()
            for f in failures:
                print(f"✗ {f}")
            fail(f"{len(failures)} 个样本没通过解码 oracle")

        print(f"✓ 全部 {checks} 个样本都被 zxing 解回原文（码制一致）")
    finally:
        if args.keep:
            print(f"· 保留临时目录：{tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
