# Run after rendering the stage2 orthographic portrait (square, span .255 m, centred at z=1.47).
import os,cv2,numpy as np,mediapipe as mp
from scipy.interpolate import RBFInterpolator
from scipy.spatial import Delaunay
R='/project/avatar-build/reference/';o=cv2.imread(R+'ortho.jpg');ref=cv2.imread(R+'design-sheet.png');w=ref.shape[1];ref=ref[:,w//2:].copy();det=mp.solutions.face_mesh.FaceMesh(static_image_mode=True,refine_landmarks=True,min_detection_confidence=.4)
def detect(im):
 p=det.process(cv2.cvtColor(im,cv2.COLOR_BGR2RGB)).multi_face_landmarks[0];return np.array([(q.x*im.shape[1],q.y*im.shape[0]) for q in p.landmark])
s=detect(o);r=detect(ref);sn=s[:468];rn=r[:468];rs=(np.linalg.norm(s[33]-s[263])/np.linalg.norm(r[33]-r[263]));rt=(s[33]+s[263])/2-rs*(r[33]+r[263])/2;desired=.77*(rn*rs+rt-sn);desired[:,0]=(desired[:,0]-np.median(desired[:,0]));sel=[33,133,362,263,159,145,386,374,70,63,105,66,107,336,296,334,293,300,168,6,4,1,2,98,327,61,291,0,17,13,14,152,149,378,172,397,234,454,10,127,356,205,425,50,280];bounds=np.array([(0,0),(384,0),(767,0),(0,767),(384,767),(767,767),(0,384),(767,384)]);fit=RBFInterpolator(np.vstack([sn[sel],bounds])/768,np.vstack([desired[sel],np.zeros((len(bounds),2))]),smoothing=.001);y,x=np.mgrid[0:768:4,0:768:4];dis=fit(np.stack([x.ravel(),y.ravel()],1)/768).reshape(192,192,2);np.save(R+'face-fit.npy',cv2.resize(dis,(768,768)).astype('float32'))
# Antialiased individual fibres with tapered tips on a transparent ribbon.
from PIL import Image,ImageDraw
rng=np.random.default_rng(43);canvas=Image.new('RGBA',(256,1024));d=ImageDraw.Draw(canvas)
for u in np.sort(rng.uniform(0,256,210)):
 phase=rng.uniform(0,6);end=int(rng.uniform(920,1024));start=int(rng.uniform(0,35));k=rng.uniform(16,51);coords=[(u+3*np.sin(j*.005+phase)+1.6*np.sin(j*.017+phase),j) for j in range(start,end,4)];d.line(coords,fill=(int(k*1.04),int(k*.94),int(k*.90),int(rng.uniform(150,250))),width=int(rng.integers(1,4)))
canvas.resize((128,512),Image.Resampling.LANCZOS).save('/project/build/tex/strands.png')
# Landmark-registered photographic cheek / brow / lips detail, blended into the existing skin atlas. Never project eyes, hair or a silhouette onto a mesh.
tri=Delaunay(sn);y,x=np.mgrid[0:768,0:768];xy=np.stack([x.ravel(),y.ravel()],1);idx=tri.find_simplex(xy);tf=tri.transform[idx];b=np.einsum('ijk,ik->ij',tf[:,:2,:],xy-tf[:,2,:]);b=np.c_[b,1-b.sum(1)];coords=np.einsum('ij,ijk->ik',b,rn[tri.simplices[idx]]).reshape(768,768,2).astype('float32');img=cv2.remap(ref,coords,None,cv2.INTER_LINEAR);mask=(idx.reshape(768,768)>=0).astype('uint8')*255
for region in [mp.solutions.face_mesh.FACEMESH_LEFT_EYE,mp.solutions.face_mesh.FACEMESH_RIGHT_EYE]:
 pts=np.int32(sn[list({v for pair in region for v in pair})]);cv2.fillConvexPoly(mask,cv2.convexHull(pts),0)
mask=cv2.GaussianBlur(cv2.erode(mask,np.ones((11,11),np.uint8)),(0,0),7);cv2.imwrite(R+'face-detail.png',np.dstack([img,mask]));print('Face-fit offset maxima (px)',abs(dis).max(0).max(0))
