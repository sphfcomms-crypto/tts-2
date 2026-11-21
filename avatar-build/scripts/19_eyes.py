# 19_eyes.py (system python) - eye texture: MakeHuman brown eye, iris pushed to her dark brown with a darker limbal ring,
# sclera slightly warm and less paper-white.   python3 19_eyes.py OUT.png
import sys, numpy as np, cv2
D = '/project/build/bl_user/extensions/.user/user_default/mpfb/data/'
e = cv2.imread(D + 'eyes/materials/brown_eye.png', cv2.IMREAD_UNCHANGED).astype(np.float32) / 255
rgb = e[..., :3]
mx = rgb.max(2); mn = rgb.min(2); sat = (mx - mn) / np.maximum(mx, 1e-4)
m = cv2.GaussianBlur(np.clip((sat - 0.18) / 0.2, 0, 1), (0, 0), 3)[..., None]
iris = rgb * np.array([0.30, 0.36, 0.47], np.float32)            # BGR multipliers -> dark brown
out = rgb * (1 - m) + iris * m
scl = out * np.array([0.84, 0.87, 0.91], np.float32)             # warm, slightly grey sclera
out = out * m + scl * (1 - m)
cv2.imwrite(sys.argv[1], np.uint8(np.clip(out, 0, 1) * 255))
print("EYE tex", out.shape, "iris frac", float(m.mean()))
