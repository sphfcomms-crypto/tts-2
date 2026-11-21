# 14_prep.py (system python) - build the projection sources in render space (2048 px = the 0.26 m ortho window):
#   proj_photo.png : the reference photo, similarity-aligned, eye openings painted out to a soft dark lash-line tone
#   proj_shine.png : where skin is shinier (forehead, nose, cheek tops, chin, lips)
#   python3 14_prep.py PHOTO PREFIX OUTDIR
import sys, json, numpy as np, cv2
photo_p, prefix, out = sys.argv[1:4]
info = json.load(open(prefix + '_info.json')); T = np.load(prefix + '_lmT.npy'); res = info['res']; K = 2; R2 = res * K
photo = cv2.imread(photo_p)
big = cv2.resize(photo, None, fx=K, fy=K, interpolation=cv2.INTER_LANCZOS4)
bl = cv2.GaussianBlur(big, (0, 0), 1.6); big = cv2.addWeighted(big, 1.45, bl, -0.45, 0)        # mild unsharp
s = info['scale']; Rot = np.array(info['rot']); t = np.array(info['t'])
M = np.float32(np.c_[s * Rot.T, t * K])
pw = cv2.warpAffine(big, M, (R2, R2), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
L = T * K
RE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
LE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
m = np.zeros((R2, R2), np.uint8)
for idx in (RE, LE): cv2.fillPoly(m, [np.int32(L[idx])], 255)
m = cv2.erode(m, np.ones((3, 3), np.uint8))
mf = cv2.GaussianBlur(m, (0, 0), 2.0)[..., None] / 255.0
dark = np.zeros_like(pw); dark[:] = (30, 34, 52)        # BGR dark brown
pw2 = (pw * (1 - mf) + dark * mf).astype(np.uint8)
cv2.imwrite(out + '/proj_photo.png', pw2)
sh = np.zeros((R2, R2), np.float32)
def blob(c, ax, v):
    tmp = np.zeros_like(sh); cv2.ellipse(tmp, (int(c[0]), int(c[1])), (int(ax[0]), int(ax[1])), 0, 0, 360, float(v), -1); np.maximum(sh, tmp, out=sh)
u = K * res / 1024.0
blob((L[9] + L[10]) / 2 + [0, 6 * u], (95 * u, 42 * u), 0.8)
tmp = np.zeros_like(sh); cv2.polylines(tmp, [np.int32(L[[6, 197, 195, 5, 4]])], False, 1.0, int(16 * u)); np.maximum(sh, tmp, out=sh)
blob(L[4], (17 * u, 15 * u), 1.0)
blob(L[50] + [6 * u, -8 * u], (34 * u, 26 * u), 0.55); blob(L[280] + [-6 * u, -8 * u], (34 * u, 26 * u), 0.55)
blob(L[199], (24 * u, 16 * u), 0.5)
sh = cv2.GaussianBlur(sh, (0, 0), 13 * u)
lip = np.zeros_like(sh); cv2.fillPoly(lip, [np.int32(L[[61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]])], 1.0)
lip = cv2.GaussianBlur(lip, (0, 0), 2.5 * u)
sh = np.maximum(sh, lip)
cv2.imwrite(out + '/proj_shine.png', np.uint8(np.clip(sh, 0, 1) * 255))
print("PREP ok", pw2.shape)
