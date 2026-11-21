# 02_skinbake.py - paint kajal / brow shadow / scalp underlay / lip tint as vertex masks and bake the final skin albedo.
import bpy, sys, os
import numpy as np
from mathutils import Vector, kdtree
sys.path.insert(0, '/project/build/scripts')
import rlib
T = '/project/build/tex/'
bm = bpy.data.objects['Body']; me = bm.data
NB = 13380
def kd_of(obj):
    kd = kdtree.KDTree(len(obj.data.vertices))
    for i, v in enumerate(obj.data.vertices): kd.insert(obj.matrix_world @ v.co, i)
    kd.balance(); return kd
kl = kd_of(bpy.data.objects['Eyelashes']); kb = kd_of(bpy.data.objects['Eyebrows'])
n = len(me.vertices)
col = np.zeros((n, 4), dtype=np.float32)
gi = {g.name: g.index for g in bm.vertex_groups}
for v in me.vertices[:NB]:
    p = bm.matrix_world @ v.co
    d = kl.find(p)[2]; col[v.index, 0] = max(0.0, 1.0 - d / 0.0038)
    d = kb.find(p)[2]; col[v.index, 1] = max(0.0, 1.0 - d / 0.008)
    for g in v.groups:
        if g.group == gi['scalp']: col[v.index, 2] = 1.0
        if g.group == gi['lips']: col[v.index, 3] = 1.0
# soften scalp + lips edges (2 smoothing passes over edges)
ed = np.array([e.vertices[:] for e in me.edges], dtype=np.int64)
for ch, it in ((2, 2), (3, 1), (0, 1)):
    for _ in range(it):
        acc = col[:, ch].copy(); cnt = np.ones(n, dtype=np.float32)
        np.add.at(acc, ed[:, 0], col[ed[:, 1], ch]); np.add.at(acc, ed[:, 1], col[ed[:, 0], ch])
        np.add.at(cnt, ed[:, 0], 1); np.add.at(cnt, ed[:, 1], 1)
        new = acc / cnt
        col[:, ch] = np.maximum(new, col[:, ch] * (0.6 if ch == 0 else 0.0)) if ch == 0 else new
at = me.color_attributes.get('paint') or me.color_attributes.new('paint', 'FLOAT_COLOR', 'POINT')
at.data.foreach_set('color', col.ravel())
# bake material
base = bpy.data.images.load(T + 'skin_base.png')
m = bpy.data.materials.new('SkinBake'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = base
att = nt.nodes.new('ShaderNodeAttribute'); att.attribute_name = 'paint'; att.attribute_type = 'GEOMETRY'
sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(att.outputs['Color'], sep.inputs[0])
def mix(a_out, colr, fac_out, strength, mode='MIX'):
    mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = mode
    mu = nt.nodes.new('ShaderNodeMath'); mu.operation = 'MULTIPLY'; mu.inputs[1].default_value = strength; mu.use_clamp = True
    nt.links.new(fac_out, mu.inputs[0]); nt.links.new(mu.outputs[0], mx.inputs['Factor'])
    nt.links.new(a_out, mx.inputs['A']); mx.inputs['B'].default_value = colr
    return mx.outputs['Result']
c = tex.outputs['Color']
c = mix(c, (0.80, 0.42, 0.42, 1), att.outputs['Alpha'], 0.45, 'MULTIPLY')      # lips: natural rose
c = mix(c, (0.45, 0.36, 0.32, 1), sep.outputs['Green'], 0.55, 'MULTIPLY')      # soft shadow under brow hairs
c = mix(c, (0.020, 0.013, 0.012, 1), sep.outputs['Red'], 0.60)                 # kajal along the lash lines
c = mix(c, (0.022, 0.017, 0.015, 1), sep.outputs['Blue'], 0.96)                # dark scalp under the hair
em = nt.nodes.new('ShaderNodeEmission'); nt.links.new(c, em.inputs['Color'])
out = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(em.outputs[0], out.inputs['Surface'])
bake = bpy.data.images.new('skin_final', 2048, 2048, alpha=False)
bt = nt.nodes.new('ShaderNodeTexImage'); bt.image = bake; nt.nodes.active = bt
me.materials.clear(); me.materials.append(m)
sc = bpy.context.scene
rlib.setup_cycles(sc, (512, 512), 4)
sc.cycles.use_denoising = False
for o in bpy.data.objects: o.select_set(False)
bm.select_set(True); bpy.context.view_layer.objects.active = bm
sc.render.bake.margin = 12
bpy.ops.object.bake(type='EMIT')
bake.filepath_raw = T + 'skin_final.png'; bake.file_format = 'PNG'; bake.save()
print("BAKED skin_final")
fin = bpy.data.images.load(T + 'skin_final.png'); nrm = bpy.data.images.load(T + 'skin_normal.png')
sm = rlib.img_mat("Skin", fin, rough=0.48, normal=nrm, sss=0.10)
sm.node_tree.nodes['Normal Map'].inputs['Strength'].default_value = 0.6
me.materials.clear(); me.materials.append(sm)
eye = bpy.data.images.load(T + 'eye.png')
bpy.data.materials['Eyes'].node_tree.nodes['Image Texture'].image = eye
# drop helper geometry (joint cubes, helper teeth/eyes/hair/skirt) now that rig and proxies exist
import bmesh
b = bmesh.new(); b.from_mesh(me); b.verts.ensure_lookup_table()
bmesh.ops.delete(b, geom=[v for v in b.verts if v.index >= NB], context='VERTS')
b.to_mesh(me); b.free()
for md in list(bm.modifiers):
    if md.type == 'MASK': bm.modifiers.remove(md)
for g in list(bm.vertex_groups):
    if g.name.startswith(('joint-', 'helper-')) or g.name in ('HelperGeometry', 'JointCubes'): bm.vertex_groups.remove(g)
print("BODY verts", len(me.vertices), "polys", len(me.polygons), "keys", len(me.shape_keys.key_blocks))
rlib.save('/project/build/out/stage2.blend')
print("SAVED stage2")
