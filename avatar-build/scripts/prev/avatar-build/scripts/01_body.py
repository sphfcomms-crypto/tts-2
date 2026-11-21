# 01_body.py - MPFB2 human: macros, face detail targets, ARKit face units + visemes, rig, eyes/teeth/tongue/brows/lashes.
import bpy, os, sys, json, math
import numpy as np
from mathutils import Vector
sys.path.insert(0, '/project/build/scripts')
import rlib
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.faceservice import FaceService
from bl_ext.user_default.mpfb.services.locationservice import LocationService
from bl_ext.user_default.mpfb.entities.objectproperties import GeneralObjectProperties

OUT = '/project/build/out'
UD = LocationService.get_user_data()
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

macro = TargetService.get_default_macro_info_dict()
macro.update(gender=0.0, age=0.47, muscle=0.40, weight=0.46, proportions=0.62, height=0.42, cupsize=0.40, firmness=0.6)
macro['race'] = {'asian': 0.22, 'caucasian': 0.60, 'african': 0.18}
bm = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                               feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
bm.name = "Body"
print("BASEMESH", bm.name, len(bm.data.vertices))

details = json.load(open('/project/build/scripts/face_details.json'))
stack = []
for k, v in details.items():
    if k.startswith('lr-'):
        stack.append({'target': 'l-' + k[3:], 'value': v}); stack.append({'target': 'r-' + k[3:], 'value': v})
    else:
        stack.append({'target': k, 'value': v})
TargetService.bulk_load_targets(bm, stack)
print("KEYS before bake", len(bm.data.shape_keys.key_blocks))
TargetService.bake_targets(bm)

# ARKit face units + Meta/Oculus visemes as shape keys
FaceService.load_targets(bm, load_microsoft_visemes=False, load_meta_visemes=True, load_arkit_faceunits=True)
kbs = bm.data.shape_keys.key_blocks
print("FACE KEYS", len(kbs) - 1)

# scale to 1.60 m (body group only for measurement)
n = len(bm.data.vertices)
co = np.empty(n * 3, dtype=np.float32); bm.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
h = co[:13380, 2].max() - co[:13380, 2].min()
s = 1.60 / h
print("HEIGHT native", h, "scale", s)
for kb in kbs:
    a = np.empty(n * 3, dtype=np.float32); kb.data.foreach_get('co', a); kb.data.foreach_set('co', a * s)
bm.data.vertices.foreach_set('co', (co * s).ravel())
bm.data.update()
sf = GeneralObjectProperties.get_value("scale_factor", entity_reference=bm) or 0.1
GeneralObjectProperties.set_value("scale_factor", sf * s, entity_reference=bm)

rig = HumanService.add_builtin_rig(bm, "mixamo", import_weights=True)
rig.name = "Armature"
print("RIG", rig.name, len(rig.data.bones))

def add(kind, frag):
    p = os.path.join(UD, frag)
    o = HumanService.add_mhclo_asset(p, bm, asset_type=kind, subdiv_levels=0, material_type="MAKESKIN",
                                     set_up_rigging=True, interpolate_weights=True, import_subrig=False, import_weights=True)
    print("ADDED", kind, o.name, len(o.data.vertices))
    return o
cfg = json.load(open('/project/build/scripts/assets.json'))
eyes = add("Eyes", "eyes/high-poly/high-poly.mhclo"); eyes.name = "Eyes"
teeth = add("Teeth", "teeth/teeth_base/teeth_base.mhclo"); teeth.name = "Teeth"
tongue = add("Tongue", "tongue/tongue01/tongue01.mhclo"); tongue.name = "Tongue"
brows = add("Eyebrows", cfg['eyebrows']); brows.name = "Eyebrows"
lashes = add("Eyelashes", cfg['eyelashes']); lashes.name = "Eyelashes"
FaceService.interpolate_targets(bm)
for o in (eyes, teeth, tongue, brows, lashes):
    sk = o.data.shape_keys
    print("CHILD KEYS", o.name, (len(sk.key_blocks) - 1) if sk else 0, [m.type for m in o.modifiers], [g.name for g in o.vertex_groups][:6])

# materials: plain Principled + image textures (glTF friendly)
skin_png = os.path.join(UD, cfg['skin'])
img = bpy.data.images.load(skin_png)
print("SKIN", img.size[:])
m = rlib.img_mat("Skin", img, rough=0.5, sss=0.08)
bm.data.materials.clear(); bm.data.materials.append(m)

# eyes: drop the transparent cornea shell (texture alpha == 0 there) so the eyeball is one opaque surface
eimg = bpy.data.images.load(os.path.join(UD, 'eyes/materials/brown_eye.png'))
W, H = eimg.size
px = np.array(eimg.pixels[:], dtype=np.float32).reshape(H, W, 4)
me = eyes.data
uv = me.uv_layers.active.data
kill = []
for poly in me.polygons:
    us = [uv[li].uv for li in poly.loop_indices]
    u = sum(x[0] for x in us) / len(us); v = sum(x[1] for x in us) / len(us)
    a = px[min(H - 1, max(0, int(v * H))), min(W - 1, max(0, int(u * W))), 3]
    if a < 0.5:
        kill.append(poly.index)
print("EYE faces", len(me.polygons), "transparent", len(kill))
import bmesh
b = bmesh.new(); b.from_mesh(me); b.faces.ensure_lookup_table()
bmesh.ops.delete(b, geom=[b.faces[i] for i in kill], context='FACES')
b.to_mesh(me); b.free()
em = rlib.img_mat("Eyes", eimg, rough=0.08, spec=0.6)
me.materials.clear(); me.materials.append(em)
timg = bpy.data.images.load('/project/build/tex/teeth.png')
teeth.data.materials.clear(); teeth.data.materials.append(rlib.img_mat("Teeth", timg, rough=0.25))
gimg = bpy.data.images.load('/project/build/tex/tongue.png')
tongue.data.materials.clear(); tongue.data.materials.append(rlib.img_mat("Tongue", gimg, rough=0.35))
hm = rlib.img_mat("BrowLash", None, rough=0.45, color=(0.012, 0.009, 0.008, 1))
for o in (brows, lashes):
    o.data.materials.clear(); o.data.materials.append(hm)
    print("TRIS", o.name, sum(len(p.vertices) - 2 for p in o.data.polygons))
print("BONES", [b.name for b in rig.data.bones])
print("BM MODS", [(m.name, m.type) for m in bm.modifiers])
print("BM VG", len(bm.vertex_groups), [g.name for g in bm.vertex_groups if not g.name.startswith('mixamorig')][:80])
rlib.save(OUT + '/stage1.blend')
print("SAVED stage1")
