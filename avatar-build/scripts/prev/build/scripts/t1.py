import bpy
from mathutils import Vector
bm = bpy.data.objects['Body']
print("GROUPS", [g.name for g in bm.vertex_groups if not g.name.startswith(('joint-', 'mixamorig', 'helper-'))])
rig = bpy.data.objects['Armature']
for n in ['mixamorig:Head', 'mixamorig:Neck', 'mixamorig:Spine2', 'mixamorig:Spine1', 'mixamorig:Spine', 'mixamorig:Hips', 'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase']:
    b = rig.data.bones[n]
    print(n, [round(x, 3) for x in b.head_local], [round(x, 3) for x in b.tail_local])
# joints
me = bm.data
def gcenter(name):
    gi = bm.vertex_groups[name].index
    vs = [v.co for v in me.vertices if any(g.group == gi for g in v.groups)]
    return sum(vs, Vector()) / len(vs), len(vs)
for n in ['joint-l-eye', 'joint-r-eye', 'joint-mouth', 'joint-jaw', 'joint-head', 'joint-head-2', 'joint-neck', 'helper-l-eye', 'helper-hair', 'helper-skirt', 'helper-tights']:
    try:
        c, k = gcenter(n); print(n, [round(x, 4) for x in c], k)
    except Exception as e:
        print(n, 'ERR', e)
print("UVS", [u.name for u in me.uv_layers], "polys", len(me.polygons), "mats", [m.name for m in me.materials])
co = [v.co for v in me.vertices[:13380]]
print("BODY bbox", [round(min(c[i] for c in co), 3) for i in range(3)], [round(max(c[i] for c in co), 3) for i in range(3)])
