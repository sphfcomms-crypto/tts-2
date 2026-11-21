# 16_skin.py (system python) - composite the final skin: colour-match the MakeHuman base skin to the photo (global gain plus a
# local low-frequency ratio near the face), blend the baked photo in, darken the scalp under the hair, derive normal + roughness.
#   python3 16_skin.py TEXDIR
import sys, numpy as np, cv2
T = sys.argv[1]; S4 = 4096
P = cv2.imread(T + '/bk_photo.png').astype(np.float32) / 255
MK = cv2.resize(cv2.imread(T + '/bk_mask.png'), (S4, S4), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255
M, scalp, lips = MK[..., 2], MK[..., 1], MK[..., 0]
shine = cv2.imread(T + '/bk_shine.png', 0).astype(np.float32) / 255
base = cv2.resize(cv2.imread('/project/build/tex/skin_base.png'), (S4, S4), interpolation=cv2.INTER_LANCZOS4).astype(np.float32) / 255
lin = lambda c: np.power(np.clip(c, 0, 1), 2.2); srgb = lambda c: np.power(np.clip(c, 0, 1), 1 / 2.2)
Pl, Bl = lin(P), lin(base)
luma = P @ np.array([0.114, 0.587, 0.299], np.float32)
skin = ((M > 0.9) & (luma > 0.42) & (lips < 0.05)).astype(np.float32)
gain = (Pl * skin[..., None]).sum((0, 1)) / (Bl * skin[..., None]).sum((0, 1))
print("global gain BGR", gain, "photo skin mean sRGB (BGR)", (P * skin[..., None]).sum((0, 1)) / skin.sum())
sg = 110
num = cv2.GaussianBlur(Pl * skin[..., None], (0, 0), sg); den = cv2.GaussianBlur(Bl * skin[..., None], (0, 0), sg); cf = cv2.GaussianBlur(skin, (0, 0), sg)
c = np.clip(cf / 0.12, 0, 1)[..., None]
ratio = (num / (den + 1e-5)) * c + gain * (1 - c)
Bc = srgb(Bl * ratio)
C = Bc * (1 - M[..., None]) + P * M[..., None]
hair = np.array([0.045, 0.05, 0.06], np.float32)          # BGR near-black brown
k = (np.clip(scalp * 1.15, 0, 1) * (1 - M) * 0.97)[..., None]
C = C * (1 - k) + hair * k
cv2.imwrite(T + '/skin_color.jpg', np.uint8(np.clip(C, 0, 1) * 255 + 0.5), [cv2.IMWRITE_JPEG_QUALITY, 93])
# normal: fine relief from the albedo luminance (pores, slight unevenness) + micro noise; damped on hair/brows
C2 = cv2.resize(C, (2048, 2048), interpolation=cv2.INTER_AREA)
g = C2 @ np.array([0.114, 0.587, 0.299], np.float32)
hp = (g - cv2.GaussianBlur(g, (0, 0), 1.6)) + 0.5 * (cv2.GaussianBlur(g, (0, 0), 1.2) - cv2.GaussianBlur(g, (0, 0), 5))
rng = np.random.default_rng(7); nz = rng.standard_normal(g.shape).astype(np.float32)
nz = cv2.GaussianBlur(nz, (0, 0), 0.8) - cv2.GaussianBlur(nz, (0, 0), 2.2)
damp = 1 - np.clip(cv2.GaussianBlur((g < 0.22).astype(np.float32), (0, 0), 3) * 2.5, 0, 1) * 0.8
h = (hp * 1.0 + nz * 0.035) * damp
dx = np.roll(h, -1, 1) - np.roll(h, 1, 1); dy = np.roll(h, 1, 0) - np.roll(h, -1, 0)
S = 3.0
nm = np.dstack([-dx * S, -dy * S, np.ones_like(h)]); nm /= np.linalg.norm(nm, axis=2, keepdims=True)
cv2.imwrite(T + '/skin_normal.png', np.uint8((nm[..., ::-1] * 0.5 + 0.5) * 255 + 0.5))
# roughness: matte skin, shinier T-zone / cheek tops / lips, satin where the scalp hair is painted
M2 = cv2.resize(M, (2048, 2048), interpolation=cv2.INTER_AREA); sc2 = cv2.resize(scalp, (2048, 2048), interpolation=cv2.INTER_AREA)
r = 0.62 - 0.25 * shine * M2
r = r * (1 - sc2 * 0.4) + 0.5 * sc2 * 0.4
cv2.imwrite(T + '/skin_rough.png', np.uint8(np.clip(r, 0, 1) * 255 + 0.5))
print("SKIN ok")
