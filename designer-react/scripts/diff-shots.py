"""diff-shots.py —— 对比两张设计器截图的差异（无图像模型时用数值定位 UI 偏差）

用法：python diff-shots.py a.png b.png [region:x,y,w,h]
输出：整体差异率 + 按 20px 网格列出差异最集中的区块 top10
"""
import sys
from PIL import Image, ImageChops

a_path, b_path = sys.argv[1], sys.argv[2]
region = None
if len(sys.argv) > 3:
    region = tuple(int(v) for v in sys.argv[3].split(':')[1].split(','))

a = Image.open(a_path).convert('RGB')
b = Image.open(b_path).convert('RGB')
if a.size != b.size:
    print('size differ:', a.size, b.size)
    b = b.resize(a.size)
if region:
    x, y, w, h = region
    a = a.crop((x, y, x + w, y + h))
    b = b.crop((x, y, x + w, y + h))

diff = ImageChops.difference(a, b)
bbox = diff.getbbox()
gray = diff.convert('L')
px = list(gray.getdata())
total = len(px)
changed = sum(1 for p in px if p > 12)
print(f'region={region or "full"} size={a.size} bbox={bbox} changed_px={changed} ratio={changed / total:.4%}')

W, H = a.size
G = 20
grid = {}
for gy in range(0, H, G):
    for gx in range(0, W, G):
        box = gray.crop((gx, gy, min(gx + G, W), min(gy + G, H)))
        d = list(box.getdata())
        s = sum(1 for p in d if p > 12)
        if s:
            grid[(gx, gy)] = s
top = sorted(grid.items(), key=lambda kv: -kv[1])[:12]
print('top diff blocks (x,y,changed):')
for (gx, gy), s in top:
    print(f'  {gx},{gy}  {s}')
