# 24_wardrobe.py - shalwar (two pleated, ankle-gathered legs), chiffon dupatta (U across the chest, both ends over the shoulders
# and down the back, pleated, laid on the kameez by ray casting), khussa shoes, jhumka earrings and the nose pin.
#   blender -b kameez.blend --python 24_wardrobe.py -- OUT.blend
import bpy, bmesh, sys, json, math, random, numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
sys.path.insert(0, '/project/w/s'); import alib, glib
a = alib.args(); sc = bpy.context.scene
rig = bpy.data.objects['Armature']; B = bpy.data.objects['Body']; K = bpy.data.objects['Kameez']; bn = rig.data.bones
BONES = [b.name for b in bn]; meas = json.load(open('/project/w/out/meas.json'))
nb = len(B.data.vertices); p = alib.co(B.data.vertices, nb)
def mesh_obj(name, verts, faces, uvs=None):
    me = bpy.data.meshes.new(name); me.from_pydata([tuple(v) for v in verts], [], faces); me.update()
    if uvs is not None:
        uvl = me.uv_layers.new(name='UVMap')
        for f in me.polygons:
            for li, u in zip(f.loop_indices, uvs[f.index]): uvl.data[li].uv = u
    glib.smooth_shade(me); return glib.new_obj(name, me, rig)
# ------------------------------------------------------------------ shalwar
rng = random.Random(11); V = []; F = []; UV = []
Wn = glib.weights(B, set(BONES)); armhand = sum((Wn[k] for k in Wn if 'Arm' in k or 'Hand' in k), np.zeros(nb, np.float32)) > 0.4
zs = list(np.arange(0.80, 0.50, -0.04)) + list(np.arange(0.50, 0.088, -0.0125)) + [0.086]
bag = [(0.84, 0.004), (0.60, 0.004), (0.52, 0.010), (0.44, 0.026), (0.30, 0.038), (0.19, 0.040), (0.14, 0.030), (0.108, 0.013), (0.086, 0.011)]
amp = [(0.84, 0.0), (0.52, 0.02), (0.40, 0.08), (0.20, 0.12), (0.125, 0.17), (0.104, 0.05), (0.086, 0.015)]
def interp(tab, z):
    zz = [t[0] for t in tab][::-1]; vv = [t[1] for t in tab][::-1]; return float(np.interp(z, zz, vv))
SEG = 40
for side, s in (('Left', 1), ('Right', -1)):
    ph = [rng.uniform(0, 6.28) for _ in range(3)]; base = len(V); prev = None; par = []
    for i, z in enumerate(zs):
        zq = max(z, 0.115)
        sl = p[(p[:, 0] * s > 0.004) & (np.abs(p[:, 2] - zq) < 0.02) & ~armhand]
        if len(sl) >= 4: prev = ((sl[:, 0].min() + sl[:, 0].max()) / 2, (sl[:, 1].min() + sl[:, 1].max()) / 2, (sl[:, 0].max() - sl[:, 0].min()) / 2, (sl[:, 1].max() - sl[:, 1].min()) / 2)
        par.append(prev)
    par = np.array(par)
    for _ in range(3):          # smooth the leg cross-section along the height: no horizontal ridges
        pp_ = np.pad(par, ((2, 2), (0, 0)), mode='edge'); par = (pp_[:-4] + 2 * pp_[1:-3] + 3 * pp_[2:-2] + 2 * pp_[3:-1] + pp_[4:]) / 9
    for i, z in enumerate(zs):
        cx, cy, rx, ry = par[i]; bg = interp(bag, z); am = interp(amp, z)
        for j in range(SEG + 1):
            th = 2 * math.pi * j / SEG + (math.pi if s > 0 else 0)          # seam on the inner side
            f = 0.6 * math.sin(7 * th + ph[0]) + 0.4 * math.sin(12 * th + ph[1])          # vertical pleats
            f = math.copysign(abs(f) ** 0.8, f); k = 1 + am * f
            x = cx + (rx + bg) * k * math.cos(th); y = cy + (ry + bg) * k * math.sin(th)
            x = s * max(x * s, 0.003)
            V.append((x, y, z))
    for i in range(len(zs) - 1):
        for j in range(SEG):
            q = base + i * (SEG + 1) + j
            F.append((q, q + 1, q + SEG + 2, q + SEG + 1))
            UV.append([((jj) / SEG * 1.3, zz / 0.5) for jj, zz in ((j, zs[i]), (j + 1, zs[i]), (j + 1, zs[i + 1]), (j, zs[i + 1]))])
S_ = mesh_obj('Shalwar', V, F, UV)
bm = bmesh.new(); bm.from_mesh(S_.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(S_.data); bm.free()
glib.transfer_weights(S_, B, BONES, k=4); print("SHALWAR tris", len(F) * 2)
# ------------------------------------------------------------------ dupatta
dg = bpy.context.evaluated_depsgraph_get(); tK = BVHTree.FromObject(K, dg); tB = BVHTree.FromObject(B, dg)
def cast(o, d, dist=2.0):
    best = None
    for t in (tK, tB):
        loc, nor, idx, ds = t.ray_cast(Vector(o), Vector(d).normalized(), dist)
        if loc is not None and (best is None or ds < best[1]): best = (loc, ds)
    return best[0] if best else None
NT, NF = 57, 7; NB_, NA_, NFR = 34, 14, 110
rows = []
rng = random.Random(21); phs = [rng.uniform(0, 6.28) for _ in range(6)]
comps = [(3.4, 0.32, 1.3, phs[0]), (6.1, 0.27, 2.1, phs[1]), (10.3, 0.22, 3.2, phs[2]), (16.7, 0.19, 4.1, phs[3])]
def bump(t, sn, amp):                     # soft irregular lengthwise folds that wander and merge along the cloth
    v = 0.0
    for fq, w, k, ph_ in comps: v += w * math.sin(2 * math.pi * fq * t + ph_ + 1.6 * math.sin(2 * math.pi * k * sn + ph_ * 1.7))
    v = math.copysign(abs(v) ** 0.7, v)
    return amp * (0.5 + 0.5 * v)
grid = np.zeros((NB_ + NA_ + NFR + NA_ + NB_, NT, 3))
for it in range(NT):
    t = it / (NT - 1); xt = 0.078 + 0.068 * t
    col = []
    def arc(sgn):
        zt = cast((sgn * xt, -0.01, 1.7), (0, 0, -1)); ztop = zt.z if zt else 1.36
        C = Vector((sgn * xt, -0.012, ztop - 0.07)); pts = []
        for i in range(NA_):
            al = math.radians(8 + (172 - 8) * i / (NA_ - 1)); d = Vector((0, -math.cos(al), math.sin(al)))
            h = cast(C + d * 0.125, -d, 0.2); q = (h if h else C + d * 0.07)
            pts.append((q, d))
        return pts
    aL = arc(1); aR = arc(-1)
    zendL = 0.60 + 0.05 * math.sin(3 * t + 1) + 0.03 * t; zendR = 0.57 + 0.04 * math.cos(4 * t) + 0.02 * t
    def back(sgn, pts, zend):
        q0 = pts[-1][0]; out = []
        for i in range(NB_):
            z = q0.z - (q0.z - zend) * (i + 1) / NB_
            h = cast((sgn * xt * (1 - 0.10 * (i + 1) / NB_), 0.6, z), (0, -1, 0), 1.0)
            y = h.y if h else 0.10
            out.append((Vector((sgn * xt * (1 - 0.10 * (i + 1) / NB_), y, z)), Vector((0, 1, 0))))
        return out
    bL = back(1, aL, zendL); bR = back(-1, aR, zendR)
    qL = aL[0][0]; qR = aR[0][0]; zf = (qL.z + qR.z) / 2; D = (zf - 1.215) + 0.14 * t
    fr = []
    for i in range(NFR):
        phi = math.pi / 2 - math.pi * (i + 1) / (NFR + 1); x = xt * math.sin(phi); z = zf - D * math.cos(phi) ** 0.9
        h = cast((x, -0.6, z), (0, 1, 0), 1.0); y = h.y if h else -0.16
        fr.append((Vector((x, y, z)), Vector((0, -1, 0))))
    seq = bL[::-1] + aL[::-1] + fr + aR + bR
    ns = len(seq)
    for i, (q, d) in enumerate(seq):
        sn = i / (ns - 1); sec = 'b' if (i < NB_ or i >= ns - NB_) else ('f' if NB_ + NA_ <= i < NB_ + NA_ + NFR else 'a')
        amp = {'b': 0.018, 'a': 0.009, 'f': 0.011 + 0.010 * math.sin(math.pi * (i - NB_ - NA_) / NFR) if sec == 'f' else 0}[sec]
        off = 0.0045 + 0.002 * (1 - t) + bump(t, sn, amp)
        grid[i, it] = np.array(q + d * off)
# smooth along the length to take out ray-cast noise, keep ends
for _ in range(3):
    g2 = grid.copy(); g2[1:-1] = 0.25 * grid[:-2] + 0.5 * grid[1:-1] + 0.25 * grid[2:]; grid = g2
ns = grid.shape[0]; V = grid.reshape(-1, 3); F = []; UV = []
slen = np.r_[0, np.cumsum(np.linalg.norm(np.diff(grid[:, NT // 2], axis=0), axis=1))]
for i in range(ns - 1):
    for j in range(NT - 1):
        q = i * NT + j; F.append((q, q + NT, q + NT + 1, q + 1))
        UV.append([(slen[i] / 0.6, j / (NT - 1)), (slen[i + 1] / 0.6, j / (NT - 1)), (slen[i + 1] / 0.6, (j + 1) / (NT - 1)), (slen[i] / 0.6, (j + 1) / (NT - 1))])
D_ = mesh_obj('Dupatta', V, F, UV)
bm = bmesh.new(); bm.from_mesh(D_.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(D_.data); bm.free()
# cloth settle: shoulders pinned, front U and hanging ends only held softly so gravity and the collision with kameez/body
# shape them; accepted only if it stays sane, then applied
import os
if not os.environ.get('NOCLOTH'):
    dme = D_.data; dn = len(dme.vertices); P0 = alib.co(dme.vertices, dn).copy()
    pin = D_.vertex_groups.new(name='pin'); a0, a1 = NB_, NB_ + NA_; b0_, b1_ = NB_ + NA_ + NFR, NB_ + 2 * NA_ + NFR
    for i in range(ns):
        if a0 <= i < a1 or b0_ <= i < b1_: w = 1.0
        elif a1 <= i < b0_: w = 0.22 + 0.5 * max(0, 1 - min(i - a1, b0_ - 1 - i) / 14.0)
        else: w = 0.18 + 0.6 * max(0, 1 - (min(abs(i - a0), abs(i - b1_ + 1))) / 10.0)
        pin.add([i * NT + j for j in range(NT)], min(w, 1.0), 'REPLACE')
    cols = []
    for o_ in (K, B):
        cm = o_.modifiers.new('col', 'COLLISION'); o_.collision.thickness_outer = 0.004; o_.collision.cloth_friction = 20; cols.append((o_, cm))
    md = D_.modifiers.new('cloth', 'CLOTH'); st = md.settings
    st.quality = 8; st.mass = 0.08; st.tension_stiffness = 6; st.compression_stiffness = 6; st.shear_stiffness = 2; st.bending_stiffness = 0.08
    st.tension_damping = 5; st.compression_damping = 5; st.air_damping = 3
    st.vertex_group_mass = 'pin'; st.pin_stiffness = 0.6
    md.collision_settings.use_collision = True; md.collision_settings.distance_min = 0.004; md.collision_settings.use_self_collision = False
    md.point_cache.frame_start = 1; md.point_cache.frame_end = 30
    for f in range(1, 31): sc.frame_set(f)
    ev = D_.evaluated_get(bpy.context.evaluated_depsgraph_get()); P1 = np.empty(dn * 3, np.float32); ev.data.vertices.foreach_get('co', P1); P1 = P1.reshape(-1, 3)
    D_.modifiers.remove(md); D_.vertex_groups.remove(pin); sc.frame_set(1)
    for o_, cm in cols: o_.modifiers.remove(cm)
    mv = np.linalg.norm(P1 - P0, axis=1)
    print("DUPATTA cloth move mm: mean %.1f max %.1f" % (mv.mean() * 1000, mv.max() * 1000))
    if np.isfinite(P1).all() and mv.max() < 0.09 and mv.mean() < 0.02:
        dme.vertices.foreach_set('co', P1.ravel()); dme.update(); print("DUPATTA cloth applied")
    else: print("DUPATTA cloth rejected, keeping the laid-on shape")
glib.transfer_weights(D_, B, BONES, k=4); print("DUPATTA tris", len(F) * 2, "length m", round(float(slen[-1]), 2))
# ------------------------------------------------------------------ khussa
W = glib.weights(B, set(BONES))
V = []; F = []; UV = []; NS, M = 26, 22
for side, s in (('Left', 1), ('Right', -1)):
    ft = (p[:, 2] < 0.075) & (p[:, 0] * s > 0); q = p[ft]; y0, y1 = q[:, 1].min(), q[:, 1].max(); L = y1 - y0; zsole = q[:, 2].min() - 0.004; base = len(V)
    last = None
    for i in range(NS):
        u = i / (NS - 1); y = y0 - 0.022 + (L + 0.028) * u
        sl = q[np.abs(q[:, 1] - min(max(y, y0 + 0.006), y1 - 0.004)) < 0.012][:, [0, 2]]
        sl = sl[sl[:, 1] < 0.085]
        h = glib.hull2d(sl); c = h.mean(0); k = 1.0; lift = 0.0
        if y < y0 + 0.006: k = max(0.12, 1 - ((y0 + 0.006 - y) / 0.028) ** 1.3 * 0.88); lift = 0.016 * ((y0 + 0.006 - y) / 0.028) ** 2   # pointed, slightly curled toe
        wall = 0.030 + 0.022 * max(0, (u - 0.45) / 0.55) ** 1.5 + zsole       # side height: low at the vamp edge, higher at the heel
        for j in range(M):
            th = 2 * math.pi * j / M; r = (glib.hull_radius(h, c, th) + 0.0045) * k
            x = c[0] + r * math.cos(th); z = c[1] + r * math.sin(th) * k + lift
            z = max(z, zsole + lift)
            V.append((x, y, z))
    for i in range(NS - 1):
        u = (i + 0.5) / (NS - 1)
        for j in range(M):
            q0 = base + i * M + j; q1 = base + i * M + (j + 1) % M; q2 = base + (i + 1) * M + (j + 1) % M; q3 = base + (i + 1) * M + j
            zmid = sum(V[k_][2] for k_ in (q0, q1, q2, q3)) / 4; wall = 0.030 + 0.022 * max(0, (u - 0.45) / 0.55) ** 1.5 + zsole
            if u > 0.42 and zmid > wall: continue            # foot opening
            F.append((q0, q1, q2, q3)); UV.append([((V[k_][0] - s * 0.12) / 0.12 + 0.5, (V[k_][1] + 0.2) / 0.12) for k_ in (q0, q1, q2, q3)])
    F.append(tuple(base + j for j in range(M))); UV.append([(0.5, 0.5)] * M)
    F.append(tuple(base + (NS - 1) * M + j for j in range(M))[::-1]); UV.append([(0.5, 0.5)] * M)
Sh = mesh_obj('Khussa', V, F, UV)
bm = bmesh.new(); bm.from_mesh(Sh.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(Sh.data); bm.free()
glib.transfer_weights(Sh, B, BONES, k=3); print("KHUSSA tris", sum(len(f) - 2 for f in F), "zsole", zsole)
# ------------------------------------------------------------------ jewellery (gold)
bm = bmesh.new()
def sphere(c, r, u=10, v=6):
    g = bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    bmesh.ops.translate(bm, verts=g['verts'], vec=Vector(c))
def lathe(c, prof, seg=18):
    rings = []
    for (r, dz) in prof:
        rings.append([bm.verts.new((c[0] + r * math.cos(2 * math.pi * j / seg), c[1] + r * math.sin(2 * math.pi * j / seg), c[2] + dz)) for j in range(seg)])
    for a_, b_ in zip(rings[:-1], rings[1:]):
        for j in range(seg): bm.faces.new((a_[j], a_[(j + 1) % seg], b_[(j + 1) % seg], b_[j]))
for nm in ('earL', 'earR'):
    lb = np.array(meas[nm]['lobe']); s = 1 if lb[0] > 0 else -1
    c = lb + np.array([s * 0.002, -0.003, 0.004])
    sphere(c, 0.0026); sphere(c + [0, 0, -0.0045], 0.0013, 8, 4)
    top = c + np.array([0, 0, -0.006])
    lathe(top, [(0.0012, 0.0), (0.0030, -0.0012), (0.0058, -0.0042), (0.0078, -0.0085), (0.0088, -0.0130), (0.0091, -0.0150), (0.0080, -0.0152), (0.0074, -0.0128), (0.0060, -0.0080), (0.0030, -0.0030)])
    for j in range(12):
        an = 2 * math.pi * j / 12; sphere(top + [0.0086 * math.cos(an), 0.0086 * math.sin(an), -0.0166], 0.00135, 6, 4)
    sphere(top + [0, 0, -0.0165], 0.0021, 8, 5)
me = bpy.data.meshes.new('Jewellery'); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
# nose pin: brightest speck near her left nostril wing in the aligned photo -> front ray cast onto the face
info = json.load(open('/project/w/r/fit3_info.json')); res = info['res']; Rot = np.array(info['rot']); tt = np.array(info['t'])
pp = info['scale'] * np.array([566.7, 513.3]) @ Rot + tt
im = bpy.data.images.load('/project/w/tex/proj_photo.png'); w_, h_ = im.size; px = np.array(im.pixels[:], np.float32).reshape(h_, w_, 4)[::-1]
cx, cy = int(pp[0] * 2), int(pp[1] * 2); win = px[cy - 22:cy + 22, cx - 22:cx + 22, :3].min(2); iy, ix = np.unravel_index(np.argmax(win), win.shape)
fx, fy = (cx - 22 + ix) / 2.0, (cy - 22 + iy) / 2.0
x = alib.OCX + (fx / res - 0.5) * alib.OSIZE; z = alib.OCZ + (0.5 - fy / res) * alib.OSIZE
hit = tB.ray_cast(Vector((x, -1, z)), Vector((0, 1, 0)), 2.0)[0]
print("NOSEPIN photo px", pp.round(1), "found", fx, fy, "world", hit)
if hit is not None: sphere(hit + Vector((0, -0.0004, 0)), 0.0013, 8, 5)
bm.to_mesh(me); bm.free(); glib.smooth_shade(me)
J = glib.new_obj('Jewellery', me, rig); J.vertex_groups.new(name='Head').add(list(range(len(me.vertices))), 1.0, 'REPLACE')
print("JEWELLERY tris", sum(len(f.vertices) - 2 for f in me.polygons))
json.dump({'nosepin': list(hit) if hit is not None else None}, open('/project/w/out/wardrobe.json', 'w'))
alib.save(a[0])
