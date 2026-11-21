# 11_ortho.py - flat orthographic front render of the head for landmarking.
#   blender -b IN.blend --python 11_ortho.py -- OUT.png [hide,objs]
import bpy, sys
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args(); sc = bpy.context.scene
for n in (a[1].split(',') if len(a) > 1 else []):
    o = bpy.data.objects.get(n)
    if o: o.hide_render = True
e = bpy.data.objects.get('Eyes')
if e:   # matte eyes so the iris is visible to the landmarker (no white-world reflection)
    b = e.data.materials[0].node_tree.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = 1.0; b.inputs['Specular IOR Level'].default_value = 0.0
alib.ortho_front(sc, a[0])
print("ORTHO", a[0])
