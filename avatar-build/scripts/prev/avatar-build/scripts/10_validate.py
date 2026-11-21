# Directly decode the delivered GLB. No Blender dependency. Python 3 + numpy, scipy, Pillow.
import numpy as np,json,io,struct,hashlib,os
from scipy.spatial.transform import Rotation
from PIL import Image
from pathlib import Path
D=Path('/project/public/avatar');R=Path('/project/avatar-build');b=(D/'avatar.glb').read_bytes();magic,ver,ln=struct.unpack_from('<4sII',b);assert magic==b'glTF' and ver==2 and ln==len(b);sz=struct.unpack_from('<I',b,12)[0];g=json.loads(b[20:20+sz]);blob=b[28+sz:];dims={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16};dtypes={5120:'i1',5121:'u1',5122:'<i2',5123:'<u2',5125:'<u4',5126:'<f4'}
def view(v,off,n,dim,typ):
 v=g['bufferViews'][v];dt=np.dtype(dtypes[typ]);return np.ndarray((n,dim),dt,buffer=blob,offset=v.get('byteOffset',0)+off,strides=(v.get('byteStride',dt.itemsize*dim),dt.itemsize)).copy()
def acc(i):
 a=g['accessors'][i];n=a['count'];d=dims[a['type']];t=a['componentType'];A=view(a['bufferView'],a.get('byteOffset',0),n,d,t) if 'bufferView' in a else np.zeros((n,d),dtypes[t]);
 if 'sparse' in a:
  s=a['sparse'];ii=s['indices'];vv=s['values'];idx=view(ii['bufferView'],ii.get('byteOffset',0),s['count'],1,ii['componentType']).ravel();A[idx]=view(vv['bufferView'],vv.get('byteOffset',0),s['count'],d,t)
 return A
parents={j:i for i,n in enumerate(g['nodes']) for j in n.get('children',[])};cache={}
def world(i):
 if i in cache:return cache[i]
 n=g['nodes'][i];m=np.eye(4)
 if 'matrix' in n:m=np.reshape(n['matrix'],(4,4)).T
 else:m[:3,:3]=Rotation.from_quat(n.get('rotation',[0,0,0,1])).as_matrix()@np.diag(n.get('scale',[1,1,1]));m[:3,3]=n.get('translation',[0,0,0])
 cache[i]=(world(parents[i])@m if i in parents else m);return cache[i]
meshlist=[];prims=[];tri=0;bbox=[];rawd={};motion={};ground={};m=json.loads((D/'avatar.json').read_text());tex=[]
for im in g.get('images',[]):
 v=g['bufferViews'][im['bufferView']];img=Image.open(io.BytesIO(blob[v.get('byteOffset',0):][:v['byteLength']]));tex.append({'name':im.get('name'),'type':img.format,'dimensions':img.size});assert max(img.size)<=2048
for i,n in enumerate(g['nodes']):
 if 'mesh' not in n:continue
 me=g['meshes'][n['mesh']];meshlist.append(n['name']);keys=me.get('extras',{}).get('targetNames',[]);weights=np.array(n.get('weights',me.get('weights',np.zeros(len(keys)))));sc=g['skins'][n['skin']];jm=np.array([world(j) for j in sc['joints']])@acc(sc['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1);points=[]
 for p in me['primitives']:
  assert p.get('mode',4)==4;tri+=len(acc(p['indices']))//3;att=p['attributes'];xyz=acc(att['POSITION']);j=acc(att['JOINTS_0']);w=acc(att['WEIGHTS_0']);w=w/w.sum(1,keepdims=True);mat=g['materials'][p['material']].get('name');targets=p.get('targets',[]);peaks={};
  for key,t,v in zip(keys,targets,weights):
   dx=acc(t['POSITION']) if 'POSITION' in t else np.zeros_like(xyz);peak=float(np.linalg.norm(dx,axis=1).max());peaks[key]=peak;rawd[key]=max(rawd.get(key,0),peak);xyz=xyz+dx*v
  if keys:motion[mat]={k:round(v,7) for k,v in peaks.items() if v>0};
  transform=np.einsum('ij,ijab->iab',w,jm[j]);q=np.einsum('ijk,ik->ij',transform,np.c_[xyz,np.ones(len(xyz))])[:,:3];points.append(q);bbox.append(q)
 pp=np.concatenate(points);ground[n['name']]=round(float(pp[:,1].min()),7)
allp=np.concatenate(bbox);lo=allp.min(0);hi=allp.max(0);report={'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'triangles':tri,'meshNodes':meshlist,'skinCount':len(g['skins']),'jointCount':len(g['skins'][0]['joints']),'joints':[g['nodes'][i]['name'] for i in g['skins'][0]['joints']],'posedBoundsMetres':{'min':lo.tolist(),'max':hi.tolist()},'minYByNode':ground,'imageTextures':tex,'extensionsUsed':g.get('extensionsUsed',[]),'extensionsRequired':g.get('extensionsRequired',[]),'maxDisplacementByTarget':rawd,'maxDisplacementByFacialMaterial':motion,'renderComparison':{}}
for shot in ['jawOpen','waist']:
 a=np.array(Image.open(R/'renders'/(shot+'.jpg'))).astype(float);c=np.array(Image.open(R/'renders'/('imported-'+shot+'.jpg'))).astype(float);report['renderComparison'][shot]={'meanAbsoluteDifference255':round(float(np.abs(a-c).mean()),4),'size':[a.shape[1],a.shape[0]]}
assert tri<200000 and len(b)<30000000 and len(rawd)==67 and min(rawd.values())>0 and len(g['skins'])==1;assert abs(lo[1])<.001,(lo,hi);assert all(k not in g.get('extensionsUsed',[]) for k in ['KHR_draco_mesh_compression','EXT_meshopt_compression']);json.dump(report,open(R/'glb-check.json','w'),indent=2);print('VALIDATED',len(b),tri,len(rawd),lo,hi,report['renderComparison']);print('oral motion',[(k,v.get('jawOpen'),v.get('tongueOut')) for k,v in motion.items()]);print('textures',tex)
