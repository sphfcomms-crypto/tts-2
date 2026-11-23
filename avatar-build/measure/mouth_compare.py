"""How one clip's face compares with another's for the same line.

    python mouth_compare.py <reference.json> <test.json> [<test.json> ...]      (tracks from mouth_track.py)

Prints the same numbers for each (how far her lips open, how much her mouth narrows and widens,
blinks, brow and head movement, how sharp the mouth area is), and for each test clip how closely
its mouth follows the reference's over time, at the delay where they agree best.
"""
import json
import sys

import numpy as np


def load(path):
    rows = [r for r in json.load(open(path))["rows"] if r["found"]]
    t = np.array([r["t"] for r in rows])
    cols = {k: np.array([r.get(k, 0.0) for r in rows]) for k in ("gap", "width", "brow", "lids", "sharp", "eyes_px")}
    return t, cols, np.array([r["head"] for r in rows])


def stats(t, c, head):
    lids = c["lids"]
    return {
        "lips_apart_median": round(float(np.median(c["gap"])), 3), "lips_apart_p95": round(float(np.percentile(c["gap"], 95)), 3),
        "mouth_width_p5_p95": [round(float(np.percentile(c["width"], q)), 3) for q in (5, 95)],
        "blinks": int(((lids[1:] < 0.6 * np.median(lids)) & (lids[:-1] >= 0.6 * np.median(lids))).sum()),
        "brow_travel": round(float(np.percentile(c["brow"], 95) - np.percentile(c["brow"], 5)), 3),
        "head_travel": [round(float(v), 4) for v in (np.percentile(head, 95, 0) - np.percentile(head, 5, 0))],
        "mouth_speed_p90": round(float(np.percentile(np.abs(np.diff(c["gap"])) / np.diff(t), 90)), 2),
        "mouth_sharpness_median": round(float(np.median(c["sharp"])), 1),
        "eyes_px": round(float(np.median(c["eyes_px"])), 1), "seconds": round(float(t[-1]), 2),
    }


rt, rc, rh = load(sys.argv[1])
print("reference", json.dumps(stats(rt, rc, rh)))
for path in sys.argv[2:]:
    t, c, h = load(path)
    grid = np.arange(0, min(rt[-1], t[-1]), 0.01)
    follows = {}
    for key in ("gap", "width"):
        a = np.interp(grid, rt, rc[key])
        a = (a - a.mean()) / a.std()
        best, zero = None, None
        for lag in range(-40, 41):
            b = np.interp(grid + lag * 0.01, t, c[key])
            b = (b - b.mean()) / b.std()
            r = float(np.mean(a * b))
            if lag == 0:
                zero = r
            if best is None or r > best[1]:
                best = (lag * 10, r)
        follows[key] = {"match_at_0ms": round(zero, 3), "best_match": round(best[1], 3), "at_lag_ms": best[0]}
    print(path.split("/")[-1], json.dumps(stats(t, c, h)), "\n   follows reference:", json.dumps(follows))
