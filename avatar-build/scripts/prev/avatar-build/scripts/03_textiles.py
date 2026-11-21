# Run with system Python (Pillow, numpy). Create seamless woven lawn and embroidery atlas.
from PIL import Image,ImageDraw
import numpy as np,math,os
T='/project/build/tex/'; os.makedirs(T,exist_ok=True)
r=np.random.default_rng(27); W=1024; H=1024;y,x=np.mgrid[:H,:W]; g=1.35*np.sin(x*2.1)+1.1*np.cos(y*2.05)+r.normal(0,1,(H,W)); im=Image.fromarray(np.uint8(np.clip(np.array([89,124,124])+g[:,:,None],0,255)));im.save(T+'lawn-plain.jpg',quality=91)
d=ImageDraw.Draw(im); gold=(211,199,165); shade=(161,157,134)
def sprig(x,y,s):
 for sign in (-1,1):
  for i in range(3):
   a=x+sign*(i+1)*s*.13;b=y-i*s*.23;d.line([(x,y+s*.3),(a,b)],fill=shade,width=1);d.ellipse((a-s*.08,b-s*.14,a+s*.08,b+s*.04),outline=gold,width=1)
 d.line((x,y+s*.36,x,y-s*.62),fill=gold,width=1);d.ellipse((x-2,y-s*.72,x+2,y-s*.52),fill=gold)
for yy in range(120,925,100):
 for xx in range((yy//100%2)*49,1024,98):sprig(xx,yy,14)
for yy in [4,10,17,973,993,1002,1012]:d.line((0,yy,1024,yy),fill=gold,width=2)
for xx in range(0,1024,19): sprig(xx,975,24);sprig(xx,29,17)
im.save(T+'embroidered.jpg',quality=93)
n=np.stack([128+5*np.sin(x*2.1),128+4*np.sin(y*2.05),np.full(x.shape,254)],2);Image.fromarray(n.astype('uint8')).save(T+'weave.png'); a=np.uint8(np.clip(np.array([229,214,181])+g[:,:,None]*.6,0,255));im=Image.fromarray(a);d=ImageDraw.Draw(im)
for xx in [3,8,15,1008,1015,1020]:d.line((xx,0,xx,1024),fill=(196,172,135),width=2)
im.save(T+'chiffon.jpg',quality=92)
D='/project/build/bl_user/extensions/.user/user_default/mpfb/data/hair/long01/';a=np.asarray(Image.open(D+'long01_diffuse.png').convert('RGBA').resize((1024,1024))).copy();v=a[:,:,:3].astype(float).mean(2);a[:,:,:3]=np.clip(5+v[:,:,None]*np.array([.245,.218,.205]),0,255);Image.fromarray(a).save(T+'black-hair.png')
