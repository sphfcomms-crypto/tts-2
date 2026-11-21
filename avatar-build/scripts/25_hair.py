# 25_hair.py - long straight black hair as alpha cards: centre parting, combed over the scalp, tucked behind the ears,
# falling behind the shoulders and resting on the back (ray cast against body, kameez and dupatta).
# A base layer of wide opaque cards closes the volume; narrower wispy cards on top break the silhouette.
#   blender -b wardrobe.blend --python 25_hair.py -- OUT.blend
import bpy, bmesh, sys, json, math, random, numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
sys.path.insert(0, '/project/w/s'); import alib, glib
a = alib.args(); sc = bpy.context.scene
rig = bpy.data.objects['Armature']; B = bpy.data.objects['Body']; bn = rig.data.bones; BONES = [b.name for b in bn]
dg = bpy.context.evaluated_depsgraph_get(); tB = BVHTree.FromObject(B, dg)
tO = [BVHTree.FromObject(bpy.data.objects[n], dg) for n in ('Kameez', 'Dupatta') if n in bpy.data.objects] + [tB]
nb = len(B.data.vertices); p = alib.co(B.data.vertices, nb); W = glib.weights(B)
sv = p[W['scalp'] > 0.5]
Cs = Vector((0.0, float((sv[:, 1].min() + sv[:, 1].max()) / 2), float(sv[:, 2].max() - 0.098)))
print("SCALP bbox", sv.min(0).round(3), sv.max(0).round(3), "centre", tuple(round(x, 3) for x in Cs))
def scalp(th, ph, s):
    d = Vector((s * math.sin(ph) * math.sin(th), -math.sin(ph) * math.cos(th), math.cos(ph)))
    hit = tB.ray_cast(Cs + d * 0.26, -d, 0.26)[0]
    return (hit if hit is not None else Cs + d * 0.095), d
def back_y(x, z):
    best = None
    for t in tO:
        h = t.ray_cast(Vector((x, 0.6, z)), Vector((0, -1, 0)), 1.2)[0]
        if h is not None and (best is None or h.y > best): best = h.y
    return best
def phimax(th): return math.radians(float(np.interp(th / math.pi, [0, 0.3, 0.5, 0.62, 1.0], [47, 67, 85, 106, 117])))
def sstep(v, a_, b_):
    t = min(max((v - a_) / (b_ - a_), 0), 1); return t * t * (3 - 2 * t)
rng = random.Random(4); NU, NV = 15, 16
V = []; F = []; UV = []; VN = []
def strand(s, th0, frac, wide):
    ph0 = math.radians(13) + (phimax(th0) - math.radians(13)) * frac        # roots start beside the parting, not on the vertex
    thL = math.pi * (0.645 + 0.355 * (th0 / math.pi) ** 0.9); phL = phimax(thL) + math.radians(5)
    off = 0.0012 + (0.0045 * (1 - frac) + rng.uniform(0, 0.0012)) * (0.5 if wide else 1.0) + (0 if wide else 0.0022)
    pts = []; nrm = []
    for i in range(NU):
        u = i / (NU - 1); th = th0 + (thL - th0) * (1 - (1 - u) ** 3); ph = ph0 + (phL - ph0) * u
        h, d = scalp(th, ph, s); lift = 0.0025 * math.sin(math.pi * min(u / 0.92, 1)) * (0.5 if wide else 1.0)
        pts.append(h + d * (off * (0.12 + 0.88 * sstep(u, 0, 0.2)) + lift)); nrm.append(d)        # roots start on the scalp itself
    L = pts[-1]; T0 = (pts[-1] - pts[-2]).normalized()
    xr = (thL / math.pi - 0.645) / 0.355
    xe = s * (0.128 - 0.112 * xr) + rng.uniform(-0.008, 0.008)
    ze = (1.00 + 0.07 * rng.random() - 0.03 * (1 - frac)) if not wide else 1.01 + 0.04 * rng.random()
    ob = 0.005 + (0.014 * (1 - frac) + rng.uniform(0, 0.004)) * (0.4 if wide else 1.0)
    by = back_y(xe, ze); E = Vector((xe, (by if by is not None else 0.1) + ob, ze))
    P1 = L + T0 * 0.07; P2 = E + Vector((0, 0.0, 0.26))
    for j in range(1, NV + 1):
        v = j / NV; q = L * (1 - v) ** 3 + P1 * 3 * (1 - v) ** 2 * v + P2 * 3 * (1 - v) * v * v + E * v ** 3
        by = back_y(q.x, q.z)
        if by is not None and q.z < L.z - 0.01: q.y = max(q.y, by + ob)
        pts.append(q); nrm.append(Vector((s * (1 - xr) * 0.9, 1.0, 0.0)).normalized())
    for _ in range(2):
        q2 = [pts[0]] + [(pts[i - 1] + pts[i] * 2 + pts[i + 1]) / 4 if i >= NU else pts[i] for i in range(1, len(pts) - 1)] + [pts[-1]]; pts = q2
    n_ = len(pts); seg = [(pts[i + 1] - pts[i]).length for i in range(n_ - 1)]; tot = sum(seg); acc = 0.0
    w0 = rng.uniform(0.036, 0.048) if wide else rng.uniform(0.014, 0.026)
    col = 0 if wide else rng.choice((1, 2, 3)); flip = rng.random() < 0.5; base = len(V)
    for i in range(n_):
        f = acc / tot
        T = (pts[min(i + 1, n_ - 1)] - pts[max(i - 1, 0)]).normalized(); sd = T.cross(nrm[i])
        if sd.length < 1e-6: sd = Vector((1, 0, 0))
        sd.normalize(); w = w0 * (0.4 + 0.6 * sstep(f, 0, 0.12)) * (1 - 0.4 * sstep(f, 0.78, 1.0))
        w *= (0.5 + 0.5 * sstep(i, NU - 4, NU + 4)) if wide else (0.8 + 0.2 * sstep(i, NU - 4, NU + 4))      # narrower on the curved scalp
        V.append(pts[i] - sd * w / 2); V.append(pts[i] + sd * w / 2)
        nn = (nrm[i] * 0.85 + T.cross(sd).normalized() * (0.15 if T.cross(sd).dot(nrm[i]) > 0 else -0.15)).normalized(); VN.append(nn); VN.append(nn)
        u0, u1 = (col + 0.02) / 4, (col + 0.98) / 4
        if flip: u0, u1 = u1, u0
        UV.append(((u0, 1 - f), (u1, 1 - f)))
        if i < n_ - 1: acc += seg[i]
    for i in range(n_ - 1):
        q = base + 2 * i; F.append((q, q + 1, q + 3, q + 2))
NA, NAB = 34, 24
for s in (1, -1):
    for i in range(NAB):
        for frac in (0.12, 0.55):
            strand(s, math.pi * (0.012 + 0.976 * (i + rng.random()) / NAB), min(0.98, frac + rng.uniform(-0.08, 0.2)), True)
    for i in range(NA):
        for frac in (0.06, 0.3, 0.55, 0.8):
            strand(s, math.pi * (0.012 + 0.976 * (i + rng.random()) / NA), min(0.97, max(0.02, frac + rng.uniform(-0.1, 0.1))), False)
me = bpy.data.meshes.new('Hair'); me.from_pydata([tuple(v) for v in V], [], F); me.update()
uvl = me.uv_layers.new(name='UVMap')
for f in me.polygons:
    for li, vi in zip(f.loop_indices, f.vertices):
        uvl.data[li].uv = UV[vi // 2][vi % 2]
glib.smooth_shade(me)
try:
    me.normals_split_custom_set_from_vertices([tuple(v) for v in VN]); print('HAIR custom normals set')        # shade the cards like one smooth volume
except Exception as e: print('custom normals failed', e)
H = glib.new_obj('Hair', me, rig)
glib.transfer_weights(H, B, BONES, k=3)
hg = H.vertex_groups['Head']
for v in me.vertices:
    wh = sstep(v.co.z, 1.33, 1.41)
    if wh > 0:
        for g in v.groups:
            if g.group != hg.index: g.weight *= (1 - wh)
        cur = 0.0
        for g in v.groups:
            if g.group == hg.index: cur = g.weight
        hg.add([v.index], wh + (1 - wh) * cur, 'REPLACE')
print("HAIR strands", len(F) // (NU + NV - 1), "tris", len(F) * 2, "z range", round(min(v.z for v in V), 3), round(max(v.z for v in V), 3))
alib.save(a[0])
