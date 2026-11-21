# grid.py OUT COLS CELLW img1 img2 ... : labelled grid contact sheet
import sys, os
from PIL import Image, ImageDraw
out, cols, cw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
ims = []
for p in sys.argv[4:]:
    im = Image.open(p).convert('RGB'); h = int(im.height * cw / im.width)
    im = im.resize((cw, h), Image.LANCZOS)
    ImageDraw.Draw(im).text((6, 4), os.path.basename(p)[:-4], fill=(255, 255, 0))
    ims.append(im)
ch = max(i.height for i in ims); rows = (len(ims) + cols - 1) // cols
s = Image.new('RGB', (cols * cw, rows * ch), (40, 40, 40))
for k, i in enumerate(ims):
    s.paste(i, ((k % cols) * cw, (k // cols) * ch))
s.save(out, quality=88); print(out, s.size)
