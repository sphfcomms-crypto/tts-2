# 27_trim.py - delete the body faces that are fully hidden under the clothes (keeps head, neck, upper chest inside the
# neckline, hands and wrists, ankles and feet), export the kept faces' UV polygons for the skin clean-up, and put the
# shoe soles on z = 0.     blender -b hair.blend --python 27_trim.py -- OUT.blend
import bpy, bmesh, sys, numpy as np
sys.path.insert(0, '/project/w/s'); import alib, glib
a = alib.args(); rig = bpy.data.objects['Armature']; B = bpy.data.objects['Body']; bn = rig.data.bones; BONES = [b.name for b in bn]
me = B.data; nb = len(me.vertices); p = alib.co(me.vertices, nb); W = glib.weights(B, set(BONES))
def wsum(keys): return sum((W[k] for k in W if any(s in k for s in keys)), np.zeros(nb, np.float32))
isarm = (wsum(['Arm']) + wsum(['Hand'])) > 0.5
ell = (p[:, 0] / 0.080) ** 2 + ((p[:, 1] + 0.025) / 0.062) ** 2
keep = (W['Head'] > 0.01) | (p[:, 2] > 1.40) | ((~isarm) & (p[:, 2] > 1.235) & (ell < 2.4)) | ((p[:, 2] < 0.125) & ~isarm)
for side, s in (('Left', 1), ('Right', -1)):
    wr = np.array(bn[side + 'Hand'].head_local); el = np.array(bn[side + 'ForeArm'].head_local); fd = (wr - el) / np.linalg.norm(wr - el); cp = wr - fd * 0.012
    keep |= isarm & (p[:, 0] * s > 0) & (((p - cp) @ fd) > -0.045)
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context='VERTS'); bm.to_mesh(me); bm.free(); me.update()
print("BODY verts", nb, "->", len(me.vertices), "tris", sum(len(f.vertices) - 2 for f in me.polygons), "keys", len(me.shape_keys.key_blocks))
uv = me.uv_layers[0].data; polys = np.empty(len(me.polygons), dtype=object)
for f in me.polygons: polys[f.index] = np.array([uv[li].uv[:] for li in f.loop_indices], np.float32)
np.save('/project/w/out/body_uv_polys.npy', polys, allow_pickle=True)
zmin = min(float(alib.co(o.data.vertices, len(o.data.vertices))[:, 2].min()) for o in bpy.data.objects if o.type == 'MESH')
dz = -zmin
for o in bpy.data.objects:
    if o.type == 'MESH':
        d = np.zeros((len(o.data.vertices), 3), np.float32); d[:, 2] = dz; alib.add_delta(o.data, d)
bpy.context.view_layer.objects.active = rig; bpy.ops.object.mode_set(mode='EDIT')
for eb in rig.data.edit_bones: eb.head.z += dz; eb.tail.z += dz
bpy.ops.object.mode_set(mode='OBJECT')
print("GROUND shift", dz)
alib.save(a[0])
