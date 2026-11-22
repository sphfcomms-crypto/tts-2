"""Exactly how far her lips were from her voice, picture by picture.

    python sync.py <recording dir>

The page keeps a list of every piece of lip video: which stretch of her voice it shows and where it
sits in the joined video. The recording has, sixty times a second, where that video really was,
and the audio clock says which instant of her voice was being heard then. The difference is the
error. Also checked: that the body under her lips is the clip and frame the lips were drawn on.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np

# Each 20 ms interval of recorded speaker output counts once, even when the
# browser draws slowly or the GPU never returns a piece. A frame-count based
# denominator would omit precisely those failures.
WINDOW_MS = 20
AUDIBLE_RMS = 0.01


def output_clock(entry):
    rows = np.asarray(entry.get("clock", []), dtype=float)
    if rows.ndim != 2 or rows.shape[1] < 2:
        return None
    # getOutputTimestamp() can return zeroes before audio starts.
    rows = rows[np.isfinite(rows[:, :2]).all(axis=1) & (rows[:, 1] > 0)]
    return rows if len(rows) else None


def output_offset(clock):
    return float(np.median(clock[:, 1] - 1000 * clock[:, 0]))


def audible_overlay(directory, tracks, rows, origin_delta):
    audible_bins = set()
    measured_tracks = 0
    for track in tracks:
        clock = output_clock(track)
        if clock is None or not track.get("file") or track.get("firstFrame") is None:
            continue
        path = directory / track["file"]
        if not path.is_file():
            continue
        with wave.open(str(path), "rb") as wav:
            if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
                continue  # record.mjs writes signed 16-bit mono PCM
            rate = wav.getframerate()
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
        start = origin_delta + output_offset(clock) + 1000 * track["firstFrame"] / rate
        end = start + 1000 * len(samples) / rate
        measured_tracks += 1
        # Put every context on the same performance clock so overlapping
        # output tracks cannot count the same audible time twice.
        for index in range(int(np.floor(start / WINDOW_MS)), int(np.ceil(end / WINDOW_MS))):
            first = max(0, round((index * WINDOW_MS - start) * rate / 1000))
            last = min(len(samples), round(((index + 1) * WINDOW_MS - start) * rate / 1000))
            if last > first:
                chunk = samples[first:last].astype(np.float32)
                if np.dot(chunk, chunk) > len(chunk) * (32768 * AUDIBLE_RMS) ** 2:
                    audible_bins.add(index)

    if not measured_tracks:
        return None
    times = np.array([perf for perf, _ in rows])
    visible = np.array([
        any(len(v) >= 6 and v[4] == 3 and v[3] >= 0.5 and v[5] >= 2 for v in videos)
        for _, videos in rows
    ], dtype=bool)
    # At each window centre, the last logged picture is the one on screen.
    # If there is no recorded picture or lip layer, that window is uncovered.
    centres = (np.array(sorted(audible_bins)) + 0.5) * WINDOW_MS
    shown = 0
    if len(times):
        frames = np.searchsorted(times, centres, side="right") - 1
        observed = (frames >= 0) & (centres <= times[-1])
        shown = int(visible[frames[observed]].sum())
    total = len(audible_bins)
    return {
        "window_ms": WINDOW_MS,
        "rms_threshold": AUDIBLE_RMS,
        "audible_windows": total,
        "windows_with_lip_overlay": shown,
        "share": round(shown / total, 3) if total else None,
    }


directory = Path(sys.argv[1])
log = json.loads((directory / "log.json").read_text())
audio_path = directory / "audio.json"
audio = json.loads(audio_path.read_text()) if audio_path.is_file() else {}
tracks = audio.get("audio", [])
pieces = sorted((log.get("talk") or {}).get("pieces", []), key=lambda p: p["mediaStart"])
origin_delta = audio["origin"] - log["origin"] if "origin" in audio and "origin" in log else 0
coverage = audible_overlay(directory, tracks, log["log"], origin_delta)
starts = np.array([p["mediaStart"] for p in pieces])

# The audio context her voice plays in: the one whose clock covers the pieces' times.
best = None
for a in tracks:
    clock = output_clock(a)
    if clock is None:
        continue
    span = (clock[:, 0].min(), clock[:, 0].max())
    inside = sum(1 for p in pieces if span[0] - 5 <= p["audioStart"] <= span[1] + 5)
    if best is None or inside > best[0]:
        best = (inside, clock)
if best is not None:
    clock = best[1]
    heard_offset = origin_delta + output_offset(clock)
    app_latency = 0
    if clock.shape[1] >= 6:
        app_latency = float(np.median(np.where(clock[:, 4] > 0, clock[:, 4], clock[:, 5])))

errors, body, rows_speech, rows_shown = [], [], 0, 0
wrong_clip = 0
for perf, videos in log["log"]:
    lips = [v for v in videos if v[4] == 3]
    base = [v for v in videos if v[4] == 2]
    if not lips or best is None:
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
    "voice_delay_s": round(pieces[-1]["lag"], 2) if pieces else None,
    "audible_output_coverage": coverage,
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
if not pieces:
    out["error"] = "the page drew no lips in this recording"
print(json.dumps(out, indent=1))
(directory / "sync.json").write_text(json.dumps(out, indent=1) + "\n")
