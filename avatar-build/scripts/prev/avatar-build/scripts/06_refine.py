# Blender headless: load /project/scene.blend from stage 04. Correct likeness, skin, drape, shoulder coverage, hair and stance.
import bpy,sys,math,numpy as np,random,bmesh,os
from mathutils import Vector,Matrix
from mathutils.bvhtree import BVHTree
from math import sin,cos,pi
sys.path.insert(0,'/project/build/scripts');import rlib
R='/project/avatar-build/';T='/project/build/tex/';sc=bpy.context.scene;B=bpy.data.objects['Body'];rig=bpy.data.objects['Armature'];rig.data.pose_position='REST';bpy.context.view_layer.update(); disp=np.load(R+'reference/face-fit.npy')
# Bake registered albedo detail to the existing skin UV, retaining original photographic texture on ears, neck, interior mouth and body.
me=B.data;uv0=me.uv_layers.active.name;uv1=me.uv_layers.new(name='FaceProjection');colors=me.color_attributes.new('FaceBlend','FLOAT_COLOR','POINT');vco=np.array([v.co[:] for v in me.vertices]);
for v in me.vertices:
 x,y,z=v.co;w=np.clip((-y-.077)/.035,0,1)*np.clip((z-1.365)/.04,0,1)*np.clip((1.60-z)/.034,0,1)*.73;colors.data[v.index].color=(w,w,w,1)
for l in me.loops:
 x,y,z=vco[l.vertex_index];uv1.data[l.index].uv=(.5+x/.255,.5+(z-1.47)/.255)
me.uv_layers.active=me.uv_layers[uv0];me.uv_layers[uv0].active_render=True;m=me.materials[0];nt=m.node_tree;bs=nt.nodes['Principled BSDF'];base=bs.inputs['Base Color'].links[0].from_node;tx=nt.nodes.new('ShaderNodeTexImage');tx.image=bpy.data.images.load(R+'reference/face-detail.png');tx.extension='CLIP';proj=nt.nodes.new('ShaderNodeUVMap');proj.uv_map='FaceProjection';nt.links.new(proj.outputs[0],tx.inputs[0]);uv=nt.nodes.new('ShaderNodeUVMap');uv.uv_map=uv0;nt.links.new(uv.outputs[0],base.inputs[0]);att=nt.nodes.new('ShaderNodeAttribute');att.attribute_name='FaceBlend';a=nt.nodes.new('ShaderNodeMath');a.operation='MULTIPLY';nt.links.new(att.outputs['Fac'],a.inputs[0]);nt.links.new(tx.outputs['Alpha'],a.inputs[1]);mix=nt.nodes.new('ShaderNodeMixRGB');nt.links.new(a.outputs[0],mix.inputs[0]);nt.links.new(base.outputs[0],mix.inputs[1]);nt.links.new(tx.outputs[0],mix.inputs[2]);em=nt.nodes.new('ShaderNodeEmission');nt.links.new(mix.outputs[0],em.inputs[0]);nt.links.new(em.outputs[0],nt.nodes['Material Output'].inputs[0]);di=bpy.data.images.new('Baked face and skin',2048,2048,alpha=False);dst=nt.nodes.new('ShaderNodeTexImage');dst.image=di;nt.nodes.active=dst;bpy.ops.object.select_all(action='DESELECT');B.select_set(True);bpy.context.view_layer.objects.active=B;rlib.setup_cycles(sc,(512,512),8);sc.render.bake.margin=8;bpy.ops.object.bake(type='EMIT');di.filepath_raw=T+'complexion.jpg';di.file_format='JPEG';di.save();mnew=rlib.img_mat('Complexion',di,rough=.54,normal=bpy.data.images['skin_normal.png']);mnew.node_tree.nodes['Normal Map'].inputs['Strength'].default_value=.24;me.materials[0]=mnew;me.uv_layers.remove(me.uv_layers['FaceProjection']);me.color_attributes.remove(me.color_attributes['FaceBlend']);
# Fit geometry with per-vertex neutral deltas shared by the entire morph stack (preserves the original deformations).
for o in list(sc.objects):
 if o.type!='MESH' or not (o.data.shape_keys or o.name=='NosePin'):continue
 p=np.array([v.co[:] for v in o.data.vertices]);xy=np.int32(np.clip(np.c_[.5+p[:,0]/.255,.5-(p[:,2]-1.47)/.255]*768,0,767));d=disp[xy[:,1],xy[:,0]]*.255/768;gate=np.clip((-p[:,1]-.026)/.07,0,1)*np.clip((p[:,2]-1.35)/.035,0,1);dd=np.c_[d[:,0],np.zeros(len(p)),-d[:,1]]*gate[:,None];delta=dd.astype('f').ravel()
 for block in ([o.data.vertices]+([k.data for k in o.data.shape_keys.key_blocks] if o.data.shape_keys else [])):
  a=np.empty(len(p)*3,'f');block.foreach_get('co',a);block.foreach_set('co',a+delta)
 o.data.update()
# Retain source ocular geometry, but soften oversized double catchlights.
emat=bpy.data.objects['Eyes'].data.materials[0].node_tree.nodes['Principled BSDF'];emat.inputs['Roughness'].default_value=.33;emat.inputs['Specular IOR Level'].default_value=.22
# Anatomical yoke closes the under-sleeve at the shoulder. Inherit body weights and UVs from the pre-trim mesh.
with bpy.data.libraries.load('/project/build/out/stage2.blend') as (src,dst):dst.objects=['Body']
o=dst.objects[0];bpy.context.collection.objects.link(o);o.name='KameezYoke';o.parent=rig;o.shape_key_clear();o.data.materials.clear();o.data.materials.append(bpy.data.materials['Plain dyed lawn']);
for md in list(o.modifiers):o.modifiers.remove(md)
md=o.modifiers.new('Skeleton','ARMATURE');md.object=rig
bm=bmesh.new();bm.from_mesh(o.data);kill=[]
for v in bm.verts:
 x,y,z=v.co
 if z<1.17 or z>1.345 or (abs(x)<.075 and z>1.31+(y+.105)*.21):kill.append(v)
 else:v.co+=v.normal*.0035
bmesh.ops.delete(bm,geom=kill,context='VERTS');bm.to_mesh(o.data);bm.free()
# At rest, project the front, back and shoulder sections of the scarf outside the garment; pinned cloth pass settles transverse folds before skinning.
scarf=bpy.data.objects['ChiffonDupatta'];tun=bpy.data.objects['Kameez'];dg=bpy.context.evaluated_depsgraph_get();tree=BVHTree.FromObject(tun,dg);pin=scarf.vertex_groups.new(name='Sewing pins');
for v in scarf.data.vertices:
 x,y,z=v.co;j=v.index//25;i=v.index%25;sgn=1 if y>0 else -1
 if z>1.29 and abs(y)<.065:
  loc,*_=tree.ray_cast((x,y,1.7),(0,0,-1));
  if loc:v.co.z=max(z,loc.z+.007)+.002
 else:
  loc,*_=tree.ray_cast((x,sgn*.5,z),(0,-sgn,0));
  if loc and loc.y*sgn>v.co.y*sgn-.006:v.co.y=sgn*max(v.co.y*sgn,loc.y*sgn+.005)
 pin.add([v.index],.98 if z>1.28 else (.62 if j in (0,176) else .40),'REPLACE');v.co.y+=.0018*sin(i*.7+j*.08);v.co.z+=.002*sin(i*.4+j*.087)
for target in [tun,o]:target.modifiers.new('Fitting collision','COLLISION')
cloth=scarf.modifiers.new('Settle chiffon','CLOTH');cloth.settings.quality=5;cloth.settings.mass=.12;cloth.settings.vertex_group_mass=pin.name;cloth.settings.pin_stiffness=14;cloth.collision_settings.distance_min=.002;cloth.point_cache.frame_end=6;bpy.context.view_layer.objects.active=scarf
for f in range(1,7):sc.frame_set(f);bpy.context.view_layer.update()
# Obtain settled mesh without changing topology. Thickness is already a modifier, so disable it during sampling.
for md in scarf.modifiers:
 if md.type=='SOLIDIFY':md.show_viewport=False
bpy.context.view_layer.update();evalu=scarf.evaluated_get(bpy.context.evaluated_depsgraph_get());pos=[v.co.copy() for v in evalu.data.vertices];scarf.modifiers.remove(cloth);sc.frame_set(1)
if len(pos)==len(scarf.data.vertices):
 for v,p in zip(scarf.data.vertices,pos):v.co=p
for md in scarf.modifiers:md.show_viewport=True
for target in [tun,o]:target.modifiers.remove(target.modifiers['Fitting collision'])
# Replace the polygonal hair cap with individually textured, scalp-conforming ribbons combed from a sagittal part.
bpy.data.objects.remove(bpy.data.objects['CentrePartHair'],do_unlink=True);rng=random.Random(450);skt=BVHTree.FromObject(B,bpy.context.evaluated_depsgraph_get());verts=[];faces=[];uvs=[];center=Vector((0,-.044,1.492));N=30
for side in [-1,1]:
 for row in range(4):
  for strand in range(73):
   theta=.99-2.52*(strand+rng.uniform(-.32,.32))/72;radius=.0011*row+rng.uniform(.0004,.0016);width=rng.uniform(.008,.014);pts=[];ends=rng.uniform(.95,1.085);phase=rng.random()*6
   for j in range(N+1):
    t=j/N;phi=min(1,t/.54)*1.48;rx=side*.079*sin(phi)*cos(min(0,theta)*.94);ry=-.101*sin(theta)*(.65+.35*cos(phi))+.018*sin(phi);rz=.110*cos(theta)*cos(phi);di=Vector((rx,ry,rz)).normalized();hit,n,_,_=skt.ray_cast(center+di*.22,-di,.26);surface=(hit+n*radius) if hit else center+Vector((rx,ry,rz))+di*radius
    if t<=.54:
     p=surface;p.x+=side*(.0008+.0005*row)*(1-min(1,t*4));
    else:
     h=(t-.54)/.46;sidewidth=.055*max(0,-sin(theta))+.108*max(0,sin(theta));target=Vector((side*(.004+.097*(1+sin(theta))*.56+.004*sin(phase)),.087+.033*(1-sin(theta))*.5,ends+.075*sin(theta)));p=surface.lerp(target,h);p.y+=.041*sin(h*pi)*max(0,1-h*.7);p.x+=side*(.016*sin(pi*h)+.003*sin(h*7+phase)*h);p.z-=.018*sin(pi*h)
    pts.append(p)
   for j,p in enumerate(pts):
    t=j/N;ta=(pts[min(N,j+1)]-pts[max(0,j-1)]).normalized();no=(p-center).normalized() if t<.46 else Vector((side*.72,.65,0)).normalized();wide=ta.cross(no).normalized();w=width*(.45+.55*min(1,t*18))*max(.09,min(1,(1-t)*7));verts.extend([p-wide*w/2,p+wide*w/2]);
    if j:
     k=len(verts)-1;faces.append((k-3,k-2,k,k-1));uvs.append(((0,1-(j-1)/N),(1,1-(j-1)/N),(1,1-j/N),(0,1-j/N)))
me=bpy.data.meshes.new('CombedLocks');me.from_pydata(verts,[],faces);me.update();o=bpy.data.objects.new('CentrePartHair',me);bpy.context.collection.objects.link(o);uv=me.uv_layers.new();
for f,us in zip(me.polygons,uvs):
 f.use_smooth=True
 for j,coord in zip(f.loop_indices,us):uv.data[j].uv=coord
hm=rlib.img_mat('Combed black strands',bpy.data.images.load(T+'strands.png'),rough=.57,alpha_from_image=True,spec=.28);me.materials.append(hm);o.parent=rig;md=o.modifiers.new('Skeleton','ARMATURE');md.object=rig;gr=o.vertex_groups.new(name='mixamorig:Head');gr.add(list(range(len(verts))),1,'REPLACE');
# Soften athletic stance at the hips. Close the shoulder ends of sleeves; yoke is a continuous underlayer.
rig.data.pose_position='POSE';bpy.context.view_layer.update()
for side,sgn in [('Left',1),('Right',-1)]:
 pb=rig.pose.bones['mixamorig:'+side+'UpLeg'];M=pb.matrix.copy();rot=Matrix.Rotation(sgn*.077,4,'Y')@M;rot.translation=M.translation;pb.matrix=rot
# Slight smile is a real default target weight, not a keyed animation.
for ob in sc.objects:
 if ob.type=='MESH' and ob.data.shape_keys:
  for n in ['mouthSmileLeft','mouthSmileRight']:
   k=ob.data.shape_keys.key_blocks.get(n)
   if k:k.value=.12
rlib.save('/project/scene.blend')
