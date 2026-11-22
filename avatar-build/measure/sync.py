"""Exactly how far her lips were from her voice, picture by picture.

    python sync.py <recording dir>

The page keeps a list of every piece of lip video: which stretch of her voice it shows and where it
sits in the joined video. The recording has, sixty times a second, where that video really was,
and the audio clock says which instant of her voice was being heard then. The difference is the
error. Also checked: that the body under her lips is the clip and frame the lips were drawn on.
"""
import json
import sys

import numpy as np

D = sys.argv[1]
log = json.load(open(f"{D}/log.json"))
audio = json.load(open(f"{D}/audio.json"))
talk = log.get("talk")
if not talk or not talk["pieces"]:
    print(json.dumps({"error": "the page drew no lips in this recording"}))
    sys.exit(0)
pieces = sorted(talk["pieces"], key=lambda p: p["mediaStart"])
starts = np.array([p["mediaStart"] for p in pieces])

# The audio context her voice plays in: the one whose clock covers the pieces' times.
best = None
for a in audio["audio"]:
    clock = np.array(a["clock"])
    if not len(clock):
        continue
    span = (clock[:, 0].min(), clock[:, 0].max())
    inside = sum(1 for p in pieces if span[0] - 5 <= p["audioStart"] <= span[1] + 5)
    if best is None or inside > best[0]:
        best = (inside, clock)
clock = best[1]
heard_offset = float(np.median(clock[:, 1] - clock[:, 0] * 1000))   # context time c is heard at c*1000 + this
app_latency = float(np.median(np.where(clock[:, 4] > 0, clock[:, 4], clock[:, 5])))

errors, body, rows_speech, rows_shown = [], [], 0, 0
wrong_clip = 0
for perf, videos in log["log"]:
    lips = [v for v in videos if v[4] == 3]
    base = [v for v in videos if v[4] == 2]
    if not lips:
        continue
    lips = lips[0]
    # Which instant of her voice (as captured) is being heard at this moment?
    c_out = (perf - heard_offset) / 1000
    # Which piece covers it? (Each piece knows the delay its frames were chosen for.)
    due = None
    for p in pieces:
        hold = p.get("hold", p["lag"] - app_latency)
        a = c_out - hold
        if p["audioStart"] <= a < p["audioStart"] + p["length"]:
            due = (p, a)
            break
    if due is None:
        continue
    rows_speech += 1
    if lips[3] < 0.5:
        continue
    rows_shown += 1
    t = lips[1]
    k = int(np.searchsorted(starts, t + 1e-6) - 1)
    if k < 0:
        continue
    shown = pieces[k]
    if not (shown["mediaStart"] <= t < shown["mediaStart"] + shown["length"] + 0.08):
        continue
    a_shown = shown["audioStart"] + (t - shown["mediaStart"])
    hold = shown.get("hold", shown["lag"] - app_latency)
    errors.append((a_shown - (c_out - hold)) * 1000)      # + : picture ahead of the sound
    if base:
        b = base[0]
        expected = shown["frame"] + (t - shown["mediaStart"]) * 25
        if b[0] != shown["clip"]:
            wrong_clip += 1
        else:
            body.append(b[1] * 25 - expected)

errors = np.array(errors)
body = np.array(body)
out = {
    "pieces": len(pieces),
    "voice_delay_s": round(pieces[-1]["lag"], 2),
    "moments_with_speech_drawn": rows_speech,
    "lips_showing_share": round(rows_shown / rows_speech, 3) if rows_speech else None,
    "lips_vs_voice_ms": None if not len(errors) else {
        "median": round(float(np.median(errors))), "mean": round(float(errors.mean())),
        "p5": round(float(np.percentile(errors, 5))), "p95": round(float(np.percentile(errors, 95))),
        "share_within_45ms": round(float((np.abs(errors) <= 45).mean()), 3),
        "share_within_80ms": round(float((np.abs(errors) <= 80).mean()), 3),
        "worst": round(float(errors[np.abs(errors).argmax()])),
        "meaning": "+ picture ahead of the sound, - behind",
    },
    "body_under_lips": {
        "other_clip_share": round(wrong_clip / max(1, wrong_clip + len(body)), 3),
        "frames_off_median": None if not len(body) else round(float(np.median(body)), 2),
        "share_within_1_frame": None if not len(body) else round(float((np.abs(body) <= 1.0).mean()), 3),
        "share_within_2_frames": None if not len(body) else round(float((np.abs(body) <= 2.0).mean()), 3),
        "worst_frames": None if not len(body) else round(float(body[np.abs(body).argmax()]), 1),
    },
}
print(json.dumps(out, indent=1))
json.dump(out, open(f"{D}/sync.json", "w"), indent=1)
