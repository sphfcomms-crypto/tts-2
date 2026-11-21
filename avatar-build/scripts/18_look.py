# 18_look.py - quick studio look renders of the head.  blender -b IN.blend --python 18_look.py -- OUTPREFIX [key=val,...] [views]
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
views = (a[2] if len(a) > 2 else 'front,q,side').split(',')
alib.studio(sc, Vector((0, 0, 1.47)))
V = {'front': ((0, -1.15, 1.491), (0, 0, 1.481)), 'q': ((0.62, -0.98, 1.506), (0, -0.02, 1.481)), 'side': ((1.15, -0.05, 1.496), (0, -0.03, 1.481)), 'q2': ((-0.36, -1.10, 1.50), (0, -0.02, 1.481)),
     'low': ((0.25, -1.1, 1.30), (0, 0, 1.47))}
for v in views:
    alib.shoot(sc, a[0] + '_' + v + '.jpg', V[v][0], V[v][1], lens=110, res=(800, 800), samples=80)
print("LOOK done")
