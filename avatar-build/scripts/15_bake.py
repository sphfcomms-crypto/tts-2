# 15_bake.py - project the aligned photo from the front onto the fitted head and bake it into the body UVs, together with
# blend masks (R photo weight, G scalp, B lips) and the shine map.   blender -b fit.blend --python 15_bake.py -- PREFIX TEXDIR OUT.blend
import bpy, sys, json, numpy as np
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); prefix, T_, outb = a[0], a[1], a[2]
sc = bpy.context.scene; B = bpy.data.objects['Body']; me = B.data; n = len(me.vertices)
info = json.load(open(prefix + '_info.json')); LT = np.load(prefix + '_lmT.npy'); res = info['res']
p = alib.co(me.vertices, n)
nr = np.empty(n * 3, np.float32); me.vertices.foreach_get('normal', nr); nr = nr.reshape(-1, 3)
def sstep(v, a, b):
    t = np.clip((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
zchin = alib.OCZ + (0.5 - LT[152][1] / res) * alib.OSIZE
gi = {g.name: g.index for g in B.vertex_groups}
ears = np.zeros(n, np.float32); scalp = np.zeros(n, np.float32); lips = np.zeros(n, np.float32)
for v in me.vertices:
    for g in v.groups:
        if g.group == gi['ears']: ears[v.index] = g.weight
        elif g.group == gi['scalp']: scalp[v.index] = g.weight
        elif g.group == gi['lips']: lips[v.index] = g.weight
ed = np.array([e.vertices[:] for e in me.edges], dtype=np.int64)
def smooth(x, it):
    x = x.copy()
    for _ in range(it):
        acc = x.copy(); cnt = np.ones(n, np.float32)
        np.add.at(acc, ed[:, 0], x[ed[:, 1]]); np.add.at(acc, ed[:, 1], x[ed[:, 0]]); np.add.at(cnt, ed[:, 0], 1); np.add.at(cnt, ed[:, 1], 1)
        x = acc / cnt
    return x
def dilate(x, it):
    x = x.copy()
    for _ in range(it):
        y = x.copy(); np.maximum.at(y, ed[:, 0], x[ed[:, 1]]); np.maximum.at(y, ed[:, 1], x[ed[:, 0]]); x = y
    return x
head = sstep(p[:, 2], 1.33, 1.345) * (np.abs(p[:, 0]) < 0.125)
face = sstep(-nr[:, 1], 0.30, 0.62)
gate = sstep(p[:, 2], zchin - 0.028, zchin - 0.004)
ylip = p[lips > 0.5][:, 1].min(); zm = p[lips > 0.5][:, 2].mean()
inner = (np.abs(p[:, 0]) < 0.035) & (np.abs(p[:, 2] - zm) < 0.022) & (p[:, 1] > ylip + 0.012)
mask = face * gate * head * (1 - np.clip(dilate(ears, 1), 0, 1)); mask[inner] = 0
mask = smooth(mask, 2); mask[inner] = 0
print("zchin", zchin, "ylip", ylip, "zmouth", zm, "mask verts", int((mask > 0.5).sum()), "inner", int(inner.sum()))
col = np.c_[mask, smooth(scalp, 2), smooth(lips, 1), np.ones(n)].astype(np.float32)
at = me.color_attributes.new('bk', 'FLOAT_COLOR', 'POINT'); at.data.foreach_set('color', col.ravel())
uv0 = me.uv_layers[0].name
uvl = me.uv_layers.new(name='proj')
li = np.empty(len(me.loops), np.int32); me.loops.foreach_get('vertex_index', li)
uv = np.c_[(p[li, 0] - alib.OCX) / alib.OSIZE + 0.5, (p[li, 2] - alib.OCZ) / alib.OSIZE + 0.5].astype(np.float32)
uvl.data.foreach_set('uv', uv.ravel())
me.uv_layers.active = me.uv_layers[uv0]; me.uv_layers[uv0].active_render = True
m = bpy.data.materials.new('bk'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission'); nt.links.new(em.outputs[0], out.inputs[0])
uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'proj'
tex = nt.nodes.new('ShaderNodeTexImage'); tex.extension = 'EXTEND'; nt.links.new(uvn.outputs[0], tex.inputs[0])
att = nt.nodes.new('ShaderNodeAttribute'); att.attribute_name = 'bk'; att.attribute_type = 'GEOMETRY'
dst = nt.nodes.new('ShaderNodeTexImage')
old = list(me.materials); me.materials.clear(); me.materials.append(m)
alib.setup_cycles(sc, (512, 512), 4, denoise=False)
for o in bpy.data.objects: o.select_set(False)
B.select_set(True); bpy.context.view_layer.objects.active = B
sc.render.bake.margin = 24; sc.render.bake.use_clear = True
def bake(src, name, size, cs):
    for l in list(em.inputs[0].links): nt.links.remove(l)
    nt.links.new(src, em.inputs[0])
    im = bpy.data.images.new(name, size, size, alpha=False); im.colorspace_settings.name = cs
    dst.image = im; nt.nodes.active = dst
    bpy.ops.object.bake(type='EMIT')
    im.filepath_raw = T_ + '/' + name + '.png'; im.file_format = 'PNG'; im.save(); print("BAKED", name)
tex.image = bpy.data.images.load(T_ + '/proj_photo.png'); bake(tex.outputs['Color'], 'bk_photo', 4096, 'sRGB')
bake(att.outputs['Color'], 'bk_mask', 2048, 'Non-Color')
tex.image = bpy.data.images.load(T_ + '/proj_shine.png'); tex.image.colorspace_settings.name = 'Non-Color'; bake(tex.outputs['Color'], 'bk_shine', 2048, 'Non-Color')
me.materials.clear()
for mm in old: me.materials.append(mm)
me.uv_layers.remove(me.uv_layers['proj']); me.color_attributes.remove(me.color_attributes['bk'])
alib.save(outb)
