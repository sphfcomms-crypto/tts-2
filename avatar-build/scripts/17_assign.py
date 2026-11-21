# 17_assign.py - skin material (base colour / normal / roughness images on a Principled BSDF), drop the brow mesh (brows are
# in the photo texture now), eye material.   blender -b IN.blend --python 17_assign.py -- TEXDIR OUT.blend
import bpy, sys
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); T = a[0]
B = bpy.data.objects['Body']
m = bpy.data.materials.new('Skin'); m.use_nodes = True; nt = m.node_tree; b = nt.nodes['Principled BSDF']
def tex(path, cs, loc):
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = bpy.data.images.load(path); t.image.colorspace_settings.name = cs; t.location = loc; return t
tc = tex(T + '/skin_color.jpg', 'sRGB', (-500, 300)); nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
tr = tex(T + '/skin_rough.png', 'Non-Color', (-500, 0)); nt.links.new(tr.outputs['Color'], b.inputs['Roughness'])
tn = tex(T + '/skin_normal.png', 'Non-Color', (-700, -300)); nm = nt.nodes.new('ShaderNodeNormalMap'); nm.location = (-300, -300)
nm.inputs['Strength'].default_value = 0.6
nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
b.inputs['Subsurface Weight'].default_value = 0.12; b.inputs['Subsurface Radius'].default_value = (1.0, 0.4, 0.25); b.inputs['Subsurface Scale'].default_value = 0.005
B.data.materials.clear(); B.data.materials.append(m)
o = bpy.data.objects.get('Eyebrows')
if o: bpy.data.objects.remove(o, do_unlink=True)
e = bpy.data.objects['Eyes'].data.materials[0].node_tree.nodes['Principled BSDF']
e.inputs['Roughness'].default_value = 0.12; e.inputs['Specular IOR Level'].default_value = 0.5
alib.save(a[1])
