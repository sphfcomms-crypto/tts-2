#!/usr/bin/env python
"""Puts another room behind her without filming her again.

    python fit_room.py NEW_ROOM.png [--write]

The page shows the room as one still picture (room.webp) laid over the video everywhere outside
the zone she moves in. So the room can be changed by changing that picture, as long as the new
room is the old one right at the edge of her zone, where picture and video meet.

NEW_ROOM is a picture of her in the redecorated room, made from the same still (same camera,
same chair, same pose). It is brought to 960x720, lined up with the old room on her and the chair
(a shift and a small change of size are allowed for), and joined to the old room: the old room
stays in her zone and a little way round it, the new room takes over further out, with a soft
blend between. Without --write it only saves previews next to NEW_ROOM; with it, it writes
public/avatar/video/room.webp and poster.jpg (the old ones are kept in ../rooms as
*.before-<stem>; the room she was filmed in is ../rooms/room.original.webp).
"""
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "..", "..", "public", "avatar", "video")
W, H = 960, 720


def first_frame(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "bgr24",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3)


def main():
    new_path = sys.argv[1]
    write = "--write" in sys.argv
    stem = os.path.splitext(os.path.basename(new_path))[0]

    # The room as it is now, and her zone (clear in room.webp).
    room_file = os.path.join(WEB, "room.webp")
    rooms = os.path.join(HERE, "..", "rooms")
    os.makedirs(rooms, exist_ok=True)
    original = os.path.join(rooms, "room.original.webp")
    if not os.path.exists(original):
        shutil.copy(room_file, original)          # the room she was filmed in, kept for good
    old = cv2.imread(original, cv2.IMREAD_UNCHANGED)
    zone = 1 - old[..., 3].astype(np.float32) / 255            # 1 where the video shows
    rest = first_frame(os.path.join(WEB, "units", "listen_still.mp4")).astype(np.float32)   # her, at rest

    new = cv2.imread(new_path)
    new = cv2.resize(new, (W, H), interpolation=cv2.INTER_AREA).astype(np.float32)

    # Line the new picture up with the old one on her and the chair.
    core = (zone > 0.98).astype(np.uint8)
    a = cv2.cvtColor(rest.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    b = cv2.cvtColor(new.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(a, b, warp, cv2.MOTION_AFFINE,
                                       (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), core, 5)
    except cv2.error as err:
        print("could not line the pictures up:", err)
    fitted = cv2.warpAffine(new, warp, (W, H), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP,
                            borderMode=cv2.BORDER_REPLICATE)
    inside = core.astype(bool)
    print("shift x %.1f, y %.1f pixels; size %.3f, %.3f" % (warp[0, 2], warp[1, 2], warp[0, 0], warp[1, 1]))
    print("her and the chair, new against old (mean difference, levels): before lining up %.1f, after %.1f"
          % (np.abs(new - rest)[inside].mean(), np.abs(fitted - rest)[inside].mean()))

    # The old room stays in her zone and a little way round it; further out the new one takes over.
    near = cv2.dilate((zone > 0.02).astype(np.uint8), np.ones((33, 33), np.uint8)).astype(np.float32)
    keep = cv2.GaussianBlur(near, (0, 0), 14)[..., None]
    old_room = old[..., :3].astype(np.float32)
    plate = keep * old_room + (1 - keep) * fitted
    # How well do the two rooms agree where they are blended?
    band = (keep[..., 0] > 0.1) & (keep[..., 0] < 0.9)
    print("in the blend between the rooms they differ by %.1f levels on average (small = no seam)"
          % np.abs(fitted - old_room)[band].mean())

    shown = zone[..., None] * rest + (1 - zone[..., None]) * plate          # what the page shows at rest
    base = os.path.join(os.path.dirname(os.path.abspath(new_path)), stem)
    cv2.imwrite(base + "-page.jpg", shown.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 93])
    cv2.imwrite(base + "-fitted.jpg", fitted.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])

    if write:
        for name in ("room.webp", "poster.jpg"):
            path = os.path.join(WEB, name)
            if os.path.exists(path):
                shutil.copy(path, os.path.join(rooms, f"{name}.before-{stem}"))
        room = np.dstack([np.clip(plate, 0, 255).astype(np.uint8), old[..., 3]])
        cv2.imwrite(room_file, room, [cv2.IMWRITE_WEBP_QUALITY, 92])
        cv2.imwrite(os.path.join(WEB, "poster.jpg"), shown.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
        print("written: room.webp and poster.jpg")


if __name__ == "__main__":
    main()
