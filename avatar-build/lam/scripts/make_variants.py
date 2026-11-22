"""Input variations tried for the avatar: square head-and-shoulders crops of the two source stills.

usage: make_variants.py <call-still.png> <body-still.png> <out dir>
"""
import sys
from PIL import Image

call, body, out = sys.argv[1:4]

im = Image.open(call).convert("RGB")       # 1168 x 880, head roughly x 322..827, y 18..572
im.crop((225, 0, 925, 700)).save(f"{out}/call-still-tight.png")

im = Image.open(body).convert("RGB")       # 1168 x 880, head roughly x 467..700, y 29..314
im.crop((330, 0, 840, 510)).save(f"{out}/body-still-crop.png")
print("written")
