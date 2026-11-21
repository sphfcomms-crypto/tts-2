# t_render.py - quick look renders.  blender -b X.blend --python t_render.py -- prefix shots(comma) [key=val ...]
import bpy, sys
from mathutils import Vector
sys.path.insert(0, '/project/build/scripts')
import rlib
argv = sys.argv[sys.argv.index('--') + 1:]
prefix = argv[0]; shots = argv[1].split(',')
keys = dict(a.split('=') for a in argv[2:])
sc = bpy.context.scene
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        for k, v in keys.items():
            kb = o.data.shape_keys.key_blocks.get(k)
            if kb: kb.value = float(v)
eyes = bpy.data.objects['Eyes']
ws = [eyes.matrix_world @ v.co for v in eyes.data.vertices]
ec = sum(ws, Vector()) / len(ws)
print("EYE CENTER", ec)
rlib.setup_cycles(sc, (900, 900), 64)
rlib.setup_studio(sc, center=Vector((0, 0, ec.z - 0.1)))
R = '/project/build/renders/'
for s in shots:
    if s == 'face':
        rlib.shoot(sc, R + prefix + '_face.jpg', (0, -0.85, ec.z - 0.02), (0, 0, ec.z - 0.035), lens=110, res=(900, 900))
    if s == 'face34':
        rlib.shoot(sc, R + prefix + '_face34.jpg', (0.5, -0.7, ec.z), (0, 0, ec.z - 0.035), lens=110, res=(900, 900))
    if s == 'side':
        rlib.shoot(sc, R + prefix + '_side.jpg', (0.9, 0.0, ec.z), (0, 0, ec.z - 0.035), lens=110, res=(900, 900))
    if s == 'waist':
        rlib.shoot(sc, R + prefix + '_waist.jpg', (0, -2.2, ec.z - 0.22), (0, 0, ec.z - 0.27), lens=70, res=(900, 1100))
    if s == 'full':
        rlib.shoot(sc, R + prefix + '_full.jpg', (0, -4.6, 0.85), (0, 0, 0.8), lens=70, res=(700, 1200))
    if s == 'full34':
        rlib.shoot(sc, R + prefix + '_full34.jpg', (2.6, -3.8, 0.9), (0, 0, 0.8), lens=70, res=(700, 1200))
    if s == 'back':
        rlib.shoot(sc, R + prefix + '_back.jpg', (0, 4.6, 0.85), (0, 0, 0.8), lens=70, res=(700, 1200))
    if s == 'fullside':
        rlib.shoot(sc, R + prefix + '_fullside.jpg', (4.6, 0, 0.85), (0, 0, 0.8), lens=70, res=(700, 1200))
