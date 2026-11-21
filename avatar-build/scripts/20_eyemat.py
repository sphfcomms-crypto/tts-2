# 20_eyemat.py - eye material tweak + optional look.  blender -b IN.blend --python 20_eyemat.py -- EYE.png OUT.blend
import bpy, sys
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args()
m = bpy.data.objects['Eyes'].data.materials[0]; nt = m.node_tree
t = [n for n in nt.nodes if n.type == 'TEX_IMAGE'][0]; t.image = bpy.data.images.load(a[0])
b = nt.nodes['Principled BSDF']; b.inputs['Roughness'].default_value = 0.16; b.inputs['Specular IOR Level'].default_value = 0.35
alib.save(a[1])
