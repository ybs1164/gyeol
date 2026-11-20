"""타일 3D 모델(../../arrow_tile.py)을 단색 면으로 렌더링한다. 빛·그라데이션 없음.

Workbench 엔진 + Flat 조명이라 면마다 재질 색 하나만 나온다.
blender --background --python tools/render_tile_flat.py -- <출력 폴더>
"""
import math
import os
import sys

import bpy

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)
import arrow_tile as tile  # noqa: E402

# 앱 팔레트 (sRGB)
SIDE = 'D9C8A6'    # 나무 옆면
ARROW = 'F3ECDD'   # 화살표 바닥
SKINS = {
    'green': ('3F8F47', '2D6B34'),
    'brown': ('A8532F', '7A3A20'),
}


def build(face, line):
    tile.reset_scene()
    tile.COLORS.clear()
    tile.COLORS.update({
        'natural': (SIDE, SIDE),
        'front': (face, face),
        'front_line': (line, line),
        # 뒷면은 보이지 않지만 아래 모서리 둥글림이 비치므로 옆면 색으로
        'back': (SIDE, SIDE),
        'back_line': (SIDE, SIDE),
        'arrow': (ARROW, ARROW),
    })
    obj = tile.build_tile()
    tile.carve(obj)
    tile.assign_materials(obj)
    for m in obj.data.materials:
        key = m.name.removeprefix('Wood_')
        m.diffuse_color = (*tile.srgb(tile.COLORS[key][0]), 1)
    return obj


def setup(obj, tilt_deg, spin_deg, size_px):
    s = bpy.context.scene
    s.render.engine = 'BLENDER_WORKBENCH'
    s.display.shading.light = 'FLAT'
    s.display.shading.color_type = 'MATERIAL'
    s.display.shading.show_cavity = False
    s.display.shading.show_object_outline = False
    s.display.shading.show_specular_highlight = False
    s.display.shading.show_shadows = False
    s.display_settings.display_device = 'sRGB'
    s.view_settings.view_transform = 'Standard'
    s.view_settings.look = 'None'
    s.render.film_transparent = True
    s.render.resolution_x = s.render.resolution_y = size_px
    s.render.image_settings.color_mode = 'RGBA'
    s.render.filter_size = 0.75

    obj.rotation_euler = (0, 0, math.radians(spin_deg))
    t = math.radians(tilt_deg)
    d = 0.2
    bpy.ops.object.camera_add(location=(0, -d * math.sin(t), d * math.cos(t)))
    cam = bpy.context.active_object
    cam.rotation_euler = (t, 0, 0)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = tile.W * 1.45
    s.camera = cam


def main():
    out = sys.argv[sys.argv.index('--') + 1]
    os.makedirs(out, exist_ok=True)
    views = {
        'hero': (38, -14, 1024),   # 스플래시 · 시작 화면: 살짝 비스듬히
        'front': (30, 0, 512),     # 아이콘 · 작은 마크: 정면
    }
    for name, (face, line) in SKINS.items():
        for view, (tilt, spin, px) in views.items():
            obj = build(face, line)
            setup(obj, tilt, spin, px)
            bpy.context.scene.render.filepath = os.path.join(out, f'tile_{name}_{view}.png')
            bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    main()
