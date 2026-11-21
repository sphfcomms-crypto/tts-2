# 21_close.py - close-up checks: flat ortho (for registration against the photo) and studio close-ups of eyes and mouth.
#   blender -b IN.blend --python 21_close.py -- OUTPREFIX [key=val,...]
import bpy, sys
from mathutils import Vector
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); sc = bpy.context.scene
keys = dict(kv.split('=') for kv in a[1].split(',')) if len(a) > 1 and a[1] not in ('', '-') else {}
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        for k, v in keys.items():
            kb = o.data.shape_keys.key_blocks.get(k)
            if kb: kb.value = float(v)
alib.studio(sc, Vector((0, 0, 1.47)))
for l in bpy.data.lights: l.size = min(l.size, 1.0)
alib.shoot(sc, a[0] + '_eyes.jpg', (0, -0.9, 1.49), (0, 0, 1.487), lens=200, res=(1400, 560), samples=96)
alib.shoot(sc, a[0] + '_mouth.jpg', (0.12, -0.9, 1.43), (0, 0, 1.43), lens=200, res=(1000, 700), samples=96)
alib.ortho_front(sc, a[0] + '_ortho.png', res=1024)
