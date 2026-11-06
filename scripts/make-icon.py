#!/usr/bin/env python3
"""生成长庚的应用图标。

几何参数与 src/renderer/src/App.tsx 里的 <Logo> 完全相同：
缺口圆环 + 四角星，颜色取自 index.css 的 --ring / --blue / --gold。
这里只是把它放大到图标尺寸、加一块底板，并按小尺寸做光学修正。

用法：python scripts/make-icon.py
产物：build/icon.ico（多尺寸）、build/icon.png（256，窗口图标用）
"""

import math
import struct
import zlib
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'build'

# ---- 品牌色（与 index.css 一致）----
WHITE = (255, 255, 255, 255)
LINE = (232, 232, 228, 255)   # --line  #E8E8E4
RING = (168, 200, 232, 255)   # --ring  #A8C8E8
BLUE = (140, 182, 224, 255)   # --blue  #8CB6E0
GOLD = (216, 184, 122, 255)   # --gold  #D8B87A

# ---- 标记几何（viewBox 24×24，照抄 App.tsx）----
RING_C = (12.0, 12.0)
RING_R = 8.5
RING_W = 1.7
DASH_FROM, DASH_TO = 0.0, 280.8   # pathLength=100、dasharray="78 22" → 0° 顺时针到 280.8°

STAR_BIG = [((12, 6.6), (12.72, 11.28), (17.4, 12)),
            ((17.4, 12), (12.72, 12.72), (12, 17.4)),
            ((12, 17.4), (11.28, 12.72), (6.6, 12)),
            ((6.6, 12), (11.28, 11.28), (12, 6.6))]

STAR_SMALL = [((17.7, 4.5), (17.99, 6.16), (19.65, 6.45)),
              ((19.65, 6.45), (17.99, 6.74), (17.7, 8.4)),
              ((17.7, 8.4), (17.41, 6.74), (15.75, 6.45)),
              ((15.75, 6.45), (17.41, 6.16), (17.7, 4.5))]

SS = 4  # 超采样倍率，画完缩回去做抗锯齿


def quad_points(segments, steps=48):
    """把若干段二次贝塞尔采样成一圈多边形。"""
    pts = []
    for (x0, y0), (cx, cy), (x1, y1) in segments:
        for i in range(steps):
            t = i / steps
            u = 1 - t
            pts.append((u * u * x0 + 2 * u * t * cx + t * t * x1,
                        u * u * y0 + 2 * u * t * cy + t * t * y1))
    return pts


def draw_mark(img, size, mark_ratio, ring_w):
    """在 size×size 的画布上画标记；mark_ratio 是标记占整块的比例。"""
    d = ImageDraw.Draw(img)
    box = size * mark_ratio
    off = (size - box) / 2
    k = box / 24.0

    def tp(x, y):
        return (off + x * k, off + y * k)

    # 圆环：沿弧线密集放圆点，得到圆头端点，比 draw.arc 更可控
    thick = ring_w * k
    cx, cy = tp(*RING_C)
    radius = RING_R * k
    arc_len = math.radians(DASH_TO - DASH_FROM) * radius
    n = max(96, int(arc_len / max(thick * 0.25, 0.5)))
    for i in range(n + 1):
        a = math.radians(DASH_FROM + (DASH_TO - DASH_FROM) * i / n)
        px = cx + radius * math.cos(a)
        py = cy + radius * math.sin(a)
        d.ellipse([px - thick / 2, py - thick / 2, px + thick / 2, py + thick / 2], fill=RING)

    d.polygon([tp(x, y) for x, y in quad_points(STAR_BIG)], fill=BLUE)
    d.polygon([tp(x, y) for x, y in quad_points(STAR_SMALL)], fill=GOLD)


def render(size, small=False):
    """画一块白底圆角方，中间放标记。小尺寸放大标记并加粗圆环，否则会糊掉。"""
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = big * 0.225
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=WHITE)
    # 极淡描边：白底桌面上也能看出边界
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius,
                        outline=LINE, width=max(1, round(big * 0.006)))

    if small:
        draw_mark(img, big, mark_ratio=0.76, ring_w=2.6)
    else:
        draw_mark(img, big, mark_ratio=0.66, ring_w=1.7)

    return img.resize((size, size), Image.LANCZOS)


def png_bytes(img):
    import io
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def write_ico(path, images):
    """手写 ICO：PNG 载荷（Vista 起支持），每档尺寸都是单独渲染的，不是缩放糊的。"""
    blobs = [png_bytes(im) for im in images]
    header = struct.pack('<HHH', 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries, data = b'', b''
    for im, blob in zip(images, blobs):
        w = 0 if im.width >= 256 else im.width
        h = 0 if im.height >= 256 else im.height
        entries += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    path.write_bytes(header + entries + data)


def main():
    BUILD.mkdir(exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [render(s, small=s <= 32) for s in sizes]
    write_ico(BUILD / 'icon.ico', images)
    render(256).save(BUILD / 'icon.png')
    print('build/icon.ico   ', ', '.join(f'{s}px' for s in sizes))
    print('build/icon.png   256px')


if __name__ == '__main__':
    main()
