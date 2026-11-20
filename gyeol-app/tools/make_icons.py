"""앱 아이콘 · 로고 생성: MDF 타일(../../arrow_tile_mdf.py) 하나.
갈색 면 + 흰 윤곽 홈만 있는 화살표(위를 가리킴) + 오른쪽 위 끈 구멍. 그림자·그라데이션 없음.
화살표 좌표는 웹 앱과 같은 apps/web/src/components/tileArt.ts 를 읽는다.

실행: python tools/make_icons.py
"""
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'apps/web/public'

FACE_HEX, SIDE_HEX, LINE_HEX, BG_HEX = '#9c6b43', '#4a2e1b', '#f3f1ec', '#1c1b1a'


def _rgba(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


FACE, SIDE, LINE, BG = map(_rgba, (FACE_HEX, SIDE_HEX, LINE_HEX, BG_HEX))

_ART = (ROOT / 'apps/web/src/components/tileArt.ts').read_text(encoding='utf-8')


def _pts(name):
    d = re.search(name + r"\s*=\s*'([^']+)'", _ART).group(1)
    pts = [(float(x), float(y)) for x, y in re.findall(r'([\d.]+) ([\d.]+)', d)]
    return [(y, 100 - x) for x, y in pts]  # 원본은 오른쪽을 가리킴 → 위로 돌린다


ARROW_OUTER = _pts('ARROW_OUTER')
ARROW_INNER = _pts('ARROW_INNER')
_hole = re.search(r'HOLE = \{ cx: ([\d.]+), cy: ([\d.]+), r: ([\d.]+) \}', _ART)
HOLE_X, HOLE_Y, HOLE_R = (float(v) for v in _hole.groups())
HOLE_X, HOLE_Y = HOLE_Y, 100 - HOLE_X  # 화살표와 같이 위로 돌림 → 오른쪽 위


def draw_arrow(d, off, k):
    """윤곽 홈: 바깥 윤곽을 선 색으로 채우고 안쪽을 다시 면 색으로."""
    d.polygon([(off + x * k, off + y * k) for x, y in ARROW_OUTER], fill=LINE)
    d.polygon([(off + x * k, off + y * k) for x, y in ARROW_INNER], fill=FACE)


def draw_hole(d, off, k, fill=(0, 0, 0, 0)):
    x, y, r = off + HOLE_X * k, off + HOLE_Y * k, HOLE_R * k
    d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def icon(size, *, rounded, arrow_scale, hole=None):
    s = size * 4  # 안티에일리어싱용 확대
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.18), fill=FACE)
    else:
        d.rectangle([0, 0, s, s], fill=FACE)
    k = s * arrow_scale / 100
    draw_arrow(d, (s - 100 * k) / 2, k)
    if hole is not None:
        draw_hole(d, 0, s / 100, hole)
    return img.resize((size, size), Image.LANCZOS)


def _d(pts):
    return 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + ' Z'


def _hole_d():
    x, y, r = HOLE_X, HOLE_Y, HOLE_R
    return f'M{x - r:.2f} {y:.2f} a{r} {r} 0 1 0 {2 * r} 0 a{r} {r} 0 1 0 {-2 * r} 0 Z'


def rrect_d(r):
    """100×100 둥근 사각형 경로."""
    q = 100 - r
    return (f'M{r} 0 H{q} A{r} {r} 0 0 1 100 {r} V{q} A{r} {r} 0 0 1 {q} 100 '
            f'H{r} A{r} {r} 0 0 1 0 {q} V{r} A{r} {r} 0 0 1 {r} 0 Z')


# 앞면: 둥근 사각형에서 끈 구멍을 뺀 것 (evenodd) · 윤곽 홈: 바깥 − 안쪽 (evenodd)
SIDE_D = rrect_d(10)
FACE_D = SIDE_D + ' ' + _hole_d()
GROOVE_D = _d(ARROW_OUTER) + ' ' + _d(ARROW_INNER)


def tile_svg(view_box, place, layers=12):
    """옆면 겹(아래로 1씩) + 앞면 + 흰 윤곽. place: 타일 100×100 을 놓는 transform."""
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" fill="none">']
    for dy in range(layers, 0, -1):
        out.append(f'<g transform="translate(0 {dy})"><g transform="{place}"><path d="{SIDE_D}" fill="{SIDE_HEX}"/></g></g>')
    out.append(f'<g transform="{place}">'
               f'<path d="{FACE_D}" fill="{FACE_HEX}" fill-rule="evenodd"/>'
               f'<path d="{GROOVE_D}" fill="{LINE_HEX}" fill-rule="evenodd"/></g>')
    out.append('</svg>\n')
    return '\n'.join(out)


def main():
    icon(192, rounded=True, arrow_scale=1.0, hole=(0, 0, 0, 0)).save(OUT / 'icon-192.png')
    icon(512, rounded=True, arrow_scale=1.0, hole=(0, 0, 0, 0)).save(OUT / 'icon-512.png')
    icon(512, rounded=False, arrow_scale=0.78).save(OUT / 'icon-maskable-512.png')
    icon(180, rounded=False, arrow_scale=0.92).convert('RGB').save(OUT / 'apple-touch-icon.png')
    (OUT / 'icon.svg').write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f'<path d="{rrect_d(18)} {_hole_d()}" fill="{FACE_HEX}" fill-rule="evenodd"/>'
        f'<path d="{GROOVE_D}" fill="{LINE_HEX}" fill-rule="evenodd"/></svg>\n',
        encoding='utf-8',
    )
    tiles = OUT / 'tiles'
    # 정면 로고 (로비 · 레일): 위에서 본 타일 + 아래 두께
    (tiles / 'front.svg').write_text(tile_svg('-4 -4 108 120', 'translate(0 0)'), encoding='utf-8')
    # 비스듬한 로고 (온보딩 · 결과): 인쇄물처럼 기울여 놓은 타일
    (tiles / 'hero.svg').write_text(
        tile_svg('0 0 160 160', 'matrix(0.970296 0.190639 -0.241922 0.764599 43.5813 26.2381)'), encoding='utf-8')
    print('icons ->', OUT)


# ---------- 안드로이드 (Capacitor) ----------
RES = ROOT / 'apps/web/android/app/src/main/res'
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def foreground(size):
    """적응형 아이콘 전경: 투명 배경 + 흰 윤곽 화살표 (안전 영역 66% 안). 배경은 갈색 면."""
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = s * 0.6 / 100
    off = (s - 100 * k) / 2
    d.polygon([(off + x * k, off + y * k) for x, y in ARROW_OUTER], fill=LINE)
    d.polygon([(off + x * k, off + y * k) for x, y in ARROW_INNER], fill=(0, 0, 0, 0))
    return img.resize((size, size), Image.LANCZOS)


def splash(w, h):
    """인쇄물처럼 숯색 바탕 가운데 타일 하나 (구멍으로 바탕이 보인다)."""
    img = Image.new('RGB', (w * 2, h * 2), BG[:3])
    tile = icon(int(min(w, h) * 0.22) * 2, rounded=True, arrow_scale=1.0, hole=(0, 0, 0, 0))
    img.paste(tile, ((w * 2 - tile.width) // 2, (h * 2 - tile.height) // 2), tile)
    return img.resize((w, h), Image.LANCZOS)


def android():
    if not RES.exists():
        return
    for name, k in DENSITIES.items():
        folder = RES / f'mipmap-{name}'
        icon(round(48 * k), rounded=True, arrow_scale=1.0).save(folder / 'ic_launcher.png')
        circle = icon(round(48 * k), rounded=False, arrow_scale=0.82)
        mask = Image.new('L', circle.size, 0)
        ImageDraw.Draw(mask).ellipse([0, 0, circle.width - 1, circle.height - 1], fill=255)
        circle.putalpha(mask)
        circle.save(folder / 'ic_launcher_round.png')
        foreground(round(108 * k)).save(folder / 'ic_launcher_foreground.png')
    (RES / 'values/ic_launcher_background.xml').write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">'
        f'{FACE_HEX.upper()}</color>\n</resources>\n',
        encoding='utf-8')
    for path in RES.glob('drawable*/splash.png'):
        w, h = Image.open(path).size
        splash(w, h).save(path)
    print('android icons/splash ->', RES)


if __name__ == '__main__':
    main()
    android()
