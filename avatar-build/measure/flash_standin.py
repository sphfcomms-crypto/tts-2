#!/usr/bin/env python
"""A stand-in for the whole-face server (avatar-flash/server.py), to test the page without a GPU.

    python flash_standin.py <voice.wav> [--port 8100] [--delay 0.35]

It answers /health and /say like the real server, but its pictures are plain grey: each picture
is as bright as the slice's sound is loud during that picture. A recording of the page can then
check, without judging any face, that the picture on screen belongs to the sound being heard.
It also serves the voice file at /voice.wav for flash_call.mjs to play as "her" voice.
"""
import http.server
import json
import struct
import subprocess
import sys
import time

import numpy as np

voice = sys.argv[1]
opt = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
PORT, DELAY = int(opt("--port", "8100")), float(opt("--delay", "0.35"))
FRAMES, FPS, W, H = 24, 25, 320, 240
FULL = 0.12          # the loudness (RMS) drawn as white
stats = {"slices": 0, "last_seq": -1, "out_of_order": 0}


def samples(body):
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= len(body):
        cid, size = body[pos:pos + 4], struct.unpack("<I", body[pos + 4:pos + 8])[0]
        if cid == b"fmt ":
            fmt = struct.unpack("<HHIIHH", body[pos + 8:pos + 24])
        elif cid == b"data":
            pcm = body[pos + 8:pos + 8 + size]
            break
        pos += 8 + size + (size & 1)
    assert fmt and fmt[0] == 1 and fmt[5] == 16 and pcm is not None, "16-bit PCM WAV expected"
    return np.frombuffer(pcm[:len(pcm) // 2 * 2], "<i2").astype(np.float32) / 32768.0, fmt[2]


def piece(x):
    per = len(x) / FRAMES
    frames = bytearray()
    for k in range(FRAMES):
        part = x[int(k * per):int((k + 1) * per)]
        level = min(1.0, float(np.sqrt((part ** 2).mean())) / FULL) if len(part) else 0.0
        frames += bytes([16 + round(219 * level)]) * (W * H) + bytes([128]) * (W * H // 2)
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "main", "-bf", "0", "-g", "25", "-pix_fmt", "yuv420p",
         "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-"],
        input=bytes(frames), stdout=subprocess.PIPE, check=True).stdout


class Handler(http.server.BaseHTTPRequestHandler):
    def answer(self, status, body, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "X-Frames, X-Seq, X-Lookahead-Frames")
        self.send_header("X-Frames", str(FRAMES))
        self.send_header("X-Lookahead-Frames", "0")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            body = {"ok": True, "model": "stand-in", "fps": FPS, "slice_frames": FRAMES, "look_frames": 0,
                    "width": W, "height": H, **stats}
            return self.answer(200, json.dumps(body).encode(), "application/json")
        if self.path.startswith("/voice.wav"):
            return self.answer(200, open(voice, "rb").read(), "audio/wav")
        self.answer(404, b"{}", "application/json")

    def do_POST(self):
        if not self.path.startswith("/say"):
            return self.answer(404, b"{}", "application/json")
        began = time.time()
        query = dict(p.split("=", 1) for p in self.path.split("?", 1)[1].split("&") if "=" in p)
        seq = int(query.get("seq", "0"))
        if seq != 0 and seq != stats["last_seq"] + 1:
            stats["out_of_order"] += 1
        stats["last_seq"] = seq
        stats["slices"] += 1
        x, _ = samples(self.rfile.read(int(self.headers["Content-Length"])))
        data = piece(x)
        time.sleep(max(0.0, DELAY - (time.time() - began)))
        self.answer(200, data, "video/mp4")

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
