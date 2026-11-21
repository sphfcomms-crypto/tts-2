# 12_fit.py (system python: mediapipe, cv2, scipy) - landmark the reference photo and the ortho render, similarity-align the
# photo to the render and write a dense 2D displacement field (render pixels) that moves the model's landmarks onto hers.
#   python3 12_fit.py PHOTO RENDER OUT_PREFIX
import sys, json, numpy as np, cv2, mediapipe as mp
from scipy.interpolate import RBFInterpolator
photo_p, render_p, out = sys.argv[1:4]
def lm(img):
    with mp.solutions.face_mesh.FaceMesh(static_image_mode=True, refine_landmarks=True, max_num_faces=1, min_detection_confidence=0.2) as fm:
        r = fm.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if not r.multi_face_landmarks: raise SystemExit("no face found")
    h, w = img.shape[:2]
    return np.array([[p.x * w, p.y * h] for p in r.multi_face_landmarks[0].landmark], dtype=np.float64)
photo = cv2.imread(photo_p); render = cv2.imread(render_p)
P = lm(photo); R = lm(render)
N = 468
def similarity(A, B):   # s*A@Rot+t ~= B
    ma, mb = A.mean(0), B.mean(0); A0, B0 = A - ma, B - mb
    U, S, Vt = np.linalg.svd(A0.T @ B0)
    d = np.sign(np.linalg.det(U @ Vt)); D = np.diag([1, d])
    Rot = U @ D @ Vt; s = (S * [1, d]).sum() / (A0 ** 2).sum()
    return s, Rot, mb - s * ma @ Rot
s, Rot, t = similarity(P[:N], R[:N])
T = s * P @ Rot + t                     # photo landmarks in render pixel space
D = T - R
res = render.shape[0]
print("similarity scale %.4f rot %.2f deg  t %s" % (s, np.degrees(np.arctan2(Rot[0, 1], Rot[0, 0])), t.round(1)))
print("landmark residual px: mean %.2f max %.2f" % (np.linalg.norm(D[:N], axis=1).mean(), np.linalg.norm(D[:N], axis=1).max()))
def irisd(L, a):   # iris diameter from the 4 rim points
    return (np.linalg.norm(L[a + 1] - L[a + 3]) + np.linalg.norm(L[a + 2] - L[a + 4])) / 2
info = dict(scale=s, rot=Rot.tolist(), t=t.tolist(), res=res,
            iris_photo=[irisd(T, 468), irisd(T, 473)], iris_render=[irisd(R, 468), irisd(R, 473)],
            iris_c_photo=[T[468].tolist(), T[473].tolist()], iris_c_render=[R[468].tolist(), R[473].tolist()])
print("iris diam px photo(in render space)", info['iris_photo'], "render", info['iris_render'])
g = 256
ys, xs = np.mgrid[0:g, 0:g]; pts = np.c_[xs.ravel(), ys.ravel()] * (res / g) + res / g / 2
rbf = RBFInterpolator(R[:N], D[:N], kernel='thin_plate_spline', smoothing=float(sys.argv[4]) if len(sys.argv) > 4 else 2.0)
F = rbf(pts).reshape(g, g, 2).astype(np.float32)
F = cv2.resize(F, (res, res), interpolation=cv2.INTER_CUBIC)
hull = cv2.convexHull(np.float32(np.r_[R[:N], T[:N]]))
m = np.zeros((res, res), np.uint8); cv2.fillConvexPoly(m, np.int32(hull), 255)
dist = cv2.distanceTransform(255 - m, cv2.DIST_L2, 5)
FALL = 150.0
w = np.clip(1 - dist / FALL, 0, 1); w = w * w * (3 - 2 * w)
F *= w[..., None]
np.save(out + '_field.npy', F)
np.save(out + '_lmP.npy', P); np.save(out + '_lmR.npy', R); np.save(out + '_lmT.npy', T)
json.dump(info, open(out + '_info.json', 'w'))
# overlay check: photo warped into render space, blended with the render, landmarks drawn
M = np.float32(np.c_[s * Rot.T, t])
pw = cv2.warpAffine(photo, M, (res, res), flags=cv2.INTER_LINEAR, borderValue=(128, 128, 128))
cv2.imwrite(out + '_photo_in_render.png', pw)
bl = cv2.addWeighted(pw, 0.5, render, 0.5, 0)
dr = render.copy()
for a, b in zip(R[:N], T[:N]):
    cv2.line(dr, tuple(np.int32(a)), tuple(np.int32(b)), (0, 0, 255), 1); cv2.circle(dr, tuple(np.int32(b)), 1, (0, 255, 0), -1)
cv2.imwrite(out + '_check.jpg', np.hstack([dr, bl, pw]), [cv2.IMWRITE_JPEG_QUALITY, 88])
