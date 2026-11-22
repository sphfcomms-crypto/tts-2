"""What did the page really show and play? Measured from a recording made by record.mjs.

    python analyze.py <recording dir>

Prints one JSON summary and writes into the folder:
    mouth.csv        per picture: time, loudness of the voice heard then, how far her mouth is open
    onsets.jpg       her mouth, picture by picture, around the moments she starts to speak
    joins.jpg        the pictures on both sides of each change of body-language clip
    review.mp4       the recording as a film with its sound, to watch
"""
import json
import os
import subprocess
import sys
import wave

import cv2
import numpy as np

D = sys.argv[1]
PANEL = (80, 69, 800, 609)  # the avatar's box in the page: left, top, right, bottom

frames = json.load(open(f"{D}/frames.json"))
audio = json.load(open(f"{D}/audio.json"))
log = json.load(open(f"{D}/log.json"))
marks = json.load(open(f"{D}/marks.json"))
origin = audio["origin"]
T0 = frames[0][1]
ft = np.array([f[1] for f in frames]) - T0  # ms since the first picture

# ---------------------------------------------------------------- the sound, on the same clock
tracks = []
for a in audio["audio"]:
    if not a["file"]:
        continue
    with wave.open(f"{D}/{a['file']}") as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    clock = np.array(a["clock"])
    heard = np.median(clock[:, 1] - clock[:, 0] * 1000)  # performance ms at which context time 0 is heard
    start = origin + heard + a["firstFrame"] / a["rate"] * 1000 - T0  # ms since the first picture
    tracks.append({"x": x, "rate": a["rate"], "start": start,
                   "latency_ms": float(np.median((clock[:, 1] - clock[:, 0] * 1000) - (clock[:, 3] - clock[:, 2] * 1000)))})
if not tracks:
    print(json.dumps({"error": "the page played no sound through Web Audio"}))
    sys.exit(0)
track = max(tracks, key=lambda t: float(np.abs(t["x"]).sum()))


def loudness(at_ms, window_ms=40.0):
    """RMS of the voice heard in a window centred on each time."""
    x, rate = track["x"], track["rate"]
    half = int(window_ms / 2000 * rate)
    out = np.zeros(len(at_ms), np.float32)
    for i, t in enumerate(at_ms):
        c = int((t - track["start"]) / 1000 * rate)
        seg = x[max(0, c - half): max(0, c + half)]
        out[i] = float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0
    return out


# ---------------------------------------------------------------- her mouth in every picture
# Her eyes and nose, cut from one picture of the recording, are looked for in every picture: that
# says where her head is. (She sits at a fixed distance from a fixed camera, so the size is constant.)
TEMPLATE_BOX = (318, 70, 398, 125)   # in the avatar's box, in the picture named below
TEMPLATE_FROM = int(os.environ.get("TEMPLATE_FRAME", "300"))
_t = cv2.imread(f"{D}/frames/{frames[min(TEMPLATE_FROM, len(frames) - 1)][0]}")
_t = cv2.cvtColor(_t[PANEL[1]:PANEL[3], PANEL[0]:PANEL[2]], cv2.COLOR_BGR2GRAY)
template = _t[TEMPLATE_BOX[1]:TEMPLATE_BOX[3], TEMPLATE_BOX[0]:TEMPLATE_BOX[2]].copy()
if os.path.exists("template.png"):
    template = cv2.imread("template.png", cv2.IMREAD_GRAYSCALE)   # the same eyes for every recording
else:
    cv2.imwrite("template.png", template)
SCALE = 4  # the face is small in the picture: enlarge it before measuring
last = None
mouth = np.zeros(len(frames), np.float32)
found = np.zeros(len(frames), bool)
boxes = []
crops = []
prev_panel = None
change = np.zeros(len(frames), np.float32)
dark = np.zeros(len(frames), np.float32)
for i, (name, _) in enumerate(frames):
    img = cv2.imread(f"{D}/frames/{name}")
    if img is None:
        boxes.append(last); crops.append(None); continue
    panel = img[PANEL[1]:PANEL[3], PANEL[0]:PANEL[2]]
    gray = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA).astype(np.float32)
    if prev_panel is not None:
        change[i] = float(np.abs(small - prev_panel).mean())
    prev_panel = small
    dark[i] = float(small.mean())
    # Her head stays in the upper middle of the picture.
    region = gray[20:300, 200:520]
    score = cv2.matchTemplate(region, template, cv2.TM_CCOEFF_NORMED)
    _, best_score, _, where = cv2.minMaxLoc(score)
    box = np.array([where[0] + 200, where[1] + 20], np.float32)
    if best_score > 0.6:
        last = box if last is None else 0.5 * last + 0.5 * box  # steadied
        found[i] = True
    boxes.append(None if last is None else last.copy())
    if last is None:
        crops.append(None); continue
    tx, ty = last
    # The lower middle of the face: mouth and chin.
    x0, x1 = int(tx + 10), int(tx + 70)
    y0, y1 = int(ty + 52), int(ty + 100)
    crop = panel[y0:y1, x0:x1]
    if crop.size == 0:
        crops.append(None); continue
    big = cv2.resize(crop, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_CUBIC)
    crops.append(big)
    lab = cv2.cvtColor(big, cv2.COLOR_BGR2LAB).astype(np.float32)
    # Skin colour: the left and right edges of the crop (cheeks beside the mouth).
    edge = np.concatenate([lab[:, : big.shape[1] // 8].reshape(-1, 3), lab[:, -big.shape[1] // 8:].reshape(-1, 3)])
    skin = np.median(edge, axis=0)
    # An open mouth shows a dark opening and teeth; closed lips show neither. Both are counted in
    # the middle of the crop: far darker than skin, or bright and far less red than skin.
    hh, ww = lab.shape[:2]
    mid = lab[int(hh * 0.08): int(hh * 0.72), int(ww * 0.2): int(ww * 0.8)]
    opening = (skin[0] - mid[:, :, 0]) > 55
    teeth = (mid[:, :, 1] < skin[1] - 9) & (mid[:, :, 0] > skin[0] - 25)
    mouth[i] = (opening.sum() + teeth.sum()) / (SCALE * SCALE)   # area, in picture pixels
    if not found[i]:
        mouth[i] = np.nan

level = loudness(ft)

# ---------------------------------------------------------------- do lips and voice move together?
step = 20.0
grid = np.arange(0, ft[-1], step)
seen = ~np.isnan(mouth)
m = np.interp(grid, ft[seen], mouth[seen])
ok = np.interp(grid, ft, seen.astype(float)) > 0.99   # her face was found there
v = np.interp(grid, ft, level)
# smooth a little (one picture is ~37 ms)
k = np.ones(3) / 3
m_s = np.convolve(m, k, "same")
v_s = np.convolve(v, k, "same")
speaking = v_s > max(0.01, 0.15 * np.percentile(v_s, 95))
# only the part with speech (plus a little around it)
pad = (np.convolve(speaking.astype(float), np.ones(25), "same") > 0) & ok
lags = np.arange(-30, 31)  # x 20 ms
corr = []
for lag in lags:
    a = m_s[pad]
    b = np.roll(v_s, lag)[pad]  # voice moved later by `lag` steps: a match means the lips are that late
    corr.append(float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else 0.0)
corr = np.array(corr)
best = int(lags[int(corr.argmax())])

# Moments she starts to speak after a silence, and when her mouth opens for each.
OPEN = 0.25 * float(np.percentile(m_s[ok], 95) - np.percentile(m_s[ok], 5))
quiet = ~speaking
onsets = []
i = 1
while i < len(grid):
    if speaking[i] and quiet[max(0, i - 20): i].all():  # 0.4 s of silence before
        base = np.median(m_s[max(0, i - 20): i])
        j = i - 20
        opened = None
        while j < min(len(grid), i + 40):
            if m_s[j] > base + OPEN:
                opened = j; break
            j += 1
        onsets.append({"voice_s": round(grid[i] / 1000, 2),
                       "mouth_after_ms": None if opened is None else int((opened - i) * step),
                       "face_seen": bool(ok[max(0, i - 12): i + 25].all())})
        i += 25
    i += 1

# ---------------------------------------------------------------- what the page was doing (its own log)
rows = log["log"]
lt = np.array([origin + r[0] - T0 for r in rows])
front, lips_on, lips_t, front_t = [], [], [], []
for _, vids in rows:
    base = [x for x in vids if x[0] != "lips" and x[0]]
    f = max(base, key=lambda x: x[4]) if base else ["", 0, 1, 0, 0, 0]
    front.append(f[0]); front_t.append(f[1])
    lp = [x for x in vids if x[0] == "lips"]
    lips_on.append(bool(lp) and lp[0][3] > 0.5)
    lips_t.append(lp[0][1] if lp else 0)
front = np.array(front); lips_on = np.array(lips_on); lips_t = np.array(lips_t); front_t = np.array(front_t)
inside = (lt >= 0) & (lt <= ft[-1])
log_level = loudness(lt)
log_speaking = log_level > max(0.01, 0.15 * np.percentile(level, 95))
# units shown, in order
shown = []
for k_, name in enumerate(front):
    if not inside[k_]:
        continue
    if not shown or shown[-1][0] != name:
        shown.append([name, round(lt[k_] / 1000, 2), 0.0, 0.0])
    shown[-1][2] = round(lt[k_] / 1000, 2)
for s in shown:
    seg = (lt / 1000 >= s[1]) & (lt / 1000 <= s[2])
    s[3] = round(float(log_speaking[seg].mean()), 2) if seg.any() else 0.0
# stalls: the picture in front, or her lips while shown, not moving on
def stalls(times, active):
    out, run = [], 0.0
    for k_ in range(1, len(times)):
        if not (inside[k_] and active[k_] and active[k_ - 1]):
            run = 0.0; continue
        gap = lt[k_] - lt[k_ - 1]
        if abs(times[k_] - times[k_ - 1]) < 1e-4:
            run += gap
            if run >= 150 and (not out or lt[k_] - out[-1][0] * 1000 - out[-1][1] > 200):
                out.append([round(lt[k_] / 1000, 2), round(run)])
            elif run >= 150:
                out[-1][1] = round(run)
        else:
            run = 0.0
    return out
same_front = np.r_[False, front[1:] == front[:-1]]
front_stalls = stalls(front_t, same_front)
lips_stalls = stalls(lips_t, lips_on)

# joins between clips: how big is the jump in the picture there, against ordinary movement?
joins = []
for a_, b_ in zip(shown[:-1], shown[1:]):
    t = b_[1] * 1000
    idx = int(np.searchsorted(ft, t))
    lo, hi = max(1, idx - 3), min(len(ft) - 1, idx + 4)
    joins.append({"at_s": b_[1], "from": a_[0], "to": b_[0], "jump": round(float(change[lo:hi].max()), 2), "frame": idx})
ordinary = float(np.percentile(change[1:], 90))

loud = speaking & ok
still = (~pad) & ok
mouth_open_when_loud = float((m_s[loud] > np.median(m_s[still]) + OPEN).mean()) if loud.any() and still.any() else None
mouth_open_when_silent = float((m_s[still] > np.median(m_s[still]) + OPEN).mean()) if still.any() else None
summary = {
    "recording": {"seconds": round(ft[-1] / 1000, 1), "pictures": len(frames),
                  "pictures_per_second": round(len(frames) / (ft[-1] / 1000), 1),
                  "longest_gap_between_pictures_ms": round(float(np.diff(ft).max())),
                  "face_found_in": round(float(found.mean()), 3)},
    "sound": {"seconds_of_speech": round(float(speaking.sum() * step / 1000), 1),
              "reported_output_latency_ms": round(track["latency_ms"], 1)},
    "lip_sync": {"lips_late_by_ms_best_match": best * int(step), "match_at_best": round(float(corr.max()), 3),
                 "match_at_zero": round(float(corr[30]), 3),
                 "match_by_lag_ms": {str(int(l * step)): round(float(c), 2) for l, c in zip(lags, corr) if l % 5 == 0},
                 "mouth_open_share_while_voice": None if mouth_open_when_loud is None else round(mouth_open_when_loud, 2),
                 "mouth_open_share_while_silent": None if mouth_open_when_silent is None else round(mouth_open_when_silent, 2),
                 "face_seen_share": round(float(ok.mean()), 2),
                 "starts_of_speech": onsets},
    "lips_layer": {"shown_share_of_speech": round(float(lips_on[inside & log_speaking].mean()), 3) if (inside & log_speaking).any() else None,
                   "shown_share_of_silence": round(float(lips_on[inside & ~log_speaking].mean()), 3),
                   "stalls_while_shown": lips_stalls},
    "body": {"clips_in_order": [{"clip": s[0], "from_s": s[1], "to_s": s[2], "speech_share": s[3]} for s in shown],
             "front_stalls": front_stalls,
             "joins": joins, "ordinary_change_p90": round(ordinary, 2),
             "black_pictures": int((dark < 12).sum())},
    "notes": marks.get("notes", []),
}
print(json.dumps(summary, indent=1))
json.dump(summary, open(f"{D}/summary.json", "w"), indent=1)

with open(f"{D}/mouth.csv", "w") as f:
    f.write("ms,voice,mouth_px,face\n")
    for t, a_, b_, c_ in zip(ft, level, mouth, found):
        f.write(f"{t:.0f},{a_:.4f},{b_:.2f},{int(c_)}\n")

# ---------------------------------------------------------------- pictures to look at
def strip(indices, labels, path, height=None):
    cells = []
    for idx, text in zip(indices, labels):
        c = crops[idx]
        if c is None:
            continue
        c = cv2.resize(c, (150, 120))
        cv2.putText(c, text, (3, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (0, 255, 255), 1, cv2.LINE_AA)
        cells.append(c)
    return np.hstack(cells) if cells else None

rows_img = []
for o in onsets[:5]:
    t = o["voice_s"] * 1000
    idx = [int(np.argmin(np.abs(ft - (t + d)))) for d in range(-240, 520, 60)]
    labels = [f"{int(ft[i] - t):+d}ms v{level[i] * 100:.0f} m{mouth[i]:.1f}" for i in idx]
    r = strip(idx, labels, None)
    if r is not None:
        rows_img.append(r)
if rows_img:
    w = min(r.shape[1] for r in rows_img)
    cv2.imwrite(f"{D}/onsets.jpg", np.vstack([r[:, :w] for r in rows_img]))

join_rows = []
for j in joins[:8]:
    idx = [min(len(frames) - 1, max(0, j["frame"] + d)) for d in (-3, -2, -1, 0, 1, 2, 3)]
    cells = []
    for i in idx:
        img = cv2.imread(f"{D}/frames/{frames[i][0]}")
        p = cv2.resize(img[PANEL[1]:PANEL[3], PANEL[0]:PANEL[2]], (240, 180))
        cv2.putText(p, f"{ft[i] / 1000:.2f}s", (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)
        cells.append(p)
    row = np.hstack(cells)
    cv2.putText(row, f"{j['from']} -> {j['to']}  jump {j['jump']}", (4, 172), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)
    join_rows.append(row)
if join_rows:
    cv2.imwrite(f"{D}/joins.jpg", np.vstack(join_rows))

# ---------------------------------------------------------------- a film of it, with its sound
with open(f"{D}/list.txt", "w") as f:
    for (name, _), dur in zip(frames, np.r_[np.diff(ft), 40.0]):
        f.write(f"file 'frames/{name}'\nduration {max(dur, 1) / 1000:.4f}\n")
x = track["x"]
shift = track["start"] / 1000  # sound starts this long after the first picture
if shift >= 0:
    x = np.r_[np.zeros(int(shift * track["rate"]), np.float32), x]
else:
    x = x[int(-shift * track["rate"]):]
with wave.open(f"{D}/aligned.wav", "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(track["rate"])
    w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-i", "aligned.wav",
                "-vf", f"crop={PANEL[2] - PANEL[0]}:{PANEL[3] - PANEL[1]}:{PANEL[0]}:{PANEL[1]},fps=30",
                "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest",
                "review.mp4"], cwd=D)
