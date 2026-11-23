"""Her mouth, picture by picture, in any video: how far it is open, how wide, and when.

    python mouth_track.py <video> <out.json> [--crop x0,y0,x1,y1 as fractions of the frame]

Landmarks come from MediaPipe Face Mesh on an enlarged crop around her head. Every length is
divided by the distance between the outer eye corners, so clips of different sizes compare.
"""
import json
import subprocess
import sys

import cv2
import mediapipe as mp
import numpy as np

video = sys.argv[1]
out_path = sys.argv[2]
crop = (0.25, 0.0, 0.75, 0.50)
if "--crop" in sys.argv:
    crop = tuple(float(v) for v in sys.argv[sys.argv.index("--crop") + 1].split(","))

pts = subprocess.check_output([
    "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
    "-of", "csv=p=0", video]).decode().split()
pts = [float(p.strip(",")) for p in pts if p.strip(",")]

cap = cv2.VideoCapture(video)
w, h = int(cap.get(3)), int(cap.get(4))
x0, y0, x1, y1 = int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)
scale = max(1.0, 640.0 / (x1 - x0))
mesh = mp.solutions.face_mesh.FaceMesh(static_image_mode=False, refine_landmarks=True, max_num_faces=1,
                                       min_detection_confidence=0.4, min_tracking_confidence=0.4)

# inner lips 13/14, outer lips 0/17, mouth corners 61/291, outer eye corners 33/263,
# nose bridge 168, chin 152, brows 105/334 over the eye tops 159/386, eye bottoms 145/374
rows = []
i = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    part = frame[y0:y1, x0:x1]
    if scale > 1:
        part = cv2.resize(part, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    res = mesh.process(cv2.cvtColor(part, cv2.COLOR_BGR2RGB))
    row = {"t": pts[i] if i < len(pts) else None, "found": False}
    if res.multi_face_landmarks:
        lm = res.multi_face_landmarks[0].landmark
        ph, pw = part.shape[:2]
        p = lambda k: np.array([lm[k].x * pw, lm[k].y * ph]) / scale + (x0, y0)
        eyes = np.linalg.norm(p(263) - p(33))
        d = lambda a, b: float(np.linalg.norm(p(a) - p(b)) / eyes)
        row.update(
            found=True,
            eyes_px=float(eyes),
            gap=d(13, 14),            # inner lips apart
            outer=d(0, 17),           # outer lip height
            width=d(61, 291),         # corner to corner
            jaw=d(168, 152),          # nose bridge to chin
            brow=(d(105, 159) + d(334, 386)) / 2,
            lids=(d(159, 145) + d(386, 374)) / 2,
            head=[float(v) for v in (p(168) / (w, h))],
            roll=float(np.degrees(np.arctan2(*(p(263) - p(33))[::-1]))),
        )
    rows.append(row)
    i += 1
cap.release()
json.dump({"video": video, "width": w, "height": h, "frames": len(rows), "rows": rows}, open(out_path, "w"))
found = [r for r in rows if r["found"]]
print(f"{video}: {len(rows)} frames, face found in {len(found)}, eyes {np.mean([r['eyes_px'] for r in found]):.0f} px apart")
