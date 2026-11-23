"""Her mouth against her voice: numbers for one tracked video (see mouth_track.py).

    python mouth_stats.py <track.json> [<audio.wav>]
"""
import json
import sys

import numpy as np
import soundfile as sf

track = json.load(open(sys.argv[1]))
rows = [r for r in track["rows"] if r["found"]]
t = np.array([r["t"] for r in rows])
col = lambda k: np.array([r[k] for r in rows])
gap, width, outer, jaw, brow, lids = (col(k) for k in ("gap", "width", "outer", "jaw", "brow", "lids"))
head = np.array([r["head"] for r in rows])

out = {
    "frames": track["frames"], "face_found": len(rows),
    "fps": round(float((len(t) - 1) / (t[-1] - t[0])), 2),
    "mouth_gap": {"p5": round(float(np.percentile(gap, 5)), 3), "median": round(float(np.median(gap)), 3),
                  "p95": round(float(np.percentile(gap, 95)), 3), "max": round(float(gap.max()), 3)},
    "mouth_width": {"p5": round(float(np.percentile(width, 5)), 3), "p95": round(float(np.percentile(width, 95)), 3)},
    "jaw_travel": round(float(np.percentile(jaw, 95) - np.percentile(jaw, 5)), 3),
    "brow_travel": round(float(np.percentile(brow, 95) - np.percentile(brow, 5)), 3),
    "blinks": int(((lids[1:] < 0.6 * np.median(lids)) & (lids[:-1] >= 0.6 * np.median(lids))).sum()),
    "head_travel_share_of_frame": [round(float(v), 4) for v in (np.percentile(head, 95, 0) - np.percentile(head, 5, 0))],
    # how quickly the mouth changes from one picture to the next (per second, in eye-distances)
    "mouth_speed_median": round(float(np.median(np.abs(np.diff(gap)) / np.diff(t))), 3),
    "mouth_speed_p90": round(float(np.percentile(np.abs(np.diff(gap)) / np.diff(t), 90)), 3),
}

if len(sys.argv) > 2:
    x, rate = sf.read(sys.argv[2], dtype="float32", always_2d=True)
    x = x.mean(1)
    step = 0.01
    n = int(len(x) / rate / step)
    win = int(0.04 * rate)
    env = np.array([np.sqrt((x[max(0, int(i * step * rate) - win // 2): int(i * step * rate) + win // 2] ** 2).mean() + 1e-12)
                    for i in range(n)])
    grid = np.arange(n) * step
    g = np.interp(grid, t, gap)
    voiced = env > 0.01
    out["voiced_share"] = round(float(voiced.mean()), 3)
    out["gap_when_voiced"] = round(float(g[voiced].mean()), 3)
    out["gap_when_silent"] = round(float(g[~voiced].mean()), 3)
    # the lag at which mouth opening follows loudness best (+ : mouth after the sound)
    e = np.log(env + 1e-3)
    e = (e - e.mean()) / e.std()
    gz = (g - g.mean()) / g.std()
    best = None
    curve = {}
    for lag in range(-30, 31):          # 10 ms steps
        if lag >= 0:
            r = float(np.mean(e[:n - lag] * gz[lag:]))
        else:
            r = float(np.mean(e[-lag:] * gz[:n + lag]))
        curve[lag * 10] = round(r, 3)
        if best is None or r > best[1]:
            best = (lag * 10, r)
    out["mouth_follows_loudness"] = {"best_lag_ms": best[0], "correlation": round(best[1], 3),
                                     "at_0ms": curve[0], "meaning": "+ lag: the mouth moves after the sound"}
print(json.dumps(out, indent=1))
