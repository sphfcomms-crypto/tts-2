# Final corrections from portfolio / facial pose QA, before export. Work from finish.blend, retain custom centre-part groom.
import bpy,bmesh,numpy as np,sys,os,math,random
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from math import sin,cos,pi
sys.path.insert(0,'/project/build/scripts');import rlib
S=bpy.context.scene;rig=bpy.data.objects['Armature'];B=bpy.data.objects['Body'];hair=bpy.data.objects['CentrePartHair'];R='/project/avatar-build/';sc=bpy.data.objects['ChiffonDupatta'];tun=bpy.data.objects['Kameez'];dg=bpy.context.evaluated_depsgraph_get()
# Seat the scarf onto the actual posed shoulder, not the neutral A-pose shoulder. Use a smoothed height field along the cloth to avoid sharp collision offsets.
trees=[BVHTree.FromObject(bpy.data.objects[n],dg) for n in ['Kameez','LeftSleeve','RightSleeve','KameezYoke','Body']];sc.modifiers.get('Chiffon edge').show_viewport=False;bpy.context.view_layer.update();ev=sc.evaluated_get(bpy.context.evaluated_depsgraph_get());P=np.array([v.co[:] for v in ev.data.vertices]);dz=np.zeros(len(P));N=25
for i,(x,y,z) in enumerate(P):
 if z<1.263 or abs(y)>.10 or abs(x)<.055:continue
 hits=[tree.ray_cast((x,y,1.365),(0,0,-1))[0] for tree in trees];zz=max([v.z for v in hits if v and v.z>1.21] or [z]);fac=np.clip((z-1.263)/.055,0,1);dz[i]=np.clip(zz+.003-z,-.025,.020)*fac
A=dz.reshape(-1,N)
for i in range(4):A[1:-1,1:-1]=.40*A[1:-1,1:-1]+.15*(A[:-2,1:-1]+A[2:,1:-1]+A[1:-1,:-2]+A[1:-1,2:])
for v in sc.data.vertices:
 j,u=divmod(v.index,N);s=j/(len(A)-1);f=(sin(pi*min(1,max(0,(s-.26)/.48))))**2;sh=np.clip((v.co.z-1.265)/.035,0,1);v.co.z+=max(0,dz[v.index])+.006*sh-.009*f*(1+.45*sin(j*.07+u*.13));v.co.y-=.005*f*(.7+sin(j*.075+u*.49));v.co.x+=.003*f*cos(j*.05+u*.20)
sc.modifiers.get('Chiffon edge').show_viewport=True
# Contiguous round sleeve caps bridge the shoulder seam, inheriting the circumference weights exactly.
for side in ['Left','Right']:
 o=bpy.data.objects[side+'Sleeve'];me=o.data;bm=bmesh.new();bm.from_mesh(me);bm.verts.ensure_lookup_table();ring=[bm.verts[len(me.vertices)-48+i] for i in range(48)];face=bm.faces.new(ring);face.smooth=True;bm.normal_update();bm.to_mesh(me);bm.free()
 # Shoe profile with a thinner hand-turned toe, reduced height over the forefoot.
 sh=bpy.data.objects[side+'Khussa'];sg=1 if side=='Left' else -1
 for nm in [side+'Khussa',side+'VampTrim',side+'SoleWelt']:
  o=bpy.data.objects[nm]
  for v in o.data.vertices:
   t=np.clip((-v.co.y-.075)/.13,0,1);v.co.z=max(.001,v.co.z*(1-.38*t));v.co.x=sg*.165+(v.co.x-sg*.165)*(1-.18*t*t)
 # Vary the shalwar hem and ankle gathers along its circumference.
 o=bpy.data.objects[side+'Shalwar'];
 for v in o.data.vertices:
  x,y,z=v.co;t=np.clip((z-.07)/.24,0,1);g=sin(pi*t)**1.5;phi=np.arctan2(y+.018,abs(x)-.163);rr=(.006*cos(32*t+3*phi)+.003*sin(49*t-2*phi))*g;v.co.x+=sg*rr*cos(phi);v.co.y+=rr*sin(phi);v.co.z+=.009*g*sin(3*phi+4*t)
# Cull the skin inside the covered length of the forearm near cuffs.
bm=bmesh.new();bm.from_mesh(B.data);kill=[]
a=Vector((.424,-.159,.966));b=Vector((.314,-.023,1.086));axis=b-a
for v in bm.verts:
 p=Vector((abs(v.co.x),v.co.y,v.co.z));t=(p-a).dot(axis)/axis.length_squared
 if .055<t<.98 and (p-(a+t*axis)).length<.07:kill.append(v)
bmesh.ops.delete(bm,geom=kill,context='VERTS');bm.to_mesh(B.data);bm.free()
# Reduce duplicate internal hair strips, then add differently spaced fine flyaways on top. Geometry and opacity both taper at the ends.
a=np.array([v.co[:] for v in hair.data.vertices]).reshape(-1,31,2,3);rng=np.random.default_rng(9901);V=[];F=[];UV=[];center=Vector((0,-.044,1.492));
for i,row in enumerate(a):
 if i%5==3:continue
 extra=i%7==0;strand=i%73;sg=-1 if i<len(a)//2 else 1;mid=row.mean(1);w=row[:,1]-row[:,0]
 for typ in range(1+extra):
  p=mid.copy();width=w.copy();phase=rng.uniform(0,6);fac=rng.uniform(.7,1.15)
  for j in range(31):
   t=j/30;# Shift the temple transition slightly back and expose earrings.
   p[j,0]-=sg*.035*max(0,(strand/72-.70)/.30)**2*min(1,t/.48);p[j,1]+=.009*(sin(pi*t)**3)*(1-strand/73);p[j,2]+=.004*sin(pi*t*2+phase)*sin(pi*t)*(1-strand/73)
   if typ:
    di=p[j]-np.array(center);di/=max(.001,np.linalg.norm(di));p[j]+=di*(.0018+.0018*sin(pi*t+phase))*sin(pi*t);p[j,0]+=sg*.002*sin(t*5+phase);p[j,1]+=.0012*sin(12*t+phase);width[j]*=.16*fac
   if strand<5 and j<17:p[j,1]-=.0015*(1-strand/5)*(j/17)*cos(phase)
  start=len(V);vs=np.stack([p-width*.5,p+width*.5],axis=1).reshape(-1,3);V.extend(vs.tolist())
  for j in range(30):
   k=start+2*j;F.append((k,k+1,k+3,k+2));UV.append(((0,1-j/30),(1,1-j/30),(1,1-(j+1)/30),(0,1-(j+1)/30)))
me=bpy.data.meshes.new('CombedHairCards');me.from_pydata(V,[],F);me.update();uv=me.uv_layers.new();
for f,us in zip(me.polygons,UV):
 f.use_smooth=True
 for li,co in zip(f.loop_indices,us):uv.data[li].uv=co
mat=hair.data.materials[0];me.materials.append(mat);hair.data=me;g=hair.vertex_groups.get('mixamorig:Head') or hair.vertex_groups.new(name='mixamorig:Head');g.add(list(range(len(V))),1,'REPLACE');bs=mat.node_tree.nodes['Principled BSDF'];bs.inputs['Roughness'].default_value=.64;bs.inputs['Specular IOR Level'].default_value=.19
# Reduce the brow ridge crease and mouth corner distortion of the extreme smile. Give SIL a genuine bilabial resting closure.
for ob in [B,bpy.data.objects['Teeth'],bpy.data.objects['Tongue']]:
 ks=ob.data.shape_keys.key_blocks;basis=np.array([v.co[:] for v in ks[0].data]);
 for nm in ['mouthSmileLeft','mouthSmileRight']:
  k=ks.get(nm)
  if k:
   arr=np.array([v.co[:] for v in k.data]);k.data.foreach_set('co',np.float32(basis+.68*(arr-basis)).ravel())
 if ob==B:
  close=np.array([v.co[:] for v in ks['mouthClose'].data])-basis;ks['viseme_sil'].data.foreach_set('co',np.float32(basis+.15*close).ravel());jaw=np.array([v.co[:] for v in ks['jawOpen'].data])-basis;ks['tongueOut'].data.foreach_set('co',np.float32(basis+.28*jaw).ravel())
 else:
  # At tongue extension open the jaw, including its lower dentition.
  k=ks.get('tongueOut');jaw=np.array([v.co[:] for v in ks['jawOpen'].data])-basis
  if k is None:k=ob.shape_key_add(name='tongueOut',from_mix=False)
  val=np.array([v.co[:] for v in k.data]);k.data.foreach_set('co',np.float32(val+.28*jaw).ravel())
# Bring corneal glints back without hard-coding catchlights into the iris texture.
e=bpy.data.objects['Eyes'].data.materials[0].node_tree.nodes['Principled BSDF'];e.inputs['Roughness'].default_value=.18;e.inputs['Specular IOR Level'].default_value=.33
# One face node: each named target acts on only its actual anatomy. Eye-gaze deltas are retained on the eyeball vertices. One Three.js influences dictionary for all facial material primitives.
for ob in [B,bpy.data.objects['Eyes'],bpy.data.objects['Teeth'],bpy.data.objects['Tongue'],bpy.data.objects['Eyebrows'],bpy.data.objects['Eyelashes']]:ob.select_set(False)
bpy.ops.object.select_all(action='DESELECT');
for nm in ['Body','Eyes','Teeth','Tongue','Eyebrows','Eyelashes']:bpy.data.objects[nm].select_set(True)
bpy.context.view_layer.objects.active=B;bpy.ops.object.join();B.data.name='FaceBody';B.name='Body';
# Reduce inner fabric surfaces / GPU vertices while preserving the outline, UV seams, hem and skin weights.
for name,ratio in [('Kameez',.75),('ChiffonDupatta',.82)]:
 o=bpy.data.objects[name];bpy.context.view_layer.objects.active=o;md=o.modifiers.new('Web surface reduction','DECIMATE');md.ratio=ratio;bpy.ops.object.modifier_move_to_index(modifier=md.name,index=0);bpy.ops.object.modifier_apply(modifier=md.name)
rlib.save('/project/scene.blend')
