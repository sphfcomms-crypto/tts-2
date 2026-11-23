"""Build the five filmed speaking takes' native head coordinates for head_pose.py.

Run with OpenCV, MediaPipe 0.10.x, NumPy and SciPy wherever the original
browser MP4s are available. The GPU service needs only the resulting NPZ.
"""
import argparse
import hashlib
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from scipy.ndimage import gaussian_filter1d

SPEAKING = ("oa1_talk_ask", "oa1_talk_emphasize", "oa1_talk_explain", "oa1_talk_reflect", "oa1_talk_warm")


def source_geometry(source):
    capture = cv2.VideoCapture(str(source))
    coordinates = []
    try:
        with mp.solutions.face_mesh.FaceMesh(static_image_mode=False, max_num_faces=1,
                                              refine_landmarks=True, min_detection_confidence=.5) as mesh:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                if frame.shape[:2] != (720, 960):
                    raise ValueError(f"Unexpected resolution in {source}")
                # The native 960x720 portrait has its head fully inside this crop.
                head = frame[:310, 295:655]
                result = mesh.process(cv2.cvtColor(head, cv2.COLOR_BGR2RGB))
                if not result.multi_face_landmarks:
                    raise ValueError(f"Missing face in {source}, frame {len(coordinates)}")
                points = result.multi_face_landmarks[0].landmark
                left, right, top, chin = np.array(
                    [[points[i].x * 360 + 295, points[i].y * 310] for i in (234, 454, 10, 152)]
                )
                cx, cy = (left + right) / 2
                coordinates.append([cx, cy, np.linalg.norm(right-left), chin[1]-top[1], chin[1]])
        if not coordinates or len(coordinates) != round(capture.get(cv2.CAP_PROP_FRAME_COUNT)):
            raise ValueError(f"Incomplete video {source}")
        return gaussian_filter1d(np.asarray(coordinates), 1.4, axis=0, mode="nearest").astype(np.float32)
    finally:
        capture.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("units", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    values = {}
    for name in SPEAKING:
        path = args.units / (name + ".mp4")
        values[name] = source_geometry(path)
        with path.open("rb") as file:
            values[name + "_sha256"] = hashlib.file_digest(file, "sha256").hexdigest()
    np.savez_compressed(args.output, **values)
