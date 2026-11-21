# Blender 5.2, load stage2.blend first. Axis convention Blender forward -Y.
import bpy,bmesh,numpy as np,os,sys,math
from math import sin,cos,pi
from mathutils import Vector,Quaternion,kdtree
sys.path.insert(0,'/project/build/scripts');import rlib
T='/project/build/tex/';R='/project/avatar-build/';B=bpy.data.objects['Body'];rig=bpy.data.objects['Armature'];D='/project/build/bl_user/extensions/.user/user_default/mpfb/data/hair/long01/'
def mat(n,img,rough,normal=False,alpha=False):return rlib.img_mat(n,bpy.data.images.load(T+img,check_existing=True),rough=rough,alpha_from_image=alpha,normal=bpy.data.images.load(T+'weave.png',check_existing=True) if normal else None)
lawn=mat('Lawn • cream sprig embroidery','embroidered.jpg',.86,True);plain=mat('Plain dyed lawn','lawn-plain.jpg',.85,True);silk=mat('Cream chiffon','chiffon.jpg',.83,True);silk.node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value=.91
gold=rlib.img_mat('Gold',color=(.66,.40,.13,1),rough=.3,metallic=.88);shoe=rlib.img_mat('Khussa leather',color=(.58,.43,.28,1),rough=.55);hairmat=mat('Black strand cards','black-hair.png',.52,alpha=True)
kd=kdtree.KDTree(len(B.data.vertices));[kd.insert(v.co,v.index) for v in B.data.vertices];kd.balance()
def bind(o,fixed=None):
 o.parent=rig; md=o.modifiers.new('Skeleton','ARMATURE');md.object=rig
 for v in o.data.vertices:
  if fixed: wt={'mixamorig:'+fixed:1}
  else:
   wt={}
   for p,i,d in kd.find_n(v.co,4):
    for g in B.data.vertices[i].groups:
     n=B.vertex_groups[g.group].name
     if n.startswith('mixamorig:'):wt[n]=wt.get(n,0)+g.weight/max(.002,d)**2
  w=sorted(wt.items(),key=lambda it:-it[1])[:4];s=sum(a for _,a in w)
  for n,a in w:(o.vertex_groups.get(n) or o.vertex_groups.new(name=n)).add([v.index],a/s,'REPLACE')
def mesh(n,V,F,m,UV=None,fixed=None):
 me=bpy.data.meshes.new(n);me.from_pydata(V,[],F);me.update();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o);me.materials.append(m)
 for f in me.polygons:f.use_smooth=True
 if UV:
  uv=me.uv_layers.new(name='UVMap');
  for f,coords in zip(me.polygons,UV):
   for li,xy in zip(f.loop_indices,coords):uv.data[li].uv=xy
 bind(o,fixed);return o
def tube(n,nt,nz,fn,m,fixed=None,closed=True):
 V=[];F=[];UV=[];ns=nt if closed else nt+1
 for j in range(nz+1):
  for i in range(ns):V.append(fn(i/nt,j/nz))
 for j in range(nz):
  for i in range(nt):
   ix=(i+1)%ns;F.append((j*ns+i,j*ns+ix,(j+1)*ns+ix,(j+1)*ns+i));UV.append(((i/nt,j/nz),((i+1)/nt,j/nz),((i+1)/nt,(j+1)/nz),(i/nt,(j+1)/nz)))
 return mesh(n,V,F,m,UV,fixed)
def interp(t,table):return np.array([np.interp(t,np.array(table)[:,0],np.array(table)[:,i]) for i in range(1,len(table[0]))])
def torso(u,t):
 a=2*pi*u; z,rx,ry,cy=interp(t,[(0,.477,.223,.166,-.036),(.32,.777,.213,.144,-.032),(.52,.94,.177,.124,-.047),(.67,1.06,.153,.109,-.05),(.77,1.15,.159,.133,-.041),(.88,1.25,.197,.103,-.022),(.93,1.294,.188,.082,-.018),(.96,1.32,.144,.073,-.020),(1,1.347,.07,.062,-.022)])
 fold=(.004+.005*(1-t))*(.5+.5*cos(13*a+.7*sin(t*6))); z-=max(0,-sin(a))**2*.062*max(0,(t-.94)/.06);return ((rx+fold)*cos(a),cy+(ry+fold)*sin(a),z)
tunic=tube('Kameez',96,66,torso,lawn);tunic.modifiers.new('Fine turned hem','SOLIDIFY').thickness=.0014
for side,k in [('Left',1),('Right',-1)]:
 tab=[(0,.426,-.158,.969,.037,.040),(.10,.415,-.146,.99,.043,.044),(.43,.317,-.024,1.088,.058,.057),(.67,.245,-.021,1.17,.065,.064),(.88,.180,-.023,1.245,.065,.077),(1,.138,-.020,1.277,.062,.082)]
 def sleeve(u,t):
  x,y,z,rx,ry=interp(t,tab);a=2*pi*u;fold=.003*sin(a*8+t*4);return (k*(x+(rx+fold)*cos(a)*.76),y+(ry+fold)*sin(a),z+(rx+fold)*cos(a)*.65)
 tube(side+'Sleeve',48,32,sleeve,lawn)
 def trouser(u,t):
  z,x,y,rx,ry=interp(t,[(0,.071,.165,-.023,.045,.055),(.07,.104,.164,-.022,.061,.073),(.19,.19,.163,-.015,.091,.098),(.51,.46,.133,-.039,.107,.101),(.77,.65,.107,-.038,.123,.115),(1,.86,.09,-.021,.10,.106)]);a=2*pi*u;fold=.009*sin(11*a+2.4*t+1.5*sin(6*t))+.004*cos(7*a-4*t);return(k*(x+(rx+fold)*cos(a)),y+(ry+fold)*sin(a),z+.009*sin(a*3+t*4)*sin(pi*t))
 tube(side+'Shalwar',64,48,trouser,plain)
 def slipper(u,t):
  a=2*pi*u; x,y,z,rx,ry=interp(t,[(0,.165,-.095,.001,.057,.120),(.13,.165,-.095,.009,.059,.120),(.42,.165,-.095,.031,.058,.118),(.66,.165,-.084,.055,.049,.103),(.85,.165,-.047,.071,.043,.066),(1,.165,-.026,.083,.039,.049)]);return(k*(x+rx*cos(a)*(1-.17*max(0,-sin(a)))),y+ry*sin(a),z+.011*max(0,-sin(a))**7)
 tube(side+'Khussa',56,16,slipper,shoe,side+'Foot')
# Folded continuous scarf: free tails up the back, turn at each shoulder, catenary across the chest.
from mathutils.geometry import interpolate_bezier
ctrl=[(-.128,.102,.65),(-.125,.111,1.033),(-.125,.09,1.238),(-.120,.046,1.322),(-.11,-.009,1.348),(-.105,-.085,1.306),(-.088,-.143,1.223),(-.053,-.177,1.167),(0,-.185,1.151),(.053,-.177,1.167),(.088,-.143,1.223),(.105,-.085,1.306),(.11,-.009,1.348),(.12,.046,1.322),(.125,.09,1.238),(.125,.111,1.033),(.128,.102,.70)]
p=[Vector(q) for q in ctrl];curve=[]
for i in range(len(p)-1):curve+=interpolate_bezier(p[i],p[i]+(p[i+1]-p[max(0,i-1)])/6,p[i+1]-(p[min(len(p)-1,i+2)]-p[i])/6,p[i+1],12)[:-1]
curve.append(p[-1]);V=[];F=[];UV=[];N=24
for j,c in enumerate(curve):
 tang=(curve[min(j+1,len(curve)-1)]-curve[max(0,j-1)]).normalized();front=np.clip((-c.y-.01)/.09,0,1);side=1 if c.x>=0 else -1;wide=Vector((1,0,0))*(1-front)+Vector((tang.z,0,-tang.x)).normalized()*front
 # keep side direction continuous at both shoulders
 if c.x>0 and front>0:wide=Vector((-1,0,0))*(1-front)+Vector((tang.z,0,-tang.x)).normalized()*front if False else wide
 # parallel-transport across the wrap by taking cross with an outward normal
 outward=Vector((side*.12,1 if c.y>.045 else -1,0)); up=np.exp(-((c.y+.01)/.063)**2) if c.z>1.27 else 0;outward=Vector((side*.12,np.tanh((c.y+.008)/.038),up*1.6));wide=tang.cross(outward).normalized();nor=wide.cross(tang).normalized()
 for i in range(N+1):
  u=i/N;v=c+wide*((u-.5)*(.090 if c.y<0 else .105))+nor*(.0038*sin(u*8*pi+.55*sin(j*.041))+.0014*cos(u*13*pi));V.append(tuple(v));
  if i and j:
   b=j*(N+1)+i;F.append((b-N-2,b-N-1,b,b-1));UV.append((((i-1)/N,(j-1)/len(curve)),(i/N,(j-1)/len(curve)),(i/N,j/len(curve)),((i-1)/N,j/len(curve))))
scarf=mesh('ChiffonDupatta',V,F,silk,UV);scarf.modifiers.new('Chiffon edge','SOLIDIFY').thickness=.0006
# Fit original CC0 hair-card mesh by MakeHuman three-point registration against pre-trim helper cage.
with bpy.data.libraries.load('/project/build/out/stage1.blend') as (src,dst):dst.objects=['Body']
cage=dst.objects[0];cp=np.array([v.co[:] for v in cage.data.vertices]);lines=open(D+'long01.mhclo').read().splitlines();axes={l.split()[0]:l.split()[1:] for l in lines if '_scale ' in l};factors=[]
for ax,j in [('x',0),('y',2),('z',1)]:
 a,b,d=axes[ax+'_scale'];factors.append(abs(cp[int(a),j]-cp[int(b),j])/float(d))
V=[]
for l in lines:
 s=l.split();
 if len(s)!=9 or not s[0].isdigit():continue
 a=np.array(s[3:6],float)@cp[np.array(s[:3],int)];dx,dy,dz=np.array(s[6:],float)*factors;a+=np.array([dx,-dz,dy]);h=np.clip((1.46-a[2])/.16,0,1);a[1]+=h*.09;a[2]-=.105*h;V.append(a)
F=[];UV=[];vt=[]
for l in open(D+'long01.obj'):
 s=l.split();
 if not s:continue
 if s[0]=='vt':vt.append(tuple(map(float,s[1:3])))
 if s[0]=='f':
  ids=[p.split('/') for p in s[1:]];F.append([int(p[0])-1 for p in ids]);UV.append([vt[int(p[1])-1] for p in ids])
mesh('CentrePartHair',V,F,hairmat,UV,'Head');bpy.data.objects.remove(cage)
# Small geometric jewellery, surface position anchored to the reference anatomy.
def jew(n,loc,scale):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=10,location=(0,0,0));o=bpy.context.object;o.name=n
 for v in o.data.vertices:v.co=Vector(loc)+Vector([v.co[i]*scale[i] for i in range(3)])
 o.data.materials.append(gold);bind(o,'Head');return o
for side,k in [('Left',1),('Right',-1)]:
 gi=B.vertex_groups['ears'].index;ear=[v.co for v in B.data.vertices if k*v.co.x>0 and any(g.group==gi for g in v.groups)];p=min(ear,key=lambda v:v.z);x=k*(abs(p.x)+.003);y=p.y-.003;z=p.z
 jew(side+'EarStud',(x,y,z),(.0028,.0026,.0031));jew(side+'Link',(x,y,z-.005),(.0011,.0011,.004));jew(side+'Bell',(x,y,z-.011),(.006,.0056,.0048));
 for j in range(9):jew(side+'Bead'+str(j),(x+.0055*cos(j*2*pi/9),y+.005*sin(j*2*pi/9),z-.015),(.0012,.0012,.0015))
v=min(B.data.vertices,key=lambda v:(v.co-Vector((.015,-.158,1.451))).length).co;jew('NosePin',(v.x,v.y-.0012,v.z),(.00145,.00125,.00145))
# Cull only covered flesh. Leave hands, forearms near cuffs, upper chest and feet near openings.
b=bmesh.new();b.from_mesh(B.data);bad=[]
for v in b.verts:
 x,y,z=v.co;X=abs(x)
 if (.028<z<.085) or (.076<z<1.26 and X<.385 and (z<.86 or X<.188 or (X>.185 and z>1.007))) or (1.245<z<1.29 and X>.105):bad.append(v)
bmesh.ops.delete(b,geom=bad,context='VERTS');b.to_mesh(B.data);b.free()
# Bring upper arms down and straighten forearms using bone-local rotations.
def point(name,goal):
 pb=rig.pose.bones['mixamorig:'+name];cur=(pb.tail-pb.head).normalized();q=cur.rotation_difference(Vector(goal).normalized());M=pb.matrix.copy();rot=q.to_matrix().to_4x4()@M;rot.translation=M.translation;pb.matrix=rot;bpy.context.view_layer.update()
for side,k in [('Left',1),('Right',-1)]:
 point(side+'Arm',(k*.27,.005,-1));point(side+'ForeArm',(k*.09,-.215,-1));point(side+'Hand',(-k*.03,-.11,-1));
 for finger in ['Index','Middle','Ring','Pinky']:
  for i in (2,3):
   pb=rig.pose.bones['mixamorig:'+side+'Hand'+finger+str(i)];pb.rotation_mode='XYZ';pb.rotation_euler.x+=.08
sc=bpy.context.scene;rlib.setup_studio(sc);rlib.setup_cycles(sc,(720,900),32);rlib.get_cam(sc);sc.camera.location=(0,-1.62,1.26);sc.camera.rotation_euler=(Vector((0,0,1.22))-sc.camera.location).to_track_quat('-Z','Y').to_euler();sc.camera.data.lens=60
im=bpy.data.images.load(R+'reference/design-sheet.png');ob=bpy.data.objects.new('Design sheet (viewport only)',None);bpy.context.collection.objects.link(ob);ob.empty_display_type='IMAGE';ob.data=im;ob.hide_render=True;ob.hide_viewport=True
rlib.save('/project/scene.blend');print('WARDROBE DONE')
