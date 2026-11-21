# 00_textures.py (system python3 + PIL/numpy): tune MakeHuman CC0 skin albedo to warm wheatish, even out blotches,
# derive a pore normal map, darken the iris.  Usage: python3 00_textures.py
import numpy as np, os
from PIL import Image, ImageFilter
D = '/project/build/bl_user/extensions/.user/user_default/mpfb/data/'
T = '/project/build/tex/'
os.makedirs(T, exist_ok=True)
def s2l(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def l2s(c): return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)
im = Image.open(D + 'skins/cutoff3d_indian_female_skin/indian_skin2e.png').convert('RGB')
def blur(img, r): return np.asarray(img.filter(ImageFilter.GaussianBlur(r)), dtype=np.float32) / 255.0
a = np.asarray(im, dtype=np.float32) / 255.0
low = blur(im, 28); mid = blur(im, 3)
ev = low + 0.45 * (mid - low) + 1.0 * (a - mid)          # damp mid-frequency blotches, keep pores
lin = s2l(np.clip(ev, 0, 1))
# per-channel gain in linear space towards a warm wheatish albedo (measured on the cheek area of the atlas)
GAIN = np.array([float(x) for x in os.environ.get('SKIN_GAIN', '0.90,0.82,0.73').split(',')], dtype=np.float32)
lin = lin * GAIN
out = np.clip(l2s(lin), 0, 1)
Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(T + 'skin_base.png')
# normal map from albedo luminance high-pass (pores / fine skin texture)
g = np.asarray(im.convert('L'), dtype=np.float32) / 255.0
gb = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(2.0)), dtype=np.float32) / 255.0
h = (g - gb)
h = np.asarray(Image.fromarray(np.uint8(np.clip(h * 4 + 0.5, 0, 1) * 255)).filter(ImageFilter.GaussianBlur(0.6)), dtype=np.float32) / 255.0
dx = np.roll(h, -1, 1) - np.roll(h, 1, 1); dy = np.roll(h, 1, 0) - np.roll(h, -1, 0)
S = 2.2
n = np.dstack([-dx * S, -dy * S, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
Image.fromarray(np.uint8((n * 0.5 + 0.5) * 255)).save(T + 'skin_normal.png')
# eyes: dark brown iris
e = Image.open(D + 'eyes/materials/brown_eye.png').convert('RGBA')
ea = np.asarray(e, dtype=np.float32) / 255.0
rgb = ea[..., :3]; mx = rgb.max(2); mn = rgb.min(2); sat = (mx - mn) / np.maximum(mx, 1e-4)
m = np.clip((sat - 0.18) / 0.2, 0, 1)[..., None]
m = np.asarray(Image.fromarray(np.uint8(m[..., 0] * 255)).filter(ImageFilter.GaussianBlur(3)), dtype=np.float32)[..., None] / 255.0
rgb2 = rgb * (1 - m) + (rgb * np.array([0.42, 0.36, 0.33])) * m
rgb2 = rgb2 * np.array([0.93, 0.93, 0.94])     # slightly less paper-white sclera
ea2 = np.dstack([np.clip(rgb2, 0, 1), np.ones_like(mx)])
Image.fromarray(np.uint8(ea2 * 255)).convert('RGB').save(T + 'eye.png')
for src, dst in (('teeth/teeth_base/teeth.png', 'teeth.png'), ('tongue/tongue01/tongue01_diffuse.png', 'tongue.png')):
    t = Image.open(D + src).convert('RGBA')
    bg = Image.new('RGBA', t.size, (150, 60, 60, 255)); bg.alpha_composite(t)
    bg.convert('RGB').resize((1024, 1024), Image.LANCZOS).save(T + dst)
print("textures done", out.reshape(-1, 3).mean(0))
