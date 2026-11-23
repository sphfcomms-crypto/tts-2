"""Do her lips close when the voice says p, b or m? The clearest test of lip sync that can be measured.

    python lip_seal.py <voice.wav> <track.json> [<track.json> ...] [--model <folder>]

Each track (from mouth_track.py) must be on that voice's timeline. A phone recognizer finds the
p/b/m sounds in the voice: Wav2Vec2 `facebook/wav2vec2-lv-60-espeak-cv-ft`, the model the lip-sync
box already keeps in /workspace/avatar-gpu/models/speech-phones (the default folder). For each
sound the track is searched for the moment her lips are closest: how closed they get, and how far
that moment is from the sound. Needs torch and transformers; runs on the GPU box.
"""
import json
import sys

import numpy as np
import soundfile as sf
import torch
from transformers import Wav2Vec2ForCTC

args = sys.argv[1:]
D = "/workspace/avatar-gpu/models/speech-phones"
if "--model" in args:
    at = args.index("--model")
    D = args[at + 1]
    del args[at:at + 2]
x, rate = sf.read(args[0], dtype="float32", always_2d=True)
x = x.mean(1)
if rate != 16000:
    import librosa
    x = librosa.resample(x, orig_sr=rate, target_sr=16000)
dev = "cuda" if torch.cuda.is_available() else "cpu"
model = Wav2Vec2ForCTC.from_pretrained(D, local_files_only=True).eval().to(dev)
vocab = json.load(open(f"{D}/vocab.json"))
ids = [vocab[k] for k in ("m", "p", "b", "pʰ", "bʰ") if k in vocab]
with torch.inference_mode():
    t = torch.as_tensor(x).to(dev)
    t = (t - t.mean()) * torch.rsqrt(t.var(unbiased=False) + 1e-7)
    probs = model(t[None]).logits[0].float().softmax(-1)
p, tok = probs.max(-1)
hit = (p.cpu().numpy() >= 0.85) & np.isin(tok.cpu().numpy(), ids)
events, i = [], 0
while i < len(hit):
    if hit[i]:
        j = i
        while j + 1 < len(hit) and hit[j + 1]:
            j += 1
        events.append(((i + j) / 2 * 320 + 200) / 16000)      # the model hears 25 ms every 20 ms
        i = j + 1
    else:
        i += 1
print(f"{len(events)} p/b/m sounds at", [round(e, 2) for e in events])
for path in args[1:]:
    rows = [r for r in json.load(open(path))["rows"] if r["found"]]
    tt = np.array([r["t"] for r in rows])
    gap = np.array([r["gap"] for r in rows])
    depth, off = [], []
    for e in events:
        sel = (tt >= e - 0.24) & (tt <= e + 0.16)
        if not sel.any():
            continue
        k = np.argmin(gap[sel])
        depth.append(float(gap[sel][k]))
        off.append(float(tt[sel][k] - e))
    depth, off = np.array(depth), np.array(off)
    print(path.split("/")[-1], {
        "sounds": len(depth),
        "lips_closed_share": round(float((depth < 0.02).mean()), 2),          # in eye-distances
        "nearly_closed_share": round(float((depth < 0.04).mean()), 2),
        "closest_gap_median": round(float(np.median(depth)), 3),
        "typical_open_gap": round(float(np.percentile(gap, 75)), 3),
        "closure_vs_sound_ms_median": int(np.median(off) * 1000),            # - : her lips close before the sound
        "within_80ms_share": round(float((np.abs(off - np.median(off)) <= 0.08).mean()), 2),
    })
