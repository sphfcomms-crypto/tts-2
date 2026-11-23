#!/usr/bin/env python
"""Feeds the whole-face server a voice recording the way a live call does: one slice at a time, at
the speed the voice is spoken. Saves what comes back as one film with the voice, and prints how
long each slice took from its first sound being spoken to its pictures being here.

    python test_client.py <server url> <voice.wav> <out.mp4> [--key-file key.txt] [--fast]
"""
import io
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import wave

import numpy as np
import soundfile as sf

url, voice, out = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
key_file = sys.argv[sys.argv.index("--key-file") + 1] if "--key-file" in sys.argv else "key.txt"
fast = "--fast" in sys.argv
ffmpeg = sys.argv[sys.argv.index("--ffmpeg") + 1] if "--ffmpeg" in sys.argv else "ffmpeg"
key = open(key_file).read().strip()


def call(path, data=None):
    req = urllib.request.Request(url + path, data=data, headers={"x-avatar-key": key})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read(), dict(res.headers)


health = json.loads(call("/health")[0])
frames, look, fps = health["slice_frames"], health["look_frames"], health["fps"]
x, rate = sf.read(voice, dtype="float32", always_2d=True)
x = x.mean(1)
if rate != 16000:
    import soxr
    x = soxr.resample(x, rate, 16000, quality="HQ")
per = frames * 16000 // fps
# The pictures of a slice show the sound from `look` pictures earlier, so the film needs that much
# more sound at the end, and its sound track starts that much later.
x = np.concatenate([x, np.zeros((-len(x)) % per + per * (1 + (look + frames - 1) // frames), np.float32)])
sid = uuid.uuid4().hex
pieces, took, server = [], [], []
began = time.perf_counter()
for n in range(len(x) // per):
    spoken = began + (n + 1) * per / 16000          # when the last sample of this slice has been said
    if not fast:
        time.sleep(max(0.0, spoken - time.perf_counter()))
    body = io.BytesIO()
    with wave.open(body, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((np.clip(x[n * per:(n + 1) * per], -1, 1) * 32767).astype("<i2").tobytes())
    data, headers = call(f"/say?sid={sid}&seq={n}", body.getvalue())
    here = time.perf_counter()
    took.append(here - (began + n * per / 16000))
    stages = next((v for k, v in headers.items() if k.lower() == "server-timing"), "")
    timing = {k.split(";")[0].strip(): float(k.split("dur=")[1]) for k in stages.split(",") if "dur=" in k}
    server.append(timing)
    pieces.append(data)

with tempfile.TemporaryDirectory() as d:
    names = []
    for i, data in enumerate(pieces):
        names.append(f"{d}/{i:04d}.mp4")
        open(names[-1], "wb").write(data)
    open(f"{d}/list.txt", "w").write("".join(f"file '{n}'\n" for n in names))
    sf.write(f"{d}/voice.wav", np.concatenate([np.zeros(look * 16000 // fps, np.float32), x]), 16000)
    subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{d}/list.txt", "-i", f"{d}/voice.wav",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", out], check=True)

took = np.array(took[1:] or took)
mean = lambda k: round(float(np.mean([s.get(k, 0) for s in server[1:] or server])), 1)
print(json.dumps({
    "slices": len(pieces), "slice_seconds": frames / fps, "look_frames": look,
    "real_time": not fast,
    "first_sound_to_pictures_here_seconds": {"median": round(float(np.median(took)), 3), "p95": round(float(np.percentile(took, 95)), 3),
                                             "worst": round(float(took.max()), 3)},
    "voice_delay_needed_seconds": round(float(np.percentile(took, 95)) + look / fps, 2),
    "server_ms_mean": {k: mean(k) for k in ("sound", "model", "compose", "encode", "wait", "total")},
    "kilobytes_per_second": round(sum(len(p) for p in pieces) / 1000 / (len(pieces) * frames / fps), 1),
}, indent=1))
