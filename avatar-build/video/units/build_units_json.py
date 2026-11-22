#!/usr/bin/env python
"""Writes public/avatar/video/units.json from the unit files the browser plays.

    python build_units_json.py            (run after lock_background.py)

For each unit: its pool (what she is doing when it suits), the other moments it also suits, how
often it is chosen against the others, and where its movement is: the frame at which she leaves
the rest pose ("rise") and the frame from which she returns to it ("release"), measured as the
distance of each frame from the unit's first frame. A unit in which she hardly moves has neither.
"""
import json
import os
import subprocess

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "..", "..", "public", "avatar", "video")

#        name              pool      also      weight
UNITS = [
    ("listen_still",   "listen", ["idle"], 3),
    ("listen_nod",     "listen", [],       2),
    ("listen_smile",   "listen", ["idle"], 2),
    ("listen_wow",     "listen", [],       1),
    ("listen_look",    "idle",   [],       2),
    ("listen_breath",  "idle",   [],       2),
    ("listen_dupatta", "idle",   [],       0.6),
    ("talk_open",      "talk",   [],       1),
    ("talk_right",     "talk",   [],       1),
    ("talk_chest",     "talk",   [],       1),
    ("talk_shrug",     "talk",   [],       0.7),
    ("talk_count",     "talk",   [],       0.8),
    ("talk_both",      "talk",   [],       1),
    ("talk_lean",      "talk",   [],       1),
    ("greet",          "greet",  [],       1),
    ("think",          "think",  [],       1),
]
W, H = 160, 120


def frames(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H},format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)


units = []
for name, pool, also, weight in UNITS:
    path = os.path.join(WEB, "units", name + ".mp4")
    if not os.path.exists(path):
        print(f"{name}: no file, left out")
        continue
    f = frames(path)
    d = np.convolve(np.abs(f - f[0]).mean(axis=(1, 2)), np.ones(3) / 3, "same")
    unit = {"name": name, "frames": len(f), "pool": pool}
    if also:
        unit["also"] = also
    if weight != 1:
        unit["weight"] = weight
    most = float(d.max())
    if most >= 3.0:
        unit["rise"] = max(0, int(np.argmax(d > 0.25 * most)) - 2)
        # her way back is never shorter than about half a second
        unit["release"] = min(int(len(d) - 1 - np.argmax(d[::-1] > 0.6 * most)), len(d) - 14)
    print(f"{name:15s} {len(f)} frames, {pool:6s} movement {most:4.1f}"
          + (f", leaves rest at {unit['rise']}, starts back at {unit['release']}" if "rise" in unit else ", at rest throughout"))
    units.append(unit)

with open(os.path.join(WEB, "units.json"), "w") as out:
    json.dump({"fps": 25, "width": 960, "height": 720, "units": units}, out, indent=1)
print(f"{len(units)} units written")
