# 28b_morphfix.py - make teeth and tongue follow the jaw in every face morph: for each body morph that drops the jaw but is
# missing on Teeth/Tongue, add it there as (jaw ratio) x their own jawOpen delta. Then audit every morph of every mesh.
#   blender -b final.blend --python 28b_morphfix.py -- OUT.blend AUDIT.json
import bpy, sys, json, numpy as np
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); B = bpy.data.objects['Body']; kb = B.data.shape_keys.key_blocks; n = len(B.data.vertices)
b0 = alib.co(kb[0].data, n).copy(); dj = alib.co(kb['jawOpen'].data, n) - b0
mag = np.linalg.norm(dj, axis=1); chin = np.argsort(-mag)[:150]; den = float((dj[chin] ** 2).sum())
ratio = {}
for k in kb[1:]:
    d = alib.co(k.data, n) - b0; ratio[k.name] = float((d[chin] * dj[chin]).sum() / den)
print("JAW ratios", {k: round(v, 2) for k, v in ratio.items() if abs(v) > 0.05})
for name in ('Teeth', 'Tongue'):
    o = bpy.data.objects[name]; ks = o.data.shape_keys.key_blocks; m = len(o.data.vertices); o0 = alib.co(ks[0].data, m).copy(); oj = alib.co(ks['jawOpen'].data, m) - o0
    added = []
    for k, r in ratio.items():
        if k not in ks and r > 0.05:            # only real jaw drops; lip-closing shapes must not push the teeth up
            nk = o.shape_key_add(name=k, from_mix=False); nk.data.foreach_set('co', (o0 + oj * r).astype(np.float32).ravel()); added.append(k)
    print("ADDED on", name, added)
for o in bpy.data.objects:            # the asset pack's full smile is too strong on this face: 75 %
    if o.type == 'MESH' and o.data.shape_keys:
        ks = o.data.shape_keys.key_blocks; m = len(o.data.vertices); o0 = alib.co(ks[0].data, m).copy()
        for nm in ('mouthSmileLeft', 'mouthSmileRight'):
            if nm in ks: ks[nm].data.foreach_set('co', (o0 + 0.75 * (alib.co(ks[nm].data, m) - o0)).astype(np.float32).ravel())
# viseme_sil is empty in the pack (silence = rest): give it a real, faint lip press instead of a morph that does nothing
dsil = 0.2 * (alib.co(kb['mouthPressLeft'].data, n) - b0) + 0.2 * (alib.co(kb['mouthPressRight'].data, n) - b0)
kb['viseme_sil'].data.foreach_set('co', (b0 + dsil).astype(np.float32).ravel())
# upper incisors sat exactly at the lip line and never showed in speech: lower the upper arch 2.2 mm (normal incisal display),
# the lower arch 1 mm, in every key
T_ = bpy.data.objects['Teeth']; tk = T_.data.shape_keys.key_blocks; tm = len(T_.data.vertices); tt0 = alib.co(tk[0].data, tm).copy()
static = np.linalg.norm(alib.co(tk['jawOpen'].data, tm) - tt0, axis=1) < 1e-5
dd = np.zeros_like(tt0); dd[static, 2] = -0.0022; dd[~static, 2] = -0.0010; alib.add_delta(T_.data, dd)
print("TEETH upper verts", int(static.sum()), "lowered 2.2 mm; lower", int((~static).sum()), "lowered 1 mm")
# eyes: the MakeHuman iris is a recessed disc (its clear cornea shell cannot go to glTF). Reshape the disc into a convex
# cornea dome continuous with the sclera, so lights give small crisp catchlights instead of a grey veil over the iris.
E_ = bpy.data.objects['Eyes']; em = len(E_.data.vertices); e0 = alib.co(E_.data.vertices, em).astype(np.float64); de = np.zeros_like(e0)
for sgn in (-1, 1):
    idx = np.nonzero(e0[:, 0] * sgn > 0)[0]; P = e0[idx]
    c = P.mean(0); d = np.linalg.norm(P - c, axis=1); sel = d > np.median(d)
    for _ in range(3):                      # algebraic sphere fit on the sclera shell
        A_ = np.c_[2 * P[sel], np.ones(sel.sum())]; bb = (P[sel] ** 2).sum(1); sol = np.linalg.lstsq(A_, bb, rcond=None)[0]
        c = sol[:3]; R = float(np.sqrt(sol[3] + (c ** 2).sum())); d = np.linalg.norm(P - c, axis=1); sel = d > R - 0.0004
    iris = (d < R - 0.0004) & (P[:, 1] < c[1] - 0.4 * R)
    ax = P[iris].mean(0) - c; ax /= np.linalg.norm(ax)
    rel = P[iris] - c; hgt = rel @ ax; rad = rel - np.outer(hgt, ax); rho = np.linalg.norm(rad, axis=1); ri = float(rho.max())
    newh = np.sqrt(np.maximum(R * R - rho * rho, 0)) + 0.0011 * (1 - (rho / ri) ** 2)
    de[idx[iris]] = np.outer(newh - hgt, ax)
    print("EYE", sgn, "R mm %.2f" % (R * 1000), "iris verts", int(iris.sum()), "limbus r mm %.2f" % (ri * 1000), "max forward move mm %.2f" % (float((newh - hgt).max()) * 1000), "axis", ax.round(2))
alib.add_delta(E_.data, de.astype(np.float32))
audit = {}
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        ks = o.data.shape_keys.key_blocks; m = len(o.data.vertices); o0 = alib.co(ks[0].data, m).copy()
        audit[o.name] = {k.name: round(float(np.linalg.norm(alib.co(k.data, m) - o0, axis=1).max() * 1000), 2) for k in ks[1:]}
        dead = [k for k, v in audit[o.name].items() if v < 0.05]
        print("AUDIT", o.name, len(audit[o.name]), "morphs; no movement on this mesh:", dead)
json.dump(audit, open(a[1], 'w'), indent=1)
alib.save(a[0])
