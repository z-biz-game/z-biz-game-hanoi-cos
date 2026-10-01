#!/usr/bin/env python3
"""汉诺塔 HANOI 的美术资产生成器 —— 一条命令重出全套位图，零外部素材、可复现。

    python3 assets/gen/make_art.py [--out assets]

母题：「量出来的塔」。玩法的身份是下界由穷尽 BFS 量出，所以图形语言直接取自盘面本身——
三根（四根）黄铜柱、由黄铜渐变到青玉的盘、柱底那条只在相邻柱之间画出的线柱轨道。
配色不是新编的，逐条抄自仓内已有的实测常量：
  css/game.css  --brass #e0b25f / --teal #6fbf9c / --clay #d1755f / --bg #0f1116 / --bg2 #171a21
  js/view.js    hue() 34→184（最小盘最亮）、post 渐变 #4a4238→#7a6c58→#3b352d、base beam #2a2f3a/#3b4250
所以图标、社交卡与游戏内纹理是同一个东西的三种尺度，不是三张互不相干的画。

产出（全部真 PNG，RGBA 或 RGB，无 0 字节、无 SVG 冒充）：
  icons/icon-1024.png         母图（App Store / 派生源）
  icons/icon-512.png 192 180 152 96 64 48 32 16
  icons/icon-maskable-512.png PWA maskable（内容缩到 80% 安全区）
  icons/apple-touch-icon.png  180，不透明底（iOS 不给 alpha 留透明）
  icons/favicon-32.png 16.png 192.png
  og/hanoi-og-1200x630.png    社交卡（1200×630）
  art/stone-512.png           可平铺石材纹理，画布 base beam / 舞台背景用
  art/glow-256.png            径向发光 sprite，提示高亮与认证解闪动用
  art/grain-128.png           细颗粒叠加（只叠一次，不参与动画，保证帧指纹稳定）

随机性一律走固定种子（内置 LCG，不用 random 的默认种子），所以重跑逐字节可比。
"""
import argparse
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SEED = 20260927

# ---- 实测配色（来源见文件头） ---------------------------------------------------------------
BG = (15, 17, 22)          # --bg
BG2 = (23, 26, 33)         # --bg2
BRASS = (224, 178, 95)     # --brass
TEAL = (111, 191, 156)     # --teal
CLAY = (209, 117, 95)      # --clay
BEAM = (42, 47, 58)        # base beam
BEAM_HI = (59, 66, 80)
POST_DK = (59, 53, 45)
POST_MID = (122, 108, 88)
POST_LO = (74, 66, 56)


def rng(seed=SEED):
    s = [seed & 0xFFFFFFFF]

    def f():
        s[0] = (s[0] * 1103515245 + 12345) & 0x7FFFFFFF
        return s[0] / 0x7FFFFFFF
    return f


def hsl(h, s, l):
    """与 CSS `hsl(h s% l%)` 同义：colorsys 的参数序是 (h, l, s)，且三者都在 0..1。"""
    import colorsys
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l, s)
    return (int(r * 255), int(g * 255), int(b * 255))


def disk_tint(d, n):
    """js/view.js hue()：黄铜(34°)到青玉(184°)，最小的盘最亮。"""
    hue = 34 + (d / max(1, n - 1)) * 150
    return hue


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


def vgrad(size, top, bottom):
    w, h = int(size[0]), int(size[1])
    im = Image.new('RGB', (1, h))
    for y in range(h):
        im.putpixel((0, y), mix(top, bottom, y / max(1, h - 1)))
    return im.resize((w, h))


def rrect(draw, box, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


# ---- 母 emblem：画在 SS×SS 的超采样面上，最后 LANCZOS 缩到目标尺寸 ----------------------------
def emblem(S, scale=1.0, opaque=True):
    """三柱 + 一塔 + 一枚正在搬运的最小盘 + 柱底的线柱轨道。

    构图走一个居中的 content box（宽 box = ss*0.86*scale），所以 maskable 只要把 scale 调到
    0.8 就自然落进安全区，不必重画一遍。
    """
    ss = S * 4
    # 地：从 --bg2 到 --bg 的径向渐变。逐像素在 4096² 上是 1670 万次 Python 循环，
    # 所以只在 96² 的粗网格上算（渐变的带宽在这里已经远高于可分辨频率），再 BICUBIC 放大。
    coarse = 96
    base = Image.new('RGB', (coarse, coarse))
    px = base.load()
    for y in range(coarse):
        for x in range(coarse):
            d = math.hypot(x - coarse * 0.5, y - coarse * 0.2) / (coarse * 0.66)
            px[x, y] = mix(BG2, BG, max(0.0, min(1.0, d)) ** 0.75)
    im = base.resize((ss, ss), Image.BICUBIC).convert('RGBA')

    box = ss * 0.86 * scale
    ox = (ss - box) / 2
    oy = (ss - box) / 2
    pegs, n = 3, 4
    inner = box * 0.055
    usable = box - inner * 2
    slot = usable / pegs
    floor = oy + box * 0.74
    beam_h = box * 0.055
    disk_h = box * 0.118
    max_half = slot * 0.45
    centers = [ox + inner + slot * (p + 0.5) for p in range(pegs)]
    post_w = box * 0.030
    post_top = floor - disk_h * (n + 0.75)

    dr = ImageDraw.Draw(im)

    # 塔底一团暖光：让「塔」这一侧在纯深色底上有重量，不是浮着的剪影
    halo = Image.new('RGBA', im.size, (0, 0, 0, 0))
    h2 = ImageDraw.Draw(halo)
    for i in range(40, 0, -1):
        t = i / 40
        h2.ellipse([centers[0] - box * 0.42 * t, floor - box * 0.30 * t,
                    centers[0] + box * 0.42 * t, floor + box * 0.16 * t],
                   fill=BRASS + (int(26 * (1 - t) ** 2),))
    im = Image.alpha_composite(im, halo.filter(ImageFilter.GaussianBlur(box * 0.05)))
    dr = ImageDraw.Draw(im)

    # base beam（同 view.js 的 #2a2f3a + #3b4250 顶沿）
    rrect(dr, [ox + box * 0.01, floor, ox + box * 0.99, floor + beam_h], beam_h * 0.3, BEAM)
    rrect(dr, [ox + box * 0.01, floor, ox + box * 0.99, floor + beam_h * 0.34], beam_h * 0.17, BEAM_HI)

    # 线柱轨道：段只画在相邻柱之间，正是本仓那个变体的形状
    rail_y = floor + beam_h * 0.52
    for p in range(pegs - 1):
        x0, x1 = centers[p] + post_w * 1.6, centers[p + 1] - post_w * 1.6
        dr.line([x0, rail_y, x1, rail_y], fill=(150, 163, 182), width=max(3, int(box * 0.011)))
        rr = box * 0.014
        for cx in (x0, x1):
            dr.ellipse([cx - rr, rail_y - rr, cx + rr, rail_y + rr], fill=(150, 163, 182))

    # 柱：黄铜三段渐变（view.js post 的 #7a6c58 → #3b352d），顶端收成圆帽
    for cx in centers:
        post = vgrad((post_w, floor - post_top), POST_MID, POST_DK).convert('RGBA')
        im.paste(post, (int(cx - post_w / 2), int(post_top)))
        dr.ellipse([cx - post_w / 2, post_top - post_w / 2, cx + post_w / 2, post_top + post_w / 2],
                   fill=mix(POST_MID, (255, 255, 255), 0.3))
        dr.rectangle([cx - post_w * 0.16, post_top, cx + post_w * 0.16, floor],
                     fill=mix(POST_MID, (255, 255, 255), 0.34))

    def bar(d):
        """宽度线性于直径（game.js diskWidth 的关系），色相走 hue() 34→184。"""
        w = max_half * 2 * (0.40 + 0.60 * (d + 1) / n)
        return w, hsl(disk_tint(d, n), 0.62, 0.62), hsl(disk_tint(d, n), 0.55, 0.38)

    def disk(cx, cy, d):
        w, face, edge = bar(d)
        layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
        c2 = ImageDraw.Draw(layer)
        top, bot = cy - disk_h, cy
        r = disk_h * 0.34
        c2.rounded_rectangle([cx - w / 2, top, cx + w / 2, bot], radius=r, fill=face + (255,))
        # 顶面受光、底沿压暗：读起来是块有厚度的铜，不是一条色带
        c2.rounded_rectangle([cx - w / 2, top, cx + w / 2, top + disk_h * 0.40], radius=r,
                             fill=mix(face, (255, 255, 255), 0.30) + (255,))
        c2.rounded_rectangle([cx - w / 2, bot - disk_h * 0.30, cx + w / 2, bot], radius=r,
                             fill=mix(face, edge, 0.72) + (255,))
        c2.rectangle([cx - w / 2, top + disk_h * 0.40, cx + w / 2, bot - disk_h * 0.30], fill=face + (255,))
        c2.line([cx - w / 2 + r, bot - 1, cx + w / 2 - r, bot - 1], fill=edge + (255,),
                width=max(2, int(disk_h * 0.08)))
        return Image.alpha_composite(im, layer)

    def slot_y(peg, d):
        """盘号 d → 该柱上离地第 d 大层的 y。PIL 的 y 向下，所以最大的盘偏移最小。"""
        return floor - disk_h * 0.42 - (n - 1 - d) * disk_h

    # 最小的一枚正在从甲柱飞向丙柱：认证路线画成一次搬运，落点先亮起来。
    # 光与航线都画在塔之前，所以线是从塔后探出来的，而不是印在盘面上的噪点。
    land_cx, land_cy = centers[2], slot_y(2, 0)
    glow = Image.new('RGBA', im.size, (0, 0, 0, 0))
    g2 = ImageDraw.Draw(glow)
    gr = bar(0)[0] * 1.9
    for i in range(34, 0, -1):
        t = i / 34
        g2.ellipse([land_cx - gr * t, land_cy - gr * 0.62 * t, land_cx + gr * t, land_cy + gr * 0.62 * t],
                   fill=BRASS + (int(60 * (1 - t) ** 2),))
    im = Image.alpha_composite(im, glow.filter(ImageFilter.GaussianBlur(box * 0.022)))
    dr = ImageDraw.Draw(im)

    start_cx, start_cy = centers[0], slot_y(0, 0) - disk_h * 1.15
    for k in range(1, 16):
        t = k / 16
        x = start_cx + (land_cx - start_cx) * t
        y = start_cy + (land_cy - disk_h * 1.15 - start_cy) * t - math.sin(math.pi * t) * box * 0.26
        rr = box * (0.008 + 0.006 * t)
        dr.ellipse([x - rr, y - rr, x + rr, y + rr], fill=mix(BRASS, TEAL, t) + (int(70 + 130 * t),))

    for d in range(n - 1, -1, -1):
        im = disk(centers[0], slot_y(0, d), d)
    im = disk(land_cx, land_cy - disk_h * 1.15, 0)
    dr = ImageDraw.Draw(im)

    out = im.convert('RGB') if opaque else im.convert('RGBA')
    return out.resize((S, S), Image.LANCZOS)


def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, 'PNG', optimize=True)
    print(f'  {os.path.relpath(path)}  {im.width}x{im.height}  {os.path.getsize(path)}B')


# ---- 社交卡：母图 + 标题 + 一行真实数字（与 index.html 的 tag 同一句话） ----------------------
def find_font(px):
    cands = [
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/Library/Fonts/Arial Unicode.ttf',
        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    ]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, px, index=0)
            except Exception:
                continue
    raise SystemExit('找不到中文字体：社交卡不能退化成豆腐块，请装 PingFang 或改 cands')


def social(W=1200, H=630):
    im = Image.new('RGB', (W, H), BG)
    px = im.load()
    maxd = math.hypot(W, H)
    for y in range(H):
        for x in range(W):
            d = math.hypot(x - W * 0.80, y - H * 0.10) / maxd
            px[x, y] = mix(BG2, BG, max(0.0, min(1.0, d)) ** 0.8)
    dr = ImageDraw.Draw(im)

    # 母图：圆角遮罩后再贴，否则方形边界在卡片底上是一道硬边
    EM = 400
    em = emblem(EM).convert('RGBA')
    mask = Image.new('L', (EM, EM), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, EM - 1, EM - 1], radius=EM * 0.16, fill=255)
    im.paste(em, (64, (H - EM) // 2), mask)
    dr = ImageDraw.Draw(im)

    x0 = 64 + EM + 64
    room = W - 56 - x0

    def fit(text, px0):
        """字号从 px0 往下试，直到这一行真的放得进 room —— 社交卡被裁掉半句话是最难看的那种事故。"""
        size = px0
        while size > 14:
            f = find_font(size)
            if dr.textlength(text, font=f) <= room:
                return text, f, size
            size -= 2
        return text, find_font(14), 14

    title, tf, ts = fit('汉诺塔', 92)
    dr.text((x0, 108), title, font=tf, fill=(232, 227, 217))
    latin, lf, _ = fit('H A N O I', 42)
    dr.text((x0, 108 + ts + 26), latin, font=lf, fill=BRASS)
    tag, gf, gs = fit('32 张 LOT · 含 10 张线柱 · 最大图 1,594,323 态穷尽', 30)
    dr.text((x0, 108 + ts + 26 + 62), tag, font=gf, fill=(154, 160, 173))

    # 下界尺：2^n−1 的前 7 个值，柱高线性于值 —— 这张卡卖的就是「量出来的」
    y0 = H - 128
    x1 = W - 70
    dr.line([x0, y0, x1, y0], fill=BEAM_HI, width=2)
    vals = [1, 3, 7, 15, 31, 63, 127]
    cap = x1 - x0 - 24
    for i, v in enumerate(vals):
        x = x0 + cap * i / (len(vals) - 1)
        h = 8 + int(52 * (v / vals[-1]))
        dr.rectangle([x - 6, y0 - h, x + 6, y0], fill=mix(BRASS, TEAL, i / (len(vals) - 1)))
        f = find_font(19)
        label = str(v)
        dr.text((x - dr.textlength(label, font=f) / 2, y0 + 12), label, font=f, fill=(127, 135, 151))
    note, nf, ns = fit('下界 2ⁿ−1：每张 LOT 由穷尽 BFS 量出，再与闭式对账', 27)
    dr.text((x0, y0 - ns - 34), note, font=nf, fill=(232, 227, 217))
    return im


# ---- 游戏内纹理：可平铺石材 + 径向发光 sprite ------------------------------------------------
def stone(S=512):
    """无缝平铺的暗石材：多层 value noise（周期化，所以 tile 边界不断）+ 细颗粒。"""
    grid = 8
    base = rng(SEED + 11)

    def lattice(g):
        pts = [[base() for _ in range(g)] for _ in range(g)]

        def sample(x, y):
            # 周期 g ⇒ 平铺无缝
            gx, gy = x * g, y * g
            x0, y0 = int(gx) % g, int(gy) % g
            x1, y1 = (x0 + 1) % g, (y0 + 1) % g
            fx, fy = gx - int(gx), gy - int(gy)
            sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
            a = pts[y0][x0] * (1 - sx) + pts[y0][x1] * sx
            b = pts[y1][x0] * (1 - sx) + pts[y1][x1] * sx
            return a * (1 - sy) + b * sy
        return sample

    octaves = [(2, 1.0), (4, 0.55), (8, 0.3), (16, 0.16)]
    fields = [(g, a, lattice(g)) for g, a in octaves]
    im = Image.new('RGB', (S, S))
    px = im.load()
    grain = rng(SEED + 12)
    norm = sum(a for _, a, _ in fields)
    for y in range(S):
        for x in range(S):
            v = sum(f(x / S, y / S) * a for _, a, f in fields) / norm
            # 石材是冷的：亮度在 --bg 与 --line 之间走，再压一层横向条纹（读作木纹/沉积）
            band = 0.5 + 0.5 * math.sin((y / S) * math.pi * 2 * 9 + v * 3.2)
            c = mix((18, 20, 26), (46, 52, 64), 0.55 * v + 0.25 * band)
            g2 = int((grain() - 0.5) * 10)
            px[x, y] = tuple(max(0, min(255, ch + g2)) for ch in c)
    return im


def glow(S=256):
    """径向发光 sprite：提示高亮与认证解闪动用，中心不透、边缘全透明。"""
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    px = im.load()
    c = S / 2
    for y in range(S):
        for x in range(S):
            d = math.hypot(x - c, y - c) / c
            a = max(0.0, 1.0 - d) ** 2.4
            col = mix(BRASS, (255, 246, 214), 1.0 - d)
            px[x, y] = (col[0], col[1], col[2], int(255 * a))
    return im


def grain(S=128):
    """极细颗粒（无缝）：叠在舞台背景上一遍，给纯程序化的渐变一点物质感。"""
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    px = im.load()
    r = rng(SEED + 21)
    for y in range(S):
        for x in range(S):
            v = r()
            a = int(26 * v * v)
            px[x, y] = (232, 227, 217, a)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = ap.parse_args()
    root = args.out
    print(f'-> {root}')

    master = emblem(1024)
    save(master, os.path.join(root, 'icons', 'icon-1024.png'))
    for s in (512, 192, 180, 152, 96, 64, 48, 32, 16):
        save(master.resize((s, s), Image.LANCZOS), os.path.join(root, 'icons', f'icon-{s}.png'))
    # maskable：内容缩到 80% 安全区，四周留满底
    save(emblem(512, scale=0.8), os.path.join(root, 'icons', 'icon-maskable-512.png'))
    # apple-touch：iOS 不接受透明，emblem(opaque=True) 已经是 RGB
    save(emblem(180), os.path.join(root, 'icons', 'apple-touch-icon.png'))
    save(master.resize((192, 192), Image.LANCZOS), os.path.join(root, 'icons', 'favicon-192.png'))
    save(master.resize((32, 32), Image.LANCZOS), os.path.join(root, 'icons', 'favicon-32.png'))
    save(master.resize((16, 16), Image.LANCZOS), os.path.join(root, 'icons', 'favicon-16.png'))
    save(social(), os.path.join(root, 'og', 'hanoi-og-1200x630.png'))
    save(stone(512), os.path.join(root, 'art', 'stone-512.png'))
    save(glow(256), os.path.join(root, 'art', 'glow-256.png'))
    save(grain(128), os.path.join(root, 'art', 'grain-128.png'))
    print('OK')


if __name__ == '__main__':
    main()
