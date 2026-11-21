# 13_warp.py - apply the 2D landmark displacement field (front view, x/z) to the head: body + every shape key, lashes, brows,
# teeth, tongue per vertex; each eyeball rigidly.   blender -b IN.blend --python 13_warp.py -- PREFIX OUT.blend [final]
import bpy, sys, json, numpy as np
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); F = np.load(a[0] + '_field.npy'); info = json.load(open(a[0] + '_info.json')); res = F.shape[0]
def sample(x, z):
    px = (x - alib.OCX) / alib.OSIZE * res + res / 2 - 0.5; py = res / 2 - (z - alib.OCZ) / alib.OSIZE * res - 0.5
    px = np.clip(px, 0, res - 1.001); py = np.clip(py, 0, res - 1.001)
    x0 = np.floor(px).astype(int); y0 = np.floor(py).astype(int); fx = (px - x0)[:, None]; fy = (py - y0)[:, None]
    d = F[y0, x0] * (1 - fx) * (1 - fy) + F[y0, x0 + 1] * fx * (1 - fy) + F[y0 + 1, x0] * (1 - fx) * fy + F[y0 + 1, x0 + 1] * fx * fy
    k = alib.OSIZE / res
    return np.c_[d[:, 0] * k, np.zeros(len(x)), -d[:, 1] * k]
def sstep(v, a, b):
    t = np.clip((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
for name in ('Body', 'Eyelashes', 'Eyebrows', 'Teeth', 'Tongue'):
    o = bpy.data.objects.get(name)
    if not o: continue
    me = o.data; p = alib.co(me.vertices, len(me.vertices))
    d = sample(p[:, 0], p[:, 2]) * sstep(p[:, 1], 0.07, -0.02)[:, None] * sstep(p[:, 2], 1.30, 1.34)[:, None]
    alib.add_delta(me, d)
    print("WARP", name, "max mm", float(np.abs(d).max() * 1000))
e = bpy.data.objects['Eyes']; me = e.data; p = alib.co(me.vertices, len(me.vertices)); d = np.zeros_like(p)
for sgn in (-1, 1):
    m = (p[:, 0] * sgn) > 0; c = p[m].mean(0)
    dd = sample(np.array([c[0]]), np.array([c[2]]))[0]; d[m] = dd
    print("EYE", sgn, "centre", c.round(4), "shift mm", (dd * 1000).round(2))
alib.add_delta(me, d)
if len(a) > 2 and a[2] == 'final':
    pass
alib.save(a[1])
