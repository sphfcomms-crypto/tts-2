# t_brows.py - render every installed eyebrow asset on the stage1 face to pick one
import bpy, os, sys, glob
from mathutils import Vector
sys.path.insert(0, '/project/build/scripts')
import rlib
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.locationservice import LocationService
UD = LocationService.get_user_data()
sc = bpy.context.scene
bm = bpy.data.objects['Body']
old = bpy.data.objects['Eyebrows']; old.hide_render = True
eyes = bpy.data.objects['Eyes']
z = sum((v.co.z for v in eyes.data.vertices)) / len(eyes.data.vertices)
rlib.setup_cycles(sc, (520, 260), 32)
rlib.setup_studio(sc, center=Vector((0, 0, z - 0.1)))
hm = bpy.data.materials['BrowLash']
for p in sorted(glob.glob(UD + '/eyebrows/mindfront_eyebrows_*/*.mhclo')):
    o = HumanService.add_mhclo_asset(p, bm, asset_type="Eyebrows", subdiv_levels=0, material_type="MAKESKIN", set_up_rigging=False, interpolate_weights=False, import_subrig=False, import_weights=False)
    o.data.materials.clear(); o.data.materials.append(hm)
    n = os.path.basename(p)[19:21]
    rlib.shoot(sc, '/project/build/renders/brow_%s.jpg' % n, (0, -1.2, z + 0.01), (0, 0, z + 0.012), lens=300)
    bpy.data.objects.remove(o)
