# Export only renderable avatar objects, aggregate small parts, embed sparse position targets. Write posed joint transforms without changing inverse bind matrices.
import bpy,sys,os,struct,json,numpy as np,math
from mathutils import Matrix
sys.path.insert(0,'/project/build/scripts');import rlib
S=bpy.context.scene;rig=bpy.data.objects['Armature'];D='/project/public/avatar/';os.makedirs(D,exist_ok=True);B=bpy.data.objects['Body'];
# Consolidate rigid accessory pieces into logical meshes before exporting.
def join(obs,name):
 if len(obs)<2:return
 bpy.ops.object.select_all(action='DESELECT');
 for o in obs:o.select_set(True)
 bpy.context.view_layer.objects.active=obs[0];bpy.ops.object.join();obs[0].name=name
for s in ['Left','Right']:
 join([o for o in S.objects if o.type=='MESH' and o.name.startswith(s) and any(p in o.name for p in ['EarStud','Link','Bell','Bead'])],s+'Jhumka');join([bpy.data.objects[x] for x in [s+'Khussa',s+'VampTrim',s+'SoleWelt'] if x in bpy.data.objects],s+'Khussa')
# Apply only solidify on the static garment design, BEFORE skinning.
for o in list(S.objects):
 if o.type!='MESH':continue
 bpy.context.view_layer.objects.active=o
 for md in list(o.modifiers):
  if md.type=='SOLIDIFY':
   bpy.ops.object.modifier_move_to_index(modifier=md.name,index=0);bpy.ops.object.modifier_apply(modifier=md.name)
 # Remove unused authoring vertex colours. No per-vertex data used by the final materials.
 for ca in list(o.data.color_attributes):o.data.color_attributes.remove(ca)
 for m in o.data.materials:
  if not m or not m.use_nodes:continue
  bs=m.node_tree.nodes.get('Principled BSDF');
  if bs:
   bs.inputs['Subsurface Weight'].default_value=0
# Document every geometry-affecting target, including actual mandibular motion of oral accessories.
check={}
for o in S.objects:
 if o.type!='MESH' or not o.data.shape_keys:continue
 kb=o.data.shape_keys.key_blocks;n=len(o.data.vertices);a=np.empty(n*3,'f');kb[0].data.foreach_get('co',a);check[o.name]={}
 for k in list(kb)[1:]:
  p=np.empty(n*3,'f');k.data.foreach_get('co',p);delta=np.linalg.norm((p-a).reshape(-1,3),axis=1);check[o.name][k.name]=round(float(delta.max()),7)
# Identify coordinates from evaluated geometry, not from the render camera.
dg=bpy.context.evaluated_depsgraph_get();eye=B.evaluated_get(dg);eyeM={i for i,m in enumerate(eye.data.materials) if m and m.name=='Eyes'};eyeVerts={idx for f in eye.data.polygons if f.material_index in eyeM for idx in f.vertices};eyeZ=np.mean([(eye.matrix_world@eye.data.vertices[i].co).z for i in eyeVerts]);lips=B.vertex_groups['lips'].index;mouthZ=np.mean([v.co.z for v in B.data.vertices if any(g.group==lips for g in v.groups)]);minZ=999;maxZ=-999
for o in S.objects:
 if o.type=='MESH':
  e=o.evaluated_get(dg);zs=[(e.matrix_world@v.co).z for v in e.data.vertices];minZ=min(minZ,min(zs));maxZ=max(maxZ,max(zs))
rig.location.z-=minZ;bpy.context.view_layer.update();rlib.save('/project/scene.blend');bpy.ops.object.select_all(action='DESELECT');
for o in S.objects:
 if o.type in ('MESH','ARMATURE'):o.select_set(True)
path=D+'avatar.glb';bpy.ops.export_scene.gltf(filepath=path,export_format='GLB',use_selection=True,export_yup=True,export_animations=False,export_current_frame=True,export_rest_position_armature=True,export_morph_normal=False,export_morph_tangent=False,export_try_sparse_sk=True,export_try_omit_sparse_sk=True,export_cameras=False,export_lights=False,export_extras=False)
buf=open(path,'rb').read();sz=struct.unpack_from('<I',buf,12)[0];g=json.loads(buf[20:20+sz]);binchunk=buf[20+sz:];nd=g['nodes'];bones={b.name:b for b in rig.pose.bones};names={x.get('name',''):i for i,x in enumerate(nd)};parents={j:i for i,n in enumerate(nd) for j in n.get('children',[])}
# Convert rest-to-pose deltas in the actual node's own local axis convention, preserving bind geometry. Compare initial node local to Blender rest matrix and its basis-converted equivalent.
from mathutils import Quaternion,Vector
def nodeM(n):
 if 'matrix' in n:return Matrix(np.array(n['matrix']).reshape((4,4)).T.tolist())
 x,y,z,w=n.get('rotation',[0,0,0,1]);return Matrix.LocRotScale(Vector(n.get('translation',[0,0,0])),Quaternion((w,x,y,z)),Vector(n.get('scale',[1,1,1])))
C=Matrix.Rotation(-math.pi/2,4,'X');restWorld={};poseWorld={}
for n in rig.data.bones:
 if n.name not in names:continue
 i=names[n.name];pb=rig.pose.bones[n.name];par=n.parent;rest=n.matrix_local if not par else par.matrix_local.inverted()@n.matrix_local;pose=pb.matrix if not par else pb.parent.matrix.inverted()@pb.matrix;orig=nodeM(nd[i]);mats=[(rest,pose),(C@rest, C@pose),(C@rest@C.inverted(),C@pose@C.inverted())];a,b=min(mats,key=lambda r:np.linalg.norm(np.array(r[0])-np.array(orig)));err=np.linalg.norm(np.array(a)-np.array(orig));
 if err>.03:continue
 t,q,s=b.decompose();nd[i].pop('matrix',None);nd[i]['translation']=list(t);nd[i]['rotation']=[q.x,q.y,q.z,q.w];nd[i]['scale']=list(s)
# Raise entire character to place the sole precisely on glTF y=0, including deform rig.
# Ground offset is already incorporated in the armature object's exported transform.
js=json.dumps(g,separators=(',',':')).encode();js+=b' '*((-len(js))%4);open(path,'wb').write(struct.pack('<4sII',b'glTF',2,20+len(js)+len(binchunk))+struct.pack('<I4s',len(js),b'JSON')+js+binchunk)
roles={'Hips':'hips','Spine':'spine','Spine1':'spine1','Spine2':'chest','Neck':'neck','Head':'head'}
for side in ['Left','Right']:
 for old,new in [('Shoulder','Shoulder'),('Arm','UpperArm'),('ForeArm','Forearm'),('Hand','Hand'),('UpLeg','UpperLeg'),('Leg','LowerLeg'),('Foot','Foot'),('ToeBase','Toes')]:roles[side+old]=side.lower()+new
 for finger in ['Thumb','Index','Middle','Ring','Pinky']:
  for i in range(1,4):roles[side+'Hand'+finger+str(i)]=side.lower()+finger+str(i)
meshinfo={};tri=0
for n in nd:
 if 'mesh' not in n:continue
 m=g['meshes'][n['mesh']];k=m.get('extras',{}).get('targetNames',[]);cnt=sum(g['accessors'][p['indices']]['count']//3 for p in m['primitives']);tri+=cnt;meshinfo[n['name']]={'meshName':m.get('name'),'morphTargets':k,'triangles':cnt}
manifest={'version':1,'units':'metres','up':'+Y','forward':'+Z','height':float(maxZ-minZ),'eyeHeight':float(eyeZ-minZ),'mouthHeight':float(mouthZ-minZ),'suggestedCamera':{'position':[0,1.265,1.58],'target':[0,1.23,.02],'verticalFov':float(np.degrees(2*np.arctan(36/(2*65))))},'bones':{r:'mixamorig:'+n for n,r in roles.items() if 'mixamorig:'+n in names},'meshes':meshinfo,'glbBytes':os.path.getsize(path),'triangles':tri,'skinCount':len(g.get('skins',[])),'extensionsRequired':g.get('extensionsRequired',[]),'expressionDeltaMaxMetres':check};json.dump(manifest,open(D+'avatar.json','w'),indent=2);print('RESULT',tri,manifest['glbBytes'],meshinfo.keys(),manifest['height'],manifest['skinCount']);print('JAW',[(k,v.get('jawOpen')) for k,v in check.items()]);print('INACTIVE',[(k,[n for n,x in v.items() if x<1e-7]) for k,v in check.items()]);print('BONES',len(manifest['bones']))
