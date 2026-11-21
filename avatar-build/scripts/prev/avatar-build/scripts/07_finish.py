# Corrections from Cycles test renders. Run from refined scene. Preserve cloth topology during relaxation.
import bpy,sys,os,math,bmesh,numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from math import sin,cos,pi
sys.path.insert(0,'/project/build/scripts');import rlib
R='/project/avatar-build/';S=bpy.context.scene;rig=bpy.data.objects['Armature'];rig.data.pose_position='REST';bpy.context.view_layer.update()
sc=bpy.data.objects['ChiffonDupatta'];tun=bpy.data.objects['Kameez'];yo=bpy.data.objects['KameezYoke'];body=bpy.data.objects['Body'];
# Keep the yoke only under sleeves. It must not form an irregular second neckline.
bm=bmesh.new();bm.from_mesh(yo.data);bmesh.ops.delete(bm,geom=[v for v in bm.verts if abs(v.co.x)<.115],context='VERTS');bm.to_mesh(yo.data);bm.free()
with bpy.data.libraries.load(R+'wardrobe.blend') as (s,d):d.objects=['ChiffonDupatta']
old=d.objects[0];P=np.array([v.co[:] for v in old.data.vertices]);bpy.data.objects.remove(old);N=25;tree=BVHTree.FromObject(tun,bpy.context.evaluated_depsgraph_get());
for v,p in zip(sc.data.vertices,P):
 x,y,z=p;j=v.index//N;i=v.index%N;shoulder=float(np.clip((z-1.23)/.08,0,1));front=max(-y,0);back=max(y,0);p[2]+=.014*shoulder;p[1]+=.008*np.tanh((y+.014)*21);p[1]-=.008*min(1,front/.08);p[1]+=.008*min(1,back/.06);p[0]+=.004*sin(j/25)*cos(i*.12);p[1]+=.003*cos(i*.53+j*.058);p[2]+=.0025*sin(j*.14+i*.43);v.co=p
# Discrete collision clearance of darted chiffon before a short, pinned simulation. Evaluate without thickness / rig for stable vertex correspondence.
for o in [sc,tun,yo]:
 for m in o.modifiers:
  if m.type in ('SOLIDIFY','ARMATURE'):m.show_viewport=False
for o in [sc,tun,yo]:o.data.update()
bpy.context.view_layer.update()
for name in ['Kameez','LeftSleeve','RightSleeve','LeftShalwar','RightShalwar','ChiffonDupatta']:
 o=bpy.data.objects[name];orig=np.array([v.co[:] for v in o.data.vertices]);pin=o.vertex_groups.get('Sewing pins') or o.vertex_groups.new(name='Sewing pins');z=orig[:,2]
 for v in o.data.vertices:pin.add([v.index],.98 if v.co.z>np.quantile(z,.84) else .7,'REPLACE')
 # Rest fitting against posed-neutral body (scarf against kameez too).
 coll=[body]+([tun] if o==sc else []);
 for c in coll:c.modifiers.new('Drape against body','COLLISION')
 md=o.modifiers.new('Pattern settle','CLOTH');md.settings.mass=.09;md.settings.quality=5;md.settings.time_scale=.2;md.settings.vertex_group_mass=pin.name;md.settings.pin_stiffness=18;md.collision_settings.distance_min=.0015;md.point_cache.frame_end=4;S.frame_set(1)
 for frame in [2,3,4]:S.frame_set(frame);bpy.context.view_layer.update()
 ev=o.evaluated_get(bpy.context.evaluated_depsgraph_get());fit=np.array([v.co[:] for v in ev.data.vertices]);o.modifiers.remove(md);S.frame_set(1)
 if len(orig)==len(fit):
  delta=fit-orig;delta*=np.minimum(1,.003/np.maximum(1e-9,np.linalg.norm(delta,axis=1)))[:,None];o.data.vertices.foreach_set('co',np.float32(orig+delta*.72).ravel());o.data.update()
 for c in coll:c.modifiers.remove(c.modifiers['Drape against body'])
for o in [sc,tun,yo]:
 for m in o.modifiers:m.show_viewport=True
# Center-front slit with an embroidered placket: displace only the upper-front hem, keep lower skirt untouched.
for v in tun.data.vertices:
 x,y,z=v.co
 if y<-.032 and z>1.252:v.co.z-=.034*math.exp(-(x/.014)**2)*np.clip((z-1.252)/.03,0,1)
# Breastbone-driven lapel embroidery laid directly on the garment surface; an open inverted-V at the end of slit.
def trimcurve(name,points,thick,material,bone):
 cu=bpy.data.curves.new(name,'CURVE');cu.dimensions='3D';cu.resolution_u=2;cu.bevel_depth=thick;cu.bevel_resolution=1;sp=cu.splines.new('POLY');sp.points.add(len(points)-1)
 for p,co in zip(sp.points,points):p.co=(*co,1)
 o=bpy.data.objects.new(name,cu);S.collection.objects.link(o);o.data.materials.append(material);bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.convert(target='MESH');o=bpy.context.object;o.parent=rig;g=o.vertex_groups.new(name='mixamorig:'+bone);g.add(list(range(len(o.data.vertices))),1,'REPLACE');m=o.modifiers.new('Skeleton','ARMATURE');m.object=rig;return o
thread=rlib.img_mat('Cream silk embroidery',color=(.70,.56,.38,1),rough=.66);ring=[v.co.copy() for v in tun.data.vertices[-96:]];trimcurve('NeckBinding',ring+[ring[0]],.0015,thread,'Spine2')
# Add real sole welts and vamp embroidery to the slippers.
for side,sg in [('Left',1),('Right',-1)]:
 sh=bpy.data.objects[side+'Khussa'];P=[v.co.copy() for v in sh.data.vertices];pts=P[2*56:3*56];trimcurve(side+'SoleWelt',pts+[pts[0]],.0017,thread,side+'Foot');j=9;pts=P[j*56:(j+1)*56];trimcurve(side+'VampTrim',pts+[pts[0]],.0011,thread,side+'Foot')
# Relax the groom trajectories and fan rear cards over the occiput without splitting it into two curtains.
h=bpy.data.objects['CentrePartHair'];a=np.array([v.co[:] for v in h.data.vertices]).reshape(-1,31,2,3);rng=np.random.default_rng(553)
for i,row in enumerate(a):
 side=-1 if i<len(a)//2 else 1;idx=(i%73)/72;mid=row.mean(1);w=row[:,1]-row[:,0];root=mid[0].copy();phase=rng.uniform(0,6);v=rng.uniform(-1,1)
 for j in range(1,30):
  t=j/30;mid[j,1]+=.003*sin(t*pi*2+phase)*sin(t*pi);mid[j,0]+=side*(.004*sin(pi*t)+.002*sin(phase+2*pi*t)*sin(pi*t));mid[j,2]+=.003*sin(pi*t*2)*v
 # Closing the nape part by spreading the inner rows horizontally down the back.
 for j in range(16,31):
  t=(j-16)/14;mid[j,0]-=side*(.017+v*.014)*idx**2.3*t;mid[j,1]+=.010*idx*sin(pi*t)
 for _ in range(4):mid[1:-1]=.23*mid[:-2]+.54*mid[1:-1]+.23*mid[2:]
 # Wisp variation at the anterior hairline; soften the straight center edge.
 for j in range(8):mid[j,1]-=.003*(1-j/8)*max(0,1-idx*5)*(1+v*.65)
 row[:,0]=mid-w/2;row[:,1]=mid+w/2
h.data.vertices.foreach_set('co',a.astype('f').ravel());h.data.update();
# Soften expression and avoid the wide-eyed neutral. Pin default smile at 6% rather than an open mouth.
for ob in S.objects:
 if ob.type=='MESH' and ob.data.shape_keys:
  for n,val in [('eyeBlinkLeft',.10),('eyeBlinkRight',.10),('mouthSmileLeft',.06),('mouthSmileRight',.06)]:
   k=ob.data.shape_keys.key_blocks.get(n)
   if k:k.value=val
rig.data.pose_position='POSE';bpy.context.view_layer.update();rlib.save('/project/scene.blend')
