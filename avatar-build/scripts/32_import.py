# 32_import.py - import the exported GLB into an empty Blender and save it, to render the check shots from the file itself.
#   blender -b --factory-startup --python 32_import.py -- avatar.glb OUT.blend
import bpy, sys
sys.path.insert(0, '/project/w/s'); import alib
a = alib.args()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=a[0])
for o in bpy.data.objects:
    if o.type == 'MESH':
        sk = o.data.shape_keys
        print("IMPORTED", o.name, "tris", sum(len(f.vertices) - 2 for f in o.data.polygons), "keys", (len(sk.key_blocks) - 1) if sk else 0, "mats", [m.name for m in o.data.materials])
    elif o.type == 'ARMATURE': print("IMPORTED armature", o.name, "bones", len(o.data.bones))
bpy.ops.wm.save_as_mainfile(filepath=a[1])
