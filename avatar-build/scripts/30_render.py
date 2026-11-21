# 30_render.py - Cycles (GPU) beauty renders.   blender -b final.blend --python 30_render.py -- OUTDIR [set] [prefix]
#   set: all | body | face | expr | quick
import bpy, sys
from mathutils import Vector
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); sc = bpy.context.scene; out = a[0]; which = a[1] if len(a) > 1 else 'all'; pre = a[2] if len(a) > 2 else ''
head = bpy.data.objects['Armature'].data.bones['Head'].head_local; hz = head.z
def keys(d):
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.data.shape_keys:
            for kb in o.data.shape_keys.key_blocks:
                if kb.name != 'Basis': kb.value = float(d.get(kb.name, 0.0))
def lights(center):
    alib.studio(sc, Vector(center), bgcol=(0.50, 0.50, 0.52))
    for l in bpy.data.lights: l.size = min(l.size, 1.4)
FACE = ((0.0, -1.30, hz + 0.085), (0, -0.03, hz + 0.075), 115, (1024, 1024))
SHOTS = {'face': FACE,
         'waist-up': ((0.0, -2.45, hz - 0.10), (0, 0, hz - 0.17), 70, (1000, 1250)),
         'full-front': ((0, -4.9, 0.95), (0, 0, 0.82), 85, (800, 1400)),
         'three-quarter': ((2.7, -4.0, 1.0), (0, 0, 0.82), 85, (800, 1400)),
         'back': ((0, 4.9, 0.95), (0, 0, 0.82), 85, (800, 1400))}
EXPR = {'jawOpen': {'jawOpen': 1}, 'smile': {'mouthSmileLeft': 1, 'mouthSmileRight': 1}, 'blink': {'eyeBlinkLeft': 1, 'eyeBlinkRight': 1},
        'mouthFunnel': {'mouthFunnel': 1}, 'viseme_aa': {'viseme_aa': 1}}
S = 128 if which != 'quick' else 48
if which in ('all', 'body', 'quick'):
    keys({}); lights((0, 0, 1.0))
    for n in ('full-front', 'three-quarter', 'back'):
        pos, tg, lens, res = SHOTS[n]
        if which == 'quick': res = (res[0] // 2, res[1] // 2)
        alib.shoot(sc, out + '/' + pre + n + '.jpg', pos, tg, lens=lens, res=res, samples=S)
if which in ('all', 'face', 'quick'):
    keys({}); lights((0, 0, hz + 0.02))
    for n in ('waist-up', 'face'):
        pos, tg, lens, res = SHOTS[n]
        if which == 'quick': res = (int(res[0] * 0.7), int(res[1] * 0.7))
        alib.shoot(sc, out + '/' + pre + n + '.jpg', pos, tg, lens=lens, res=res, samples=S)
if which in ('all', 'expr'):
    lights((0, 0, hz + 0.02))
    for n, d in EXPR.items():
        keys(d); pos, tg, lens, res = FACE
        alib.shoot(sc, out + '/' + pre + 'face-' + n + '.jpg', pos, tg, lens=lens, res=(768, 768), samples=S)
    keys({})
if which == 'check':        # the two shots used to compare the re-imported GLB with the source scene
    lights((0, 0, hz + 0.02)); keys({})
    pos, tg, lens, res = SHOTS['waist-up']; alib.shoot(sc, out + '/' + pre + 'waist-up.jpg', pos, tg, lens=lens, res=res, samples=S)
    keys(EXPR['jawOpen']); pos, tg, lens, res = FACE; alib.shoot(sc, out + '/' + pre + 'face-jawOpen.jpg', pos, tg, lens=lens, res=(768, 768), samples=S)
print("RENDER done", which)
