# sheet.py OUT H FILE... : horizontal contact sheet, each image scaled to height H; wraps rows with --cols N
import sys
from PIL import Image
out=sys.argv[1]; H=int(sys.argv[2]); files=sys.argv[3:]
cols=len(files)
if files[0].startswith('--cols='):
    cols=int(files[0].split('=')[1]); files=files[1:]
ims=[Image.open(f).convert('RGB') for f in files]
ims=[i.resize((max(1,round(i.width*H/i.height)),H),Image.LANCZOS) for i in ims]
rows=[ims[i:i+cols] for i in range(0,len(ims),cols)]
W=max(sum(i.width for i in r) for r in rows)
sh=Image.new('RGB',(W,H*len(rows)),(40,40,40))
y=0
for r in rows:
    x=0
    for i in r:
        sh.paste(i,(x,y)); x+=i.width
    y+=H
sh.save(out,quality=88)
print(out,sh.size)
