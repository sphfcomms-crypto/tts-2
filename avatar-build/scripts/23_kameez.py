# 23_kameez.py - kameez as real geometry around the posed body.
#   upper part (shoulders, chest, sleeves): body surface copy, pushed out by an ease and relaxed as a membrane that must stay
#   outside the body; lower part: a tube hanging from the bust (convex hull of everything above each ring) down to the knee;
#   then subdivided, settled with a short cloth simulation against the body (pinned at shoulders/sleeves) and applied.
#   blender -b posed.blend --python 23_kameez.py -- OUT.blend [nocloth]
import bpy, bmesh, sys, json, math, random, numpy as np
from mathutils import Vector
sys.path.insert(0, '/project/w/s'); import alib, glib
a = alib.args(); sc = bpy.context.scene
rig = bpy.data.objects['Armature']; B = bpy.data.objects['Body']; bn = rig.data.bones
BONES = [b.name for b in bn]
nb = len(B.data.vertices); p = alib.co(B.data.vertices, nb); W = glib.weights(B, set(BONES))
def wsum(keys): return sum((W[k] for k in W if any(s in k for s in keys)), np.zeros(nb, np.float32))
armw = wsum(['Arm']); handw = wsum(['Hand']); headw = W['Head']
isarm = (armw + handw) > 0.5
ZC, ZHEM = 1.17, 0.49; NC = np.array([0.0, -0.025]); NA, NB_ = 0.080, 0.062
ell = ((p[:, 0] - NC[0]) / NA) ** 2 + ((p[:, 1] - NC[1]) / NB_) ** 2
keep = (~isarm) & (p[:, 2] >= ZC - 0.004) & (p[:, 2] < 1.42) & ~((ell < 1.0) & (p[:, 2] > 1.27)) & (headw < 0.3)
cuff = {}
for side, s in (('Left', 1), ('Right', -1)):
    wr = np.array(bn[side + 'Hand'].head_local); el = np.array(bn[side + 'ForeArm'].head_local); fd = (wr - el) / np.linalg.norm(wr - el)
    cp = wr - fd * 0.012; cuff[s] = (cp, fd, el, np.linalg.norm(wr - el))
    keep |= isarm & (p[:, 0] * s > 0) & (((p - cp) @ fd) < 0) & (handw < 0.5)
me = B.data.copy(); me.name = 'Kameez'; K = glib.new_obj('Kameez', me, rig)
for g in B.vertex_groups: K.vertex_groups.new(name=g.name)
K.shape_key_clear(); me.materials.clear()
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context='VERTS')
# keep the largest connected piece only
bm.verts.ensure_lookup_table(); seen = set(); comps = []
for v in bm.verts:
    if v in seen: continue
    st = [v]; seen.add(v); comp = [v]
    while st:
        x = st.pop()
        for e in x.link_edges:
            y = e.other_vert(x)
            if y not in seen: seen.add(y); st.append(y); comp.append(y)
    comps.append(comp)
comps.sort(key=len, reverse=True)
for c in comps[1:]: bmesh.ops.delete(bm, geom=c, context='VERTS')
print("KAMEEZ upper verts", len(bm.verts), "dropped pieces", len(comps) - 1)
bm.normal_update()
tree = glib.bvh_of(B)
def ease_of(co):
    e = 0.010 if co.z < 1.25 else 0.006
    for s in (1, -1):
        cp, fd, el, ln = cuff[s]
        if co.x * s > 0.150:
            t = float((np.array(co) - el) @ fd) / ln
            e = max(e, 0.009 + 0.011 * min(max(t, 0), 1))
    return e
for v in bm.verts: v.co += v.normal * ease_of(v.co)
loops = glib.boundary_loops(bm); kind = {}
for lp in loops:
    c = sum((v.co for v in lp), Vector()) / len(lp)
    if abs(c.x) > 0.15: k = 'cuff'
    elif c.z > 1.28: k = 'neck'
    else: k = 'bottom'
    kind.setdefault(k, []).append(lp); print("LOOP", k, len(lp), tuple(round(x, 3) for x in c))
def loop_smooth(lp, it=10, lam=0.5):
    m_ = len(lp)
    for _ in range(it):
        cs = [v.co.copy() for v in lp]
        for i, v in enumerate(lp): v.co = cs[i] + lam * ((cs[i - 1] + cs[(i + 1) % m_]) / 2 - cs[i])
for lp in kind['neck']: loop_smooth(lp, 12)          # take the stair-steps out of the neckline
for lp in kind['cuff']:
    s = 1 if lp[0].co.x > 0 else -1; cp, fd, el, ln = cuff[s]
    for v in lp: v.co -= Vector(fd) * float((np.array(v.co) - cp) @ fd)
bot = max(kind['bottom'], key=len)
tors = ~isarm
def hull_at(z):
    return glib.hull2d(p[tors & (p[:, 2] > z - 0.012) & (p[:, 2] < 1.24)][:, :2])
h0 = hull_at(ZC); c0 = h0.mean(0)
ang = [math.atan2(v.co.y - c0[1], v.co.x - c0[0]) for v in bot]
for v, th in zip(bot, ang):
    r = glib.hull_radius(h0, c0, th) + 0.012
    v.co.x = c0[0] + r * math.cos(th); v.co.y = c0[1] + r * math.sin(th); v.co.z = ZC
fixed_v = set(v for lp in loops for v in lp)
prev = bot; nr = int(round((ZC - ZHEM) / 0.02)); rng = random.Random(5)
ph = [rng.uniform(0, 6.28) for _ in range(4)]
for k in range(1, nr + 1):
    z = ZC - (ZC - ZHEM) * k / nr; h = hull_at(z); flare = 1 + 0.045 * min(max((0.90 - z) / 0.40, 0), 1); depth = min(max((1.10 - z) / 0.6, 0), 1)
    ring = []
    for th in ang:
        r = (glib.hull_radius(h, c0, th) + 0.012) * flare
        r += depth * (0.0035 * math.sin(7 * th + ph[0]) + 0.0025 * math.sin(11 * th + ph[1] + z * 3) + 0.002 * math.sin(17 * th + ph[2]))   # soft hanging folds
        ring.append(bm.verts.new((c0[0] + r * math.cos(th), c0[1] + r * math.sin(th), z)))
    m = len(ring)
    for j in range(m): bm.faces.new((prev[j], prev[(j + 1) % m], ring[(j + 1) % m], ring[j]))
    fixed_v.update(ring); prev = ring
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
bm.verts.index_update(); fixed = np.zeros(len(bm.verts), bool)
for v in fixed_v: fixed[v.index] = True
eas = np.array([ease_of(v.co) for v in bm.verts]); nupper = len(bm.verts) - nr * len(bot)
bm.to_mesh(me); bm.free(); me.update()
n = len(me.vertices); P = alib.co(me.vertices, n).astype(np.float64); E = glib.edges_np(me)
P = glib.relax(P, E, fixed, tree, eas, iters=25, lam=0.5)
me.vertices.foreach_set('co', P.astype(np.float32).ravel()); me.update()
# skin weights for the new hanging part from the body, then one subdivision level
newv = np.zeros(n, bool); newv[nupper:] = True
glib.transfer_weights(K, B, BONES, k=4, only=newv)
glib.subdiv(K, 1); me = K.data
bm = bmesh.new(); bm.from_mesh(me)
for lp in glib.boundary_loops(bm):
    c = sum((v.co for v in lp), Vector()) / len(lp)
    if c.z > 1.28 and abs(c.x) < 0.1: loop_smooth(lp, 6)
bm.to_mesh(me); bm.free(); n = len(me.vertices); glib.smooth_shade(me)
print("KAMEEZ verts", n, "tris", sum(len(f.vertices) - 2 for f in me.polygons))
# ---- cloth settle against the body: shoulders, sleeves and upper chest pinned
if not (len(a) > 1 and a[1] == 'nocloth'):
    P0 = alib.co(me.vertices, n).copy()
    pin = K.vertex_groups.new(name='pin')
    for v in me.vertices:
        w = 1.0 if abs(v.co.x) > 0.155 and v.co.z > 0.8 and v.co.z < 1.2 else min(max((v.co.z - 1.13) / 0.06, 0), 1)
        if abs(v.co.x) > 0.13 and v.co.z > 1.16: w = 1.0
        if w > 0: pin.add([v.index], w, 'REPLACE')
    cm = B.modifiers.new('col', 'COLLISION'); B.collision.thickness_outer = 0.006; B.collision.thickness_inner = 0.01; B.collision.cloth_friction = 12
    md = K.modifiers.new('cloth', 'CLOTH'); st = md.settings
    st.quality = 8; st.mass = 0.12; st.tension_stiffness = 14; st.compression_stiffness = 14; st.shear_stiffness = 5; st.bending_stiffness = 0.35
    st.tension_damping = 6; st.compression_damping = 6; st.air_damping = 2.5
    st.vertex_group_mass = 'pin'; st.pin_stiffness = 1.0
    md.collision_settings.use_collision = True; md.collision_settings.distance_min = 0.005; md.collision_settings.use_self_collision = False
    md.point_cache.frame_start = 1; md.point_cache.frame_end = 40
    for f in range(1, 41): sc.frame_set(f)
    ev = K.evaluated_get(bpy.context.evaluated_depsgraph_get()); P1 = np.empty(n * 3, np.float32); ev.data.vertices.foreach_get('co', P1); P1 = P1.reshape(-1, 3)
    K.modifiers.remove(md); B.modifiers.remove(cm); K.vertex_groups.remove(pin); sc.frame_set(1)
    mv = np.linalg.norm(P1 - P0, axis=1)
    print("CLOTH move mm: mean %.1f max %.1f" % (mv.mean() * 1000, mv.max() * 1000))
    for i in np.argsort(-mv)[:6]: print('CLOTH far', P0[i].round(3), '->', P1[i].round(3))
    print('CLOTH moved>3cm', int((mv > 0.03).sum()), 'of', n)
    if np.isfinite(P1).all() and mv.max() < 0.25:
        me.vertices.foreach_set('co', P1.ravel()); me.update(); print("CLOTH applied")
    else: print("CLOTH rejected, keeping the relaxed shape")
# ---- UV islands (front/back planar), boundary segments for the embroidery painter
S, TW, TH, ZMIN, MG = 2100.0, 4096, 2048, 0.47, 14
P = alib.co(me.vertices, n); Wk = glib.weights(K, set(BONES))
aw = sum((Wk[k] for k in Wk if 'Arm' in k or 'Hand' in k), np.zeros(n, np.float32))
uvl = me.uv_layers[0] if me.uv_layers else me.uv_layers.new(name='UVMap'); uvl.name = 'UVMap'
isl = {}; fisl = []
for f in me.polygons:
    vs = list(f.vertices); c = P[vs].mean(0); sleeve = aw[vs].mean() > 0.5
    nm = ('sl' + ('L' if c[0] > 0 else 'R') if sleeve else 'tor') + ('F' if f.normal.y < 0 else 'B')
    fisl.append(nm); r = isl.setdefault(nm, [1e9, -1e9]); r[0] = min(r[0], P[vs, 0].min()); r[1] = max(r[1], P[vs, 0].max())
x0 = 0; lay = {}
for nm in ('torF', 'torB', 'slLF', 'slLB', 'slRF', 'slRB'):
    w = int((isl[nm][1] - isl[nm][0]) * S) + 2 * MG; lay[nm] = dict(x0=x0, xmin=isl[nm][0], w=w, flip=nm.endswith('B')); x0 += w + 8
print("UV width used", x0, "of", TW)
def uvof(nm, co):
    L = lay[nm]; u = (co[0] - L['xmin']) * S + MG
    if L['flip']: u = L['w'] - u
    return ((L['x0'] + u) / TW, ((co[2] - ZMIN) * S + MG) / TH)
for f in me.polygons:
    for li in f.loop_indices: uvl.data[li].uv = uvof(fisl[f.index], P[me.loops[li].vertex_index])
bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table(); segs = {'neck': [], 'cuff': [], 'hem': []}
for e in bm.edges:
    if not e.is_boundary: continue
    c = (e.verts[0].co + e.verts[1].co) / 2; nm = fisl[e.link_faces[0].index]
    k = 'hem' if c.z < 0.6 else ('neck' if c.z > 1.27 and abs(c.x) < 0.12 else 'cuff')
    u1 = uvof(nm, e.verts[0].co); u2 = uvof(nm, e.verts[1].co)
    segs[k].append([u1[0] * TW, (1 - u1[1]) * TH, u2[0] * TW, (1 - u2[1]) * TH])
nf = min((v.co for e in bm.edges if e.is_boundary for v in e.verts if v.co.z > 1.27 and abs(v.co.x) < 0.02 and v.co.y < NC[1]), key=lambda c: abs(c.x))
uc = uvof('torF', (0.0, 0, nf.z)); bm.free()
json.dump(dict(S=S, TW=TW, TH=TH, lay=lay, segs=segs, slit=[uc[0] * TW, (1 - uc[1]) * TH]), open('/project/w/out/kameez_uv.json', 'w'), default=float)
md = K.modifiers.new('rim', 'SOLIDIFY'); md.thickness = 0.003; md.offset = -1; md.use_rim = True; md.use_rim_only = True
dg = bpy.context.evaluated_depsgraph_get(); arm_md = K.modifiers['Armature']; arm_md.show_viewport = False
nm_ = bpy.data.meshes.new_from_object(K.evaluated_get(bpy.context.evaluated_depsgraph_get())); arm_md.show_viewport = True
K.modifiers.remove(md); old = K.data; K.data = nm_; bpy.data.meshes.remove(old); K.data.name = 'Kameez'; glib.smooth_shade(K.data)
print("KAMEEZ final verts", len(K.data.vertices), "tris", sum(len(f.vertices) - 2 for f in K.data.polygons))
alib.save(a[0])
