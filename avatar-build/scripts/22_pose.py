# 22_pose.py - rename bones (no "mixamorig:" prefix), thin/shorten the lashes, put her in the relaxed default pose
# (arms down, slight elbow bend, soft finger curl, feet closer), bake that pose into the meshes and make it the rest pose.
#   blender -b skin2.blend --python 22_pose.py -- EYE.png OUT.blend
import bpy, sys, json, math, random, numpy as np
from mathutils import Vector, Matrix
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); sc = bpy.context.scene
rig = bpy.data.objects['Armature']; B = bpy.data.objects['Body']
for b in rig.data.bones: b.name = b.name.replace('mixamorig:', '')
m = bpy.data.objects['Eyes'].data.materials[0]; nt = m.node_tree
t = [n for n in nt.nodes if n.type == 'TEX_IMAGE'][0]; t.image = bpy.data.images.load(a[0])
# ---- lashes: keep 55% of the upper and 30% of the lower lashes, shorten each towards its root (all shape keys)
L = bpy.data.objects['Eyelashes']; me = L.data; n = len(me.vertices)
par = list(range(n))
def find(i):
    while par[i] != i:
        par[i] = par[par[i]]; i = par[i]
    return i
for e in me.edges:
    x, y = find(e.vertices[0]), find(e.vertices[1])
    if x != y: par[x] = y
root = np.array([find(i) for i in range(n)]); p = alib.co(me.vertices, n)
E = bpy.data.objects['Eyes']; pe = alib.co(E.data.vertices, len(E.data.vertices))
cen = {s: pe[(pe[:, 0] * s) > 0].mean(0) for s in (-1, 1)}
rng = random.Random(3); kill = np.zeros(n, bool); isl = {}
for i, r in enumerate(root): isl.setdefault(r, []).append(i)
print("LASH islands", len(isl))
blks = alib.blocks(me); arrs = [alib.co(b, n).copy() for b in blks]
for r, idx in isl.items():
    idx = np.array(idx); c = cen[1 if p[idx, 0].mean() > 0 else -1]
    upper = p[idx, 2].mean() > c[2]
    if rng.random() > (0.55 if upper else 0.30): kill[idx] = True; continue
    ri = idx[np.argmin(np.linalg.norm(p[idx] - c, axis=1))]
    k = (0.58 if upper else 0.50) * rng.uniform(0.8, 1.15)
    for A in arrs: A[idx] = A[ri] + (A[idx] - A[ri]) * k
for b, A in zip(blks, arrs): b.foreach_set('co', A.ravel())
import bmesh
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(kill)[0]], context='VERTS'); bm.to_mesh(me); bm.free(); me.update()
print("LASH verts", n, "->", len(me.vertices))
# ---- pose
bpy.context.view_layer.objects.active = rig
def rw(pb, axis, deg):
    M = pb.matrix.copy(); tr = M.translation.copy(); M2 = Matrix.Rotation(math.radians(deg), 4, Vector(axis)) @ M; M2.translation = tr
    pb.matrix = M2; bpy.context.view_layer.update()
P = rig.pose.bones
for side, s in (('Left', 1), ('Right', -1)):
    rw(P[side + 'Shoulder'], (0, 1, 0), 6 * s)        # drop the shoulders a little: softer, less square line
    rw(P[side + 'Arm'], (0, 1, 0), 27 * s)
    ua = (P[side + 'ForeArm'].head - P[side + 'Arm'].head).normalized(); fa = (P[side + 'Hand'].head - P[side + 'ForeArm'].head).normalized()
    ax = ua.cross(fa).normalized(); ang = math.degrees(ua.angle(fa))
    rw(P[side + 'ForeArm'], ax, -(ang - 16))           # leave a 16 degree elbow bend
    rw(P[side + 'ForeArm'], (P[side + 'Hand'].head - P[side + 'ForeArm'].head).normalized(), 0)
    rw(P[side + 'UpLeg'], (0, 1, 0), 3.5 * s); rw(P[side + 'Foot'], (0, 1, 0), -3.5 * s)
    wid = (P[side + 'HandPinky1'].head - P[side + 'HandIndex1'].head).normalized()
    for f in ('Index', 'Middle', 'Ring', 'Pinky', 'Thumb'):
        for j in (1, 2, 3):
            pb = P[side + 'Hand' + f + str(j)]; deg = (7 if f == 'Thumb' else (10, 16, 14)[j - 1] + {'Index': 0, 'Middle': 2, 'Ring': 4, 'Pinky': 6}.get(f, 0))
            tip0 = pb.tail.copy(); rw(pb, wid, deg); d1 = (pb.tail - tip0).x * s
            if d1 > 0: rw(pb, wid, -2 * deg)       # wrong way: curl must bring the tip towards the body midline
bpy.context.view_layer.update()
print("WRIST", [tuple(round(x, 3) for x in P[s + 'Hand'].head) for s in ('Left', 'Right')], "ELBOW", tuple(round(x, 3) for x in P['LeftForeArm'].head))
# ---- bake pose into the body (basis + keys keep their deltas: the head is not posed), then apply as rest pose
for kb in B.data.shape_keys.key_blocks: kb.value = 0
dg = bpy.context.evaluated_depsgraph_get(); ev = B.evaluated_get(dg); nb = len(B.data.vertices)
new = np.empty(nb * 3, np.float32); ev.data.vertices.foreach_get('co', new); old = alib.co(B.data.vertices, nb).ravel().copy()
alib.add_delta(B.data, new - old)
bpy.ops.object.mode_set(mode='POSE'); bpy.ops.pose.select_all(action='SELECT'); bpy.ops.pose.armature_apply(selected=False); bpy.ops.object.mode_set(mode='OBJECT')
bpy.context.view_layer.update()
# ---- slimmer build below the neck: narrower shoulders/torso/limbs (x 0.90, depth 0.94), blended in over the neck base
def kfac(z): 
    t = np.clip((1.40 - z) / 0.07, 0, 1); return t * t * (3 - 2 * t)
p = alib.co(B.data.vertices, nb); t_ = kfac(p[:, 2]); Y0 = -0.03
d = np.zeros_like(p); d[:, 0] = p[:, 0] * (-0.10 * t_); d[:, 1] = (p[:, 1] - Y0) * (-0.06 * t_)
alib.add_delta(B.data, d)
bpy.context.view_layer.objects.active = rig; bpy.ops.object.mode_set(mode='EDIT')
for eb in rig.data.edit_bones:
    for end in (eb.head, eb.tail):
        t1 = float(kfac(np.array([end.z]))[0]); end.x *= (1 - 0.10 * t1); end.y = Y0 + (end.y - Y0) * (1 - 0.06 * t1)
bpy.ops.object.mode_set(mode='OBJECT'); bpy.context.view_layer.update()
p = alib.co(B.data.vertices, nb)
gi = {g.index: g.name for g in B.vertex_groups}; W = {}
for v in B.data.vertices:
    for g in v.groups: W.setdefault(gi[g.group], np.zeros(nb, np.float32))[v.index] = g.weight
arm = sum(W.get(k, 0) for k in W if ('Arm' in k or 'Hand' in k))
meas = {'bones': {b.name: [list(b.head_local), list(b.tail_local)] for b in rig.data.bones}, 'slices': {}}
tor = arm < 0.3
for z in np.arange(0.40, 1.42, 0.02):
    s = tor & (np.abs(p[:, 2] - z) < 0.012)
    if s.sum() > 3: meas['slices']['%.2f' % z] = [float(p[s, 0].min()), float(p[s, 0].max()), float(p[s, 1].min()), float(p[s, 1].max())]
ears = W['Head'] * 0; gn = {g.name: g.index for g in B.vertex_groups}
for v in B.data.vertices:
    for g in v.groups:
        if g.group == gn['ears']: ears[v.index] = g.weight
for s, nm in ((1, 'L'), (-1, 'R')):
    q = p[(ears > 0.5) & (p[:, 0] * s > 0)]; lo = q[np.argmin(q[:, 2])]
    meas['ear' + nm] = {'lobe': lo.tolist(), 'min': q.min(0).tolist(), 'max': q.max(0).tolist()}
meas['zmin'] = float(p[:, 2].min()); meas['zmax'] = float(p[:, 2].max())
json.dump(meas, open('/project/w/out/meas.json', 'w'))
for k in ('0.50', '0.70', '0.86', '0.96', '1.06', '1.16', '1.22', '1.28', '1.32', '1.36', '1.40'): print("SLICE", k, [round(x, 3) for x in meas['slices'].get(k, [])])
print("EARS", meas['earL'], meas['earR']); print("Z", meas['zmin'], meas['zmax'])
alib.save(a[1])
