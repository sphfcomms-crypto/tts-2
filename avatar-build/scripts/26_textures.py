# 26_textures.py (system python: numpy, cv2) - all garment/hair textures, painted procedurally, plus the skin clean-up
# (anything outside the kept body faces is flattened to plain skin).   python3 26_textures.py
import json, math, numpy as np, cv2
T = '/project/w/tex/'; O = '/project/w/out/'
rng = np.random.default_rng(12)
def noise(h, w, sig, seed=0):
    r = np.random.default_rng(seed).standard_normal((h, w)).astype(np.float32); r = cv2.GaussianBlur(r, (0, 0), sig); return r / (np.abs(r).max() + 1e-6)
def tnoise(n, sig, seed=0):          # tileable noise
    r = np.random.default_rng(seed).standard_normal((n, n)).astype(np.float32); r = cv2.GaussianBlur(np.tile(r, (3, 3)), (0, 0), sig)[n:2 * n, n:2 * n]; return r / (np.abs(r).max() + 1e-6)
TEAL = np.array([120, 124, 84], np.float32)      # BGR dusty teal
CREAM = (196, 226, 236); GOLD = (112, 172, 205); CREAM2 = (176, 212, 228)
def flower(img, cx, cy, r, col=CREAM, ctr=GOLD, petals=6, rot=0.0):
    for k in range(petals):
        an = rot + 2 * math.pi * k / petals
        cv2.ellipse(img, (int(cx + 0.62 * r * math.cos(an)), int(cy + 0.62 * r * math.sin(an))), (max(1, int(r * 0.42)), max(1, int(r * 0.24))), math.degrees(an), 0, 360, col, -1, cv2.LINE_AA)
    cv2.circle(img, (int(cx), int(cy)), max(1, int(r * 0.24)), ctr, -1, cv2.LINE_AA)
def buti(img, cx, cy, r):
    cv2.line(img, (int(cx), int(cy + r * 0.6)), (int(cx), int(cy + r * 2.3)), CREAM2, max(1, int(r * 0.16)), cv2.LINE_AA)
    for sg in (-1, 1): cv2.ellipse(img, (int(cx + sg * r * 0.55), int(cy + r * 1.5)), (int(r * 0.55), int(r * 0.2)), sg * 35, 0, 360, CREAM2, -1, cv2.LINE_AA)
    flower(img, cx, cy, r)
# ---------------------------------------------------------------- kameez
J = json.load(open(O + 'kameez_uv.json')); TW, TH, S = J['TW'], J['TH'], J['S']
img = np.empty((TH, TW, 3), np.float32); img[:] = TEAL
img *= (1 + 0.035 * noise(TH, TW, 40, 1) + 0.02 * noise(TH, TW, 6, 2))[..., None]
img = np.clip(img, 0, 255).astype(np.uint8)
step = int(0.066 * S)
for iy, y in enumerate(range(step // 2, TH, step)):
    for x in range((step // 2) * (iy % 2), TW, step):
        buti(img, x + rng.integers(-3, 4), y + rng.integers(-3, 4), 0.0048 * S)
for nm, L in J['lay'].items():
    x0, w = int(L['x0']), int(L['w']); x1 = min(TW, x0 + w)
    for kind in ('hem', 'cuff', 'neck'):
        m = np.zeros((TH, x1 - x0), np.uint8); any_ = False
        for s in J['segs'][kind]:
            if x0 - 2 <= s[0] <= x1 + 2 and x0 - 2 <= s[2] <= x1 + 2:
                cv2.line(m, (int(s[0] - x0), int(s[1])), (int(s[2] - x0), int(s[3])), 255, 2); any_ = True
        if not any_: continue
        d = cv2.distanceTransform(255 - m, cv2.DIST_L2, 5); sub = img[:, x0:x1]
        band = {'hem': 0.105, 'cuff': 0.046, 'neck': 0.030}[kind] * S
        inb = d < band
        base = sub.astype(np.float32); dk = np.array([104, 109, 72], np.float32)          # slightly deeper ground under the border
        sub[inb] = (base[inb] * 0.25 + dk * 0.75).astype(np.uint8)
        lay = np.zeros_like(sub); lm = np.zeros(sub.shape[:2], np.uint8)
        def ring(a_, b_, col):
            r = (d >= a_) & (d < b_); lay[r] = col; lm[r] = 255
        ring(0, 0.0032 * S, CREAM); ring(band - 0.004 * S, band - 0.0015 * S, CREAM)
        if kind == 'hem':
            ring(0.008 * S, 0.0095 * S, GOLD); ring(0.085 * S, 0.0865 * S, GOLD)
            tmp = np.zeros_like(sub); pitch = int(0.042 * S); ys, xs = np.nonzero(m)
            yb = int(np.median(ys)) if len(ys) else TH - 30
            for cx in range(pitch // 2, x1 - x0, pitch):
                for row, (rr, dy) in enumerate(((0.0105, 0.024), (0.008, 0.045), (0.0058, 0.062), (0.004, 0.075))):
                    for k in range(-(3 - row), (3 - row) + 1, 2) if row < 3 else (0,):
                        flower(tmp, cx + k * 0.0052 * S * (1.1 if row == 0 else 0.9), yb - dy * S, rr * S * 0.55, petals=6 if row < 2 else 5)
                cv2.ellipse(tmp, (cx + pitch // 2, int(yb - 0.018 * S)), (int(0.004 * S), int(0.007 * S)), 0, 0, 360, GOLD, -1, cv2.LINE_AA)
            g = tmp.any(2) & inb; lay[g] = tmp[g]; lm[g] = 255
        else:
            tmp = np.zeros_like(sub); pitch = int((0.0125 if kind == 'neck' else 0.0145) * S); lo, hi = 0.0065 * S, band - 0.0065 * S
            for iy, cy in enumerate(range(0, TH, pitch)):
                for cx in range((pitch // 2) * (iy % 2), x1 - x0, pitch):
                    if cy < TH and cx < x1 - x0 and lo + 4 < d[cy, cx] < hi - 4: flower(tmp, cx, cy, pitch * 0.36, petals=5, rot=iy)
            g = tmp.any(2); lay[g] = tmp[g]; lm[g] = 255
        sub[lm > 0] = lay[lm > 0]
# front slit: short placket below the neckline
sx, sy = int(J['slit'][0]), int(J['slit'][1]); ln = int(0.075 * S); pw = int(0.011 * S)
cv2.rectangle(img, (sx - pw, sy - 6), (sx + pw, sy + ln), (104, 109, 72), -1)
for k in range(0, ln, int(0.0125 * S)):
    for sg in (-1, 1): flower(img, sx + sg * pw * 0.52, sy + 8 + k, pw * 0.3, petals=5)
for sg in (-1, 1): cv2.line(img, (sx + sg * pw, sy - 4), (sx + sg * pw, sy + ln), CREAM, 3, cv2.LINE_AA)
cv2.line(img, (sx - pw, sy + ln), (sx + pw, sy + ln), CREAM, 3, cv2.LINE_AA)
cv2.line(img, (sx, sy - 8), (sx, sy + ln - 8), (58, 66, 40), 3, cv2.LINE_AA)
for k in range(3): cv2.circle(img, (sx, sy + int(ln * (0.25 + 0.25 * k))), 4, GOLD, -1, cv2.LINE_AA)
img = cv2.GaussianBlur(img, (0, 0), 0.6)
cv2.imwrite(T + 'kameez_color.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 90])
# ---------------------------------------------------------------- tiles: plain lawn, weave normal, chiffon, khussa
n = 512
lawn = np.empty((n, n, 3), np.float32); lawn[:] = TEAL; lawn *= (1 + 0.035 * tnoise(n, 30, 3) + 0.02 * tnoise(n, 5, 4))[..., None]
cv2.imwrite(T + 'lawn_plain.jpg', np.clip(lawn, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 92])
yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
h = 0.5 * np.sin(2 * np.pi * xx / 4) * (0.6 + 0.4 * np.sin(2 * np.pi * yy / 8)) + 0.5 * np.sin(2 * np.pi * yy / 4) * (0.6 + 0.4 * np.sin(2 * np.pi * xx / 8 + 1.5)) + 0.35 * tnoise(n, 1.2, 5)
def normal_from(h, S_):
    dx = np.roll(h, -1, 1) - np.roll(h, 1, 1); dy = np.roll(h, 1, 0) - np.roll(h, -1, 0)
    nm = np.dstack([-dx * S_, -dy * S_, np.ones_like(h)]); nm /= np.linalg.norm(nm, axis=2, keepdims=True)
    return np.uint8((nm[..., ::-1] * 0.5 + 0.5) * 255 + 0.5)
cv2.imwrite(T + 'weave_normal.jpg', normal_from(h, 0.55), [cv2.IMWRITE_JPEG_QUALITY, 92])
n = 1024
ch = np.empty((n, n, 3), np.float32); ch[:] = (176, 211, 226)
cr = 0.6 * tnoise(n, 2.2, 6) + 0.4 * tnoise(n, 9, 7)
ch *= (1 + 0.045 * cr)[..., None]
for v in (10, n - 11):
    ch[max(0, v - 5):v + 6] *= np.array([0.86, 0.9, 0.93], np.float32)
cv2.imwrite(T + 'chiffon.jpg', np.clip(ch, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 92])
cv2.imwrite(T + 'chiffon_normal.jpg', normal_from(cv2.GaussianBlur(cr + 0.5 * tnoise(n, 0.9, 8), (0, 0), 0.7), 1.6), [cv2.IMWRITE_JPEG_QUALITY, 92])
n = 512
kh = np.empty((n, n, 3), np.uint8); kh[:] = (150, 196, 218)
for k in range(-n, 2 * n, 64):
    cv2.line(kh, (k, 0), (k + n, n), (84, 140, 178), 5, cv2.LINE_AA); cv2.line(kh, (k + n, 0), (k, n), (84, 140, 178), 5, cv2.LINE_AA)
for y in range(0, n, 64):
    for x in range(0, n, 64):
        flower(kh, x + 32, y, 15, col=(205, 232, 242), ctr=(70, 120, 170)); flower(kh, x, y + 32, 15, col=(205, 232, 242), ctr=(70, 120, 170))
cv2.imwrite(T + 'khussa.jpg', kh, [cv2.IMWRITE_JPEG_QUALITY, 92])
# ---------------------------------------------------------------- hair strands (RGBA): 4 card variants side by side, root at the top
HW, HH, SS = 1024, 1024, 2
col = np.zeros((HH * SS, HW * SS, 3), np.float32); alp = np.zeros((HH * SS, HW * SS), np.float32); hgt = np.zeros((HH * SS, HW * SS), np.float32)
r2 = np.random.default_rng(31); cw = HW * SS // 4
for c in range(4):
    x0 = c * cw
    if c == 0:
        col[:, x0:x0 + cw] = (0.030, 0.027, 0.026); alp[:, x0:x0 + cw] = 1.0
    ns = 150 if c == 0 else 95
    for i in range(ns):
        xc = x0 + cw * (0.03 + 0.94 * r2.random()); edge = abs((xc - x0) / cw - 0.5) * 2
        if c > 0 and r2.random() < edge ** 2 * 0.75: continue
        L = (1.0 if c == 0 else 1.0 - 0.45 * r2.random() ** 2 - 0.25 * edge ** 3) * HH * SS
        b = 0.018 + 0.06 * r2.random() ** 2; wd = int(r2.integers(2, 7 if c == 0 else 6)); A = r2.uniform(0.5, 3.5) * SS; f = r2.uniform(0.6, 2.2); ph = r2.uniform(0, 6.28)
        ys = np.arange(0, int(L), 6); xs = xc + A * np.sin(2 * np.pi * f * ys / (HH * SS) + ph) + (ys / (HH * SS)) * r2.uniform(-10, 10)
        pts = np.int32(np.c_[np.clip(xs, x0 + 2, x0 + cw - 3), ys]).reshape(-1, 1, 2)
        cv2.polylines(col, [pts], False, (b * 0.82, b * 0.9, b), wd, cv2.LINE_AA); cv2.polylines(alp, [pts], False, 1.0, wd, cv2.LINE_AA); cv2.polylines(hgt, [pts], False, float(0.4 + 0.6 * r2.random()), max(1, wd - 1), cv2.LINE_AA)
    tip = np.clip((HH * SS - np.arange(HH * SS)) / (0.06 * HH * SS), 0, 1)[:, None]
    if c == 0: alp[:, x0:x0 + cw] *= np.maximum(tip, (r2.random((1, cw)) > 0.5) * np.clip((HH * SS - np.arange(HH * SS)) / (0.02 * HH * SS), 0, 1)[:, None])
col = cv2.resize(col, (HW, HH), interpolation=cv2.INTER_AREA); alp = cv2.resize(alp, (HW, HH), interpolation=cv2.INTER_AREA); hgt = cv2.resize(hgt, (HW, HH), interpolation=cv2.INTER_AREA)
rf = np.clip((np.arange(HH)[:, None] / HH - 0.03 * cv2.GaussianBlur(r2.random((1, HW)).astype(np.float32), (0, 0), 1.5)) / 0.035, 0, 1); alp = alp * rf      # ragged fade-in at the roots: no square card ends on the scalp
bgc = np.array([0.030, 0.027, 0.026], np.float32); col = np.where(alp[..., None] > 0.02, col / np.maximum(alp[..., None], 0.02) * np.minimum(alp[..., None], 1) + bgc * (1 - np.minimum(alp[..., None], 1)), bgc)
rgba = np.dstack([np.clip(col, 0, 1) ** (1 / 2.2), np.clip(alp * 1.25, 0, 1)])
cv2.imwrite(T + 'hair.png', np.uint8(rgba * 255 + 0.5))
cv2.imwrite(T + 'hair_normal.jpg', normal_from(cv2.GaussianBlur(hgt, (0, 0), 0.8), 2.2), [cv2.IMWRITE_JPEG_QUALITY, 92])
# ---------------------------------------------------------------- skin clean-up outside the kept faces
try:
    polys = np.load(O + 'body_uv_polys.npy', allow_pickle=True)
    for name, size, fill in (('skin_color.jpg', 4096, None), ('skin_normal.png', 2048, (255, 128, 128)), ('skin_rough.png', 2048, None)):
        im = cv2.imread(T + name, cv2.IMREAD_UNCHANGED); m = np.zeros(im.shape[:2], np.uint8)
        for pl in polys: cv2.fillPoly(m, [np.int32(np.c_[pl[:, 0] * size, (1 - pl[:, 1]) * size])], 255)
        m = cv2.dilate(m, np.ones((5, 5), np.uint8), iterations=int(size / 2048 * 6)); mf = cv2.GaussianBlur(m, (0, 0), size / 2048 * 3).astype(np.float32) / 255
        if fill is None: fill = im[m > 0].reshape(-1, im.shape[2] if im.ndim == 3 else 1).mean(0) if name != 'skin_color.jpg' else np.median(im[(m > 0)].reshape(-1, 3)[::50], axis=0)
        f_ = np.empty_like(im, dtype=np.float32); f_[:] = fill
        out = im.astype(np.float32) * (mf[..., None] if im.ndim == 3 else mf) + f_ * (1 - (mf[..., None] if im.ndim == 3 else mf))
        nm2 = name.replace('.', '_clean.').replace('normal_clean.png', 'normal_clean.jpg')
        cv2.imwrite(T + nm2, np.uint8(np.clip(out, 0, 255) + 0.5), [cv2.IMWRITE_JPEG_QUALITY, 93]); print("CLEAN", nm2, "kept fraction %.3f" % (m > 0).mean())
except FileNotFoundError:
    print("no body_uv_polys.npy yet: skin clean-up skipped")
print("TEXTURES ok")
