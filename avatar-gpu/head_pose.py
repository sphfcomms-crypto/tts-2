"""Move the already rendered face, hair and upper neck together on the native filmed take."""
from pathlib import Path

import cv2
import numpy as np


ARCHIVE = Path(__file__).with_name("head-pose-geometry.npz")


def geometry_for(meta, archive=ARCHIVE):
    """Return per-frame source coordinates only for the exact calibrated performance."""
    name = meta["name"]
    if not name.startswith("oa1_talk_") or (meta["width"], meta["height"]) != (960, 720):
        return None
    try:
        with np.load(archive, allow_pickle=False) as data:
            if name not in data or str(data[name + "_sha256"]) != meta.get("source_sha256"):
                return None
            points = data[name]
    except (OSError, ValueError, KeyError):
        return None
    if points.shape != (meta["frames"], 5) or not np.isfinite(points).all() or (points[:, 2:4] <= 0).any():
        return None
    return points


def smoothstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def apply_angles(yuv, coordinates, angles):
    """Remap Y, U and V in place after lip synthesis. Angles are pitch, yaw and roll in degrees."""
    if angles.shape != (3,) or not np.isfinite(angles).all() or not np.any(angles):
        return False
    pitch, yaw, roll = np.deg2rad(np.clip(angles, -2.4, 2.4)).astype(np.float32)
    h, w = yuv.shape[0] * 2 // 3, yuv.shape[1]
    cx, cy, width, height, chin = coordinates
    rx, ry = .77 * width, .91 * height
    # Even bounds align the Y footprint with the camera's 4:2:0 chroma samples.
    x0 = max(0, int(cx - 1.38 * rx) // 2 * 2)
    x1 = min(w, (int(cx + 1.38 * rx) + 3) // 2 * 2)
    y0 = max(0, int(cy - 1.6 * ry) // 2 * 2)
    y1 = min(h, (int(chin + .47 * height) + 3) // 2 * 2)
    x = np.arange(x0, x1, dtype=np.float32)[None, :]
    y = np.arange(y0, y1, dtype=np.float32)[:, None]
    radius = np.sqrt(((x - cx) / rx) ** 2 + ((y - cy + .10 * height) / ry) ** 2)
    mix = smoothstep((1.26 - radius) / .38) * smoothstep((chin + .45 * height - y) / (.43 * height))
    depth = .45 * width * np.exp(-.5 * (((x - cx) / (.66 * width)) ** 2 + ((y - cy) / (.79 * height)) ** 2))
    dx = (yaw * depth - roll * (y - chin - .20 * height)) * mix
    dy = (-pitch * depth + roll * (x - cx)) * mix

    luma = yuv[:h]
    luma[y0:y1, x0:x1] = cv2.remap(luma, (x - dx).astype(np.float32), (y - dy).astype(np.float32),
                                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    # Average motion over the four Y pixels represented by each chroma sample.
    size = ((x1 - x0) // 2, (y1 - y0) // 2)
    chroma_x = x[:, ::2] * .5 - .5 * cv2.resize(dx, size, interpolation=cv2.INTER_AREA)
    chroma_y = y[::2] * .5 - .5 * cv2.resize(dy, size, interpolation=cv2.INTER_AREA)
    for plane in yuv[h:].reshape(2, h // 2, w // 2):
        plane[y0//2:y1//2, x0//2:x1//2] = cv2.remap(plane, chroma_x.astype(np.float32),
                                                       chroma_y.astype(np.float32), cv2.INTER_LINEAR,
                                                       borderMode=cv2.BORDER_REPLICATE)
    return True
