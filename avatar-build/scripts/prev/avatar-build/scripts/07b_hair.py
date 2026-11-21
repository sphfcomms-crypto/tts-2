# Optional fitted CC-BY Elvaerwyn hair. Trial styles selected by actual rendered comparisons.
import bpy,numpy as np,sys,os,glob,math
from mathutils import Vector
sys.path.insert(0,'/project/build/scripts');import rlib
R='/project/avatar-build/';tag=sys.argv[-1];D=R+'assets/hair/'+tag+'/';S=bpy.context.scene;rig=bpy.data.objects['Armature'];bpy.data.objects.remove(bpy.data.objects['CentrePartHair'],do_unlink=True)
with bpy.data.libraries.load('/project/build/out/stage1.blend') as (src,dst):dst.objects=['Body']
ob=dst.objects[0];cp=np.array([v.co[:] for v in ob.data.vertices]);bpy.data.objects.remove(ob);dx=abs(cp[5399,0]-cp[11998,0])/1.398;dy=abs(cp[791,2]-cp[881,2])/2.205;dz=abs(cp[962,1]-cp[5320,1])/1.846;V=[];F=[];UV=[];vt=[];FILENAME=glob.glob(D+'*.mhclo')[0];lines=open(FILENAME).read().split('verts 0',1)[1].strip().splitlines();
for l in lines:
 q=l.split();
 if not q:continue
 if len(q)==1 and q[0].isdigit():a=cp[int(q[0])].copy()
 elif len(q)==9 and q[0].isdigit():
  a=np.array(q[3:6],float)@cp[np.array(q[:3],int)];x,y,z=map(float,q[6:]);a+=np.array([dx*x,-dz*z,dy*y]);
 else:break
 # Comb low lengths around, rather than through, the shoulder; preserve the asset's authored hairline.
 h=np.clip((1.46-a[2])/.18,0,1);a[1]+=h*.14;a[0]*=1-.10*h;a[2]-=.055*h;V.append(a)
for l in open(glob.glob(D+'*.obj')[0]):
 s=l.split();
 if not s:continue
 if s[0]=='vt':vt.append(tuple(map(float,s[1:3])))
 if s[0]=='f':
  ids=[p.split('/') for p in s[1:]];F.append([int(p[0])-1 for p in ids]);UV.append([vt[int(p[1])-1] for p in ids])
me=bpy.data.meshes.new('FittedStrandCards');me.from_pydata(V,[],F);me.update();o=bpy.data.objects.new('CentrePartHair',me);S.collection.objects.link(o);uv=me.uv_layers.new();
for p,xy in zip(me.polygons,UV):
 p.use_smooth=True
 for li,co in zip(p.loop_indices,xy):uv.data[li].uv=co
m=rlib.img_mat('Brunette strands',bpy.data.images.load(D+'black.png'),rough=.47,spec=.33,alpha_from_image=True,normal=bpy.data.images.load(D+'hairnormals.png'));m.node_tree.nodes['Normal Map'].inputs['Strength'].default_value=.22;me.materials.append(m);o.parent=rig;gr=o.vertex_groups.new(name='mixamorig:Head');gr.add(list(range(len(V))),1,'REPLACE');md=o.modifiers.new('Skeleton','ARMATURE');md.object=rig
rlib.save(R+tag+'.blend');rlib.setup_cycles(S,(620,620),24);rlib.setup_studio(S,Vector((0,-.03,1.36)));rlib.shoot(S,R+'renders/'+tag+'.jpg',(0,-.86,1.486),(0,-.065,1.469),lens=83);print('hair',len(V),len(F))
