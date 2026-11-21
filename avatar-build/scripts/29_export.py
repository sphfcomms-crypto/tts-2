# 29_export.py - export final.blend to a web GLB (+Y up, facing +Z, metres, no Draco, morph positions only) and write avatar.json.
#   blender -b final.blend --python 29_export.py -- OUT.glb OUT.json
import bpy, sys, json, numpy as np
sys.path.insert(0, '/project/w/s'); import alib, glib
a = alib.args(); rig = bpy.data.objects['Armature']
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        for kb in o.data.shape_keys.key_blocks: kb.value = 0
    if o.type in ('LIGHT', 'CAMERA'): bpy.data.objects.remove(o)
want = dict(filepath=a[0], export_format='GLB', export_yup=True, export_apply=False, export_skins=True, export_morph=True,
            export_morph_normal=False, export_morph_tangent=False, export_animations=False, export_cameras=False, export_lights=False,
            export_extras=False, export_image_format='AUTO', export_tangents=False, export_materials='EXPORT', export_try_sparse_sk=True,
            export_draco_mesh_compression_enable=False, use_selection=False, export_texcoords=True, export_normals=True)
props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
print("EXPORT args dropped:", [k for k in want if k not in props])
bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})
gl = lambda v: [round(float(v[0]), 4), round(float(v[2]), 4), round(float(-v[1]), 4)]
meshes = {}; zmax = 0.0; zmin = 9.0
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    p = alib.co(o.data.vertices, len(o.data.vertices)); zmax = max(zmax, float(p[:, 2].max())); zmin = min(zmin, float(p[:, 2].min()))
    meshes[o.name] = [kb.name for kb in o.data.shape_keys.key_blocks[1:]] if o.data.shape_keys else []
E = bpy.data.objects['Eyes']; eh = float(alib.co(E.data.vertices, len(E.data.vertices))[:, 2].mean())
B = bpy.data.objects['Body']; W = glib.weights(B); pb = alib.co(B.data.vertices, len(B.data.vertices)); mh = float(pb[W['lips'] > 0.5][:, 2].mean())
bones = {'hips': 'Hips', 'spine': 'Spine', 'spine1': 'Spine1', 'chest': 'Spine2', 'neck': 'Neck', 'head': 'Head',
         'leftShoulder': 'LeftShoulder', 'leftUpperArm': 'LeftArm', 'leftForearm': 'LeftForeArm', 'leftHand': 'LeftHand',
         'rightShoulder': 'RightShoulder', 'rightUpperArm': 'RightArm', 'rightForearm': 'RightForeArm', 'rightHand': 'RightHand'}
assert all(v in rig.data.bones for v in bones.values())
J = {'bones': bones, 'meshes': meshes, 'height': round(zmax, 4), 'eyeHeight': round(eh, 4), 'mouthHeight': round(mh, 4),
     'camera': {'position': [0, round(eh - 0.12, 3), 1.5], 'target': [0, round(eh - 0.17, 3), 0], 'fov': 30}}
json.dump(J, open(a[1], 'w'), indent=1)
print("JSON height", J['height'], "eye", J['eyeHeight'], "mouth", J['mouthHeight'], "zmin", zmin, "bones", len(rig.data.bones))
