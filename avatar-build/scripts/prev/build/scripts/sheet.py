# sheet.py OUT HEIGHT img1 img2 ... : horizontal contact sheet (system python + PIL)
import sys
from PIL import Image
out, h = sys.argv[1], int(sys.argv[2])
ims = []
for p in sys.argv[3:]:
    im = Image.open(p).convert('RGB')
    w = int(im.width * h / im.height)
    ims.append(im.resize((w, h), Image.LANCZOS))
W = sum(i.width for i in ims)
s = Image.new('RGB', (W, h), (40, 40, 40))
x = 0
for i in ims:
    s.paste(i, (x, 0)); x += i.width
s.save(out, quality=88)
print(out, s.size)
