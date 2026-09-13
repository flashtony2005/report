#!/usr/bin/env python3
"""
核对「非线性语义画进网格」真的画出来了。

为什么需要这个脚本：Univer 把格子画在 canvas 上，DOM 里读不到任何东西
（页面也没暴露 univerAPI），所以「样式对不对」既不能靠 textContent 断言，
也不该靠人眼看图 —— 直接数像素。

**必须裁到网格区域**：页面下方的语义图例本身就是这几个颜色的色块，
不裁的话图例自己就能让检查通过（第一次就是这么被骗过去的）。

用法：
    python3 scripts/verify-semantic-colors.py <截图.png> [--crop x,y,w,h]

退出码 0 = 预期颜色都在；1 = 有颜色没画出来。
"""
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

# 与 grid-report.ts 的 SEM_BG / PARENT_HIGHLIGHT / SEM_RULE_BD 一一对应
WANT = {
    "#FFF1B8": "纵向扩展底色",
    "#D7F0E3": "横向扩展底色",
    "#FFE8D6": "主格高亮底色",
}


def hexof(px) -> str:
    return "#%02X%02X%02X" % (px[0], px[1], px[2])


def bbox_of(img: Image.Image, color: str):
    """某颜色的像素包围盒；没有返回 None。"""
    w, h = img.size
    px = img.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if hexof(px[x, y]) == color:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    crop = None
    for i, a in enumerate(sys.argv):
        if a == "--crop" and i + 1 < len(sys.argv):
            crop = tuple(int(v) for v in sys.argv[i + 1].split(","))
    if not args:
        print("用法：python3 scripts/verify-semantic-colors.py <截图.png> [--crop x,y,w,h]", file=sys.stderr)
        return 2
    path = Path(args[0])
    if not path.exists():
        print("找不到截图：%s" % path, file=sys.stderr)
        return 2

    img = Image.open(path).convert("RGB")
    if crop:
        img = img.crop((crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]))
    counts = Counter(img.getdata())

    print("截图 %s%s" % (path.name, "  裁剪 %s" % (crop,) if crop else ""))
    missing = []
    for color, label in WANT.items():
        n = counts.get(tuple(int(color[i : i + 2], 16) for i in (1, 3, 5)), 0)
        box = bbox_of(img, color) if n else None
        print(
            "  %-16s %-7s %8d px  %s%s"
            % (label, color, n, "有" if n else "缺失", "  bbox=%s" % (box,) if box else "")
        )
        if not n:
            missing.append(color)
    print()
    if missing:
        print("结果：缺 %d 种颜色 —— %s" % (len(missing), ", ".join(missing)))
        return 1
    print("结果：语义颜色都已画到网格区域")
    return 0


if __name__ == "__main__":
    sys.exit(main())
