#!/usr/bin/env python3
"""Measure real 400-ms browser requests. Never exposes, updates or rents a server."""
import argparse
from collections import Counter
import concurrent.futures
import io
import json
import os
from pathlib import Path
import struct
import time
import urllib.parse
import urllib.request

import av
import numpy as np
from phones import PHONES, PhoneModel
from renderer import Atlas, FPS, read_wav, render, to_16k


def telephone(samples):
    pcm = np.rint(np.clip(samples, -1, 1) * 32767).astype(np.int32)
    mag = np.minimum(np.abs(pcm), 32635) + 132
    exponent = np.maximum(0, np.floor(np.log2(mag)).astype(np.int32) - 7)
    code = (~(np.where(pcm < 0, 128, 0) | exponent << 4 | ((mag >> (exponent + 3)) & 15))).astype("u1")
    fmt = struct.pack("<HHIIHH", 7, 1, 16000, 16000, 1, 8)
    raw = code.tobytes()
    return b"RIFF" + struct.pack("<I", 36 + len(raw)) + b"WAVEfmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", len(raw)) + raw


def main():
    arg = argparse.ArgumentParser(description=__doc__)
    arg.add_argument("--voice", type=Path, required=True, help="real PCM WAV with >= 0.7 seconds of speech")
    arg.add_argument("--clip", default="oa1_talk_explain")
    arg.add_argument("--data", type=Path, default=Path("/opt/tts/performance-data"))
    arg.add_argument("--masters", type=Path)
    arg.add_argument("--url", help="test the installed authenticated daemon instead of the local renderer")
    arg.add_argument("--key-file", type=Path)
    arg.add_argument("--threads", type=int, default=1)
    arg.add_argument("--runs", type=int, default=16)
    arg.add_argument("--concurrent", type=int, default=1)
    opts = arg.parse_args()
    samples, rate = read_wav(opts.voice.read_bytes())
    recording = to_16k(samples, rate)
    if len(recording) < 11200:
        arg.error("recording must include 700ms of real sound")
    chunks = []
    for start in range(0, len(recording)-11200+1, 6400):
        window = recording[start:start+11200]
        if np.sqrt(np.mean(window[3200:9600]**2)) > .009:
            chunks.append(telephone(window))
    if not chunks:
        arg.error("no audible 400ms chunk")
    if opts.url:
        key = opts.key_file.read_text().strip() if opts.key_file else os.environ["AVATAR_GPU_KEY"]
    else:
        masters = opts.masters or opts.data / "clips"
        atlas = Atlas(opts.data / "atlas" / opts.clip, masters, opts.data / "cache", PHONES)
        model = PhoneModel(opts.data / "models", threads=opts.threads)
    def measured(i):
        body = chunks[i % len(chunks)]
        at = time.perf_counter()
        if opts.url:
            query = urllib.parse.urlencode(dict(clip=opts.clip, start=i*7, lead_ms=200, tail_ms=100, audio=0))
            req = urllib.request.Request(opts.url.rstrip("/") + "/speak?" + query, data=body,
                                         headers={"Content-Type": "audio/wav", "x-avatar-key": key})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = r.read()
                assert r.headers["X-Frames"] == "10"
                acoustic = r.headers.get("X-Avatar-Acoustic", "unreported")
                timings = {k:float(v) for k,v in (q.strip().split(";dur=") for q in r.headers["Server-Timing"].split(","))}
        else:
            data, frames, metrics = render(atlas, model, body, i*7, 200, 100, threads=opts.threads)
            assert frames == 10
            acoustic = model.last_backend
            timings = {k:v*1000 for k,v in metrics.items()}
        milliseconds = 1000*(time.perf_counter()-at)
        if i == 0:
            with av.open(io.BytesIO(data)) as movie:
                stream = movie.streams.video[0]
                pts = [float(f.pts*f.time_base) for f in movie.decode(stream)]
                assert len(movie.streams.audio)==0 and len(pts)==10 and np.allclose(pts, np.arange(10)/FPS)
            assert b"moof" in data
        return acoustic, {"elapsed": milliseconds, **timings}
    _, cold = measured(0)
    with concurrent.futures.ThreadPoolExecutor(max_workers=opts.concurrent) as pool:
        used, times = zip(*pool.map(measured, range(max(1,opts.runs))))
    print(json.dumps({"unit":opts.clip,"calls":len(times),"concurrency":opts.concurrent,
                      "acoustic_model_requests":dict(Counter(used)),
                      "independent_voiced_requests":len(chunks),"cold_ms":round(cold["elapsed"],1),
                      "ms":{k:dict(zip(["median","p95","max"],np.round(np.percentile([v[k] for v in times],[50,95,100]),1).tolist())) for k in times[0]},
                      "under_400ms":sum(v["elapsed"] < 400 for v in times)},indent=2))


if __name__ == "__main__":
    main()
