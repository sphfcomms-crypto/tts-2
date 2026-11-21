# pv.py - preview renders of the whole figure.  blender -b IN.blend --python pv.py -- OUTPREFIX [views] [res]
import bpy, sys
from mathutils import Vector
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); sc = bpy.context.scene
alib.studio(sc, Vector((0, 0, 1.0)))
for o in bpy.data.objects:
    if o.type == 'MESH' and not o.data.materials:
        m = bpy.data.materials.get('PV') or bpy.data.materials.new('PV'); m.use_nodes = True
        m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.13, 0.25, 0.24, 1); m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
        o.data.materials.append(m)
V = {'front': ((0, -4.6, 0.95), (0, 0, 0.82), 85, (560, 1000)), 'q': ((2.6, -3.8, 1.0), (0, 0, 0.82), 85, (560, 1000)), 'back': ((0, 4.6, 0.95), (0, 0, 0.82), 85, (560, 1000)),
     'side': ((4.6, 0, 0.95), (0, 0, 0.82), 85, (560, 1000)), 'waist': ((0, -2.3, 1.30), (0, 0, 1.25), 70, (760, 1000)), 'waistq': ((1.3, -1.9, 1.32), (0, 0, 1.25), 70, (760, 1000)),
     'face': ((0, -1.15, 1.485), (0, 0, 1.475), 110, (800, 800))}
for v in (a[1] if len(a) > 1 else 'front,q,back,waist').split(','):
    pos, tg, lens, res = V[v]
    alib.shoot(sc, a[0] + '_' + v + '.jpg', pos, tg, lens=lens, res=res, samples=48)
print("PV done")
