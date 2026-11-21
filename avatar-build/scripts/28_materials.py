# 28_materials.py - final glTF-friendly materials: Principled BSDF + image textures only (base colour, normal, roughness,
# alpha for hair); tiling detail through a Mapping node (exported as KHR_texture_transform).
#   blender -b trimmed.blend --python 28_materials.py -- OUT.blend
import bpy, sys, os
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); T = '/project/w/tex/'
def img(name, cs='sRGB'):
    im = bpy.data.images.load(T + name); im.colorspace_settings.name = cs; return im
def mat(name, color=None, base=(0.8, 0.8, 0.8, 1), rough=0.8, rough_img=None, normal=None, nstr=1.0, cscale=None, nscale=None, alpha=False, metallic=0.0, spec=None, sss=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = base; b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metallic
    if spec is not None: b.inputs['Specular IOR Level'].default_value = spec
    def tex(image, scale, loc):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image; t.location = loc
        if scale:
            tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping'); mp.vector_type = 'POINT'
            mp.inputs['Scale'].default_value = (scale[0], scale[1], 1); tc.location = (loc[0] - 500, loc[1]); mp.location = (loc[0] - 250, loc[1])
            nt.links.new(tc.outputs['UV'], mp.inputs['Vector']); nt.links.new(mp.outputs['Vector'], t.inputs['Vector'])
        return t
    if color is not None:
        t = tex(color, cscale, (-450, 350)); nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        if alpha:
            nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
            try: m.surface_render_method = 'BLENDED'
            except Exception: pass
    if rough_img is not None:
        t = tex(rough_img, None, (-450, 50)); nt.links.new(t.outputs['Color'], b.inputs['Roughness'])
    if normal is not None:
        t = tex(normal, nscale, (-650, -300)); nm = nt.nodes.new('ShaderNodeNormalMap'); nm.location = (-250, -300); nm.inputs['Strength'].default_value = nstr
        nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if sss > 0:
        b.inputs['Subsurface Weight'].default_value = sss; b.inputs['Subsurface Radius'].default_value = (1.0, 0.4, 0.25); b.inputs['Subsurface Scale'].default_value = 0.005
    return m
for m_ in list(bpy.data.materials):
    if m_.name.startswith('Skin'): m_.name = 'OldSkin'
def put(obj, m):
    o = bpy.data.objects[obj]; o.data.materials.clear(); o.data.materials.append(m)
cl = lambda n: n.replace('.', '_clean.')
put('Body', mat('Skin', img(cl('skin_color.jpg')), rough_img=img(cl('skin_rough.png'), 'Non-Color'), normal=img('skin_normal_clean.jpg', 'Non-Color'), nstr=0.6, sss=0.12))
wv = img('weave_normal.jpg', 'Non-Color')
put('Kameez', mat('Lawn', img('kameez_color.jpg'), rough=0.84, normal=wv, nstr=0.45, nscale=(46, 23), spec=0.3))
put('Shalwar', mat('LawnPlain', img('lawn_plain.jpg'), rough=0.84, normal=wv, nstr=0.45, nscale=(13, 13), spec=0.3))
put('Dupatta', mat('Chiffon', img('chiffon.jpg'), rough=0.72, normal=img('chiffon_normal.jpg', 'Non-Color'), nstr=0.5, nscale=(5, 4), spec=0.35))
put('Khussa', mat('Khussa', img('khussa.jpg'), rough=0.55, cscale=(2.5, 2.5)))
put('Jewellery', mat('Gold', base=(0.83, 0.60, 0.21, 1), rough=0.3, metallic=1.0))
put('Hair', mat('Hair', img('hair.png'), rough=0.42, normal=img('hair_normal.jpg', 'Non-Color'), nstr=0.9, alpha=True, spec=0.45))
bpy.data.objects['Eyelashes'].name = 'Lashes'
put('Lashes', mat('Lash', base=(0.012, 0.010, 0.009, 1), rough=0.5))
for n, r in (('Eyes', 0.1), ('Teeth', 0.3), ('Tongue', 0.4)):
    m = bpy.data.objects[n].data.materials[0]; m.name = n
    if r: m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = r
bpy.data.objects['Eyes'].data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Specular IOR Level'].default_value = 0.5
# resting expression baked into the neutral shape: faint friendly smile, slightly relaxed lids (all morph deltas unchanged)
import numpy as np
REST = {'mouthSmileLeft': 0.08, 'mouthSmileRight': 0.08, 'eyeBlinkLeft': 0.10, 'eyeBlinkRight': 0.10, 'cheekSquintLeft': 0.08, 'cheekSquintRight': 0.08}     # the photo-fitted mouth already carries her faint smile
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        kb = o.data.shape_keys.key_blocks; n = len(o.data.vertices); b0 = alib.co(kb[0].data, n).copy(); d = np.zeros_like(b0)
        for k, w in REST.items():
            if k in kb: d += w * (alib.co(kb[k].data, n) - b0)
        alib.add_delta(o.data, d)
for o in bpy.data.objects:
    if o.type == 'MESH': o.data.name = o.name
alib.save(a[0])
