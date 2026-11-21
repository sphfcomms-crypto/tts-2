# glib.py - garment helpers: body BVH, constrained relaxation, weight transfer, boundary loops, convex hull rings.
import bpy, bmesh, math, numpy as np
from mathutils import Vector, kdtree
from mathutils.bvhtree import BVHTree

def bvh_of(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    return BVHTree.FromObject(obj, dg)

def weights(obj, bones=None):
    """per-group weight arrays; with bones given: only those groups, normalised so they sum to 1 per vertex (MPFB weights are not)"""
    n = len(obj.data.vertices); gi = {g.index: g.name for g in obj.vertex_groups}; W = {}
    for v in obj.data.vertices:
        for g in v.groups:
            W.setdefault(gi[g.group], np.zeros(n, np.float32))[v.index] = g.weight
    if bones is not None:
        W = {k: w for k, w in W.items() if k in bones}
        tot = sum(W.values(), np.zeros(n, np.float32)); tot[tot < 1e-6] = 1.0
        W = {k: w / tot for k, w in W.items()}
    return W

def transfer_weights(dst, src, bones, k=4, only=None):
    """copy bone weights from the nearest k source vertices (inverse-distance); only = boolean mask of dst vertices to write"""
    W = weights(src, set(bones)); ps = [v.co.copy() for v in src.data.vertices]
    kd = kdtree.KDTree(len(ps))
    for i, p in enumerate(ps): kd.insert(p, i)
    kd.balance()
    names = [b for b in bones if b in W]
    for nme in names:
        if nme not in dst.vertex_groups: dst.vertex_groups.new(name=nme)
    for v in dst.data.vertices:
        if only is not None and not only[v.index]: continue
        res = kd.find_n(v.co, k); tot = {}
        ws = [1.0 / max(d, 1e-5) ** 2 for (_, _, d) in res]; s = sum(ws)
        for (co, idx, d), w in zip(res, ws):
            for nme in names:
                x = W[nme][idx]
                if x > 0: tot[nme] = tot.get(nme, 0) + x * w / s
        t = sum(tot.values()) or 1.0
        for g in dst.vertex_groups:
            if g.name in names:
                try: g.remove([v.index])
                except Exception: pass
        for nme, x in tot.items():
            if x / t > 0.01: dst.vertex_groups[nme].add([v.index], x / t, 'REPLACE')

def edges_np(me):
    e = np.empty(len(me.edges) * 2, np.int64); me.edges.foreach_get('vertices', e); return e.reshape(-1, 2)

def relax(P, E, fixed, body_bvh, ease, iters=40, lam=0.5):
    """membrane relaxation: Laplacian smoothing of free vertices, each step re-projected to stay >= ease outside the body"""
    n = len(P); P = P.copy(); deg = np.zeros(n); np.add.at(deg, E[:, 0], 1); np.add.at(deg, E[:, 1], 1); deg = np.maximum(deg, 1)[:, None]
    free = ~fixed
    for it in range(iters):
        acc = np.zeros_like(P); np.add.at(acc, E[:, 0], P[E[:, 1]]); np.add.at(acc, E[:, 1], P[E[:, 0]])
        Q = P + lam * (acc / deg - P); P[free] = Q[free]
        for i in np.nonzero(free)[0]:
            loc, nor, idx, dist = body_bvh.find_nearest(Vector(P[i]))
            if loc is None: continue
            d = (Vector(P[i]) - loc).dot(nor); e = ease[i]
            if d < e: P[i] = loc + nor * e
    return P

def boundary_loops(bm):
    """ordered boundary vertex loops of a bmesh"""
    be = [e for e in bm.edges if e.is_boundary]; adj = {}
    for e in be:
        a, b = e.verts; adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
    seen = set(); loops = []
    for start in adj:
        if start in seen: continue
        loop = [start]; seen.add(start); cur = start; prev = None
        while True:
            nxt = [v for v in adj[cur] if v is not prev and v not in seen]
            if not nxt: break
            prev = cur; cur = nxt[0]; loop.append(cur); seen.add(cur)
        loops.append(loop)
    return loops

def hull2d(pts):
    pts = sorted(set(map(tuple, np.round(pts, 5))))
    if len(pts) < 3: return np.array(pts)
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    up = []
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return np.array(lo[:-1] + up[:-1])

def hull_radius(h, c, ang):
    """distance from centre c to the hull polygon h along direction ang (radians, atan2(y,x))"""
    d = np.array([math.cos(ang), math.sin(ang)]); best = 0.0; m = len(h)
    for i in range(m):
        a = h[i] - c; b = h[(i + 1) % m] - c; e = b - a
        den = d[0] * e[1] - d[1] * e[0]
        if abs(den) < 1e-12: continue
        t = (a[0] * e[1] - a[1] * e[0]) / den; u = (a[0] * d[1] - a[1] * d[0]) / den
        if t > 0 and -1e-9 <= u <= 1 + 1e-9: best = max(best, t)
    return best

def subdiv(obj, levels=1):
    md = obj.modifiers.new('sub', 'SUBSURF'); md.levels = levels; md.render_levels = levels
    dg = bpy.context.evaluated_depsgraph_get(); me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    obj.modifiers.remove(md); old = obj.data; obj.data = me; bpy.data.meshes.remove(old)

def new_obj(name, me, rig=None):
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    if rig:
        o.parent = rig; md = o.modifiers.new('Armature', 'ARMATURE'); md.object = rig
    return o

def smooth_shade(me):
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons)); me.update()
