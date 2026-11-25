#!/usr/bin/env python
"""A stand-in for the whole-face server (avatar-flash/server.py), to test the page without a GPU.

    python flash_standin.py <voice.wav> [--port 8100] [--delay 0.35]

It answers /health and /say like the real server, but its pictures are plain grey: each picture
is as bright as the slice's sound is loud during that picture. A recording of the page can then
check, without judging any face, that the picture on screen belongs to the sound being heard.
It also serves the voice file at /voice.wav for flash_call.mjs to play as "her" voice.

    python flash_standin.py <voice.wav> --film <film.mp4> [--square 300,0,300]

With --film its pictures are a film the real server made of that same voice file (test_client.py
writes one): from the first sound of a line on, each slice is answered with the next pictures of
the film, and silence with the film's first picture. What the page then shows is what it shows in
a real call, face and all, and can be looked at.

    python flash_standin.py <voice.wav> --film <film.mp4> --own-look <idle.mp4> --still <still.jpg> [--badge news]

With --own-look it stands in for a server with a look of its own (FLASH_OWN_LOOK=1): /health says
so, and it serves the loop at /idle.mp4 and the picture at /still.jpg.

    ... --live ../../avatar-flash/live.html --tts-file voice.wav

With --live it serves the live page at /live (token "test"), and POST /tts answers with the
--tts-file whatever the text, as the real server answers with her voice made from it.

    ... --live ../../avatar-flash/live.html --tts-file real

With "--tts-file real", POST /tts makes her voice from the text as the real server does
(avatar-flash/voices.py: ElevenLabs' voices with ELEVENLABS_API_KEY or FLASH_ELEVEN_KEY_FILE set,
OpenAI's with OPENAI_API_KEY or FLASH_OPENAI_KEY_FILE, and Microsoft's free ones), and /health
says which are on.
"""
import asyncio
import http.server
import json
import os
import struct
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "avatar-flash"))
import voices  # noqa: E402  (her voice from text, as the real server makes it)

voice = sys.argv[1]
opt = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
PORT, DELAY = int(opt("--port", "8100")), float(opt("--delay", "0.35"))
FRAMES, FPS, W, H = 24, 25, 320, 240
FULL = 0.12          # the loudness (RMS) drawn as white
stats = {"slices": 0, "last_seq": -1, "out_of_order": 0}

FILM = opt("--film", "")
IDLE, STILL, BADGE = opt("--own-look", ""), opt("--still", ""), opt("--badge", "")
LIVE, TTS_FILE = opt("--live", ""), opt("--tts-file", "")
IDLE_FRAMES = 0
if IDLE:
    IDLE_FRAMES = int(subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                                      "stream=nb_read_frames", "-of", "csv=p=0", IDLE], stdout=subprocess.PIPE, check=True,
                                     text=True).stdout.strip())
film, at = None, -1          # the film's pictures, and the next one to show (-1: she is silent)
if FILM:
    FRAMES, W, H = 28, 960, 720          # the real server's slice and frame
    SQUARE = [int(v) for v in opt("--square", "300,0,300").split(",")]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", FILM, "-vf", f"fps={FPS},scale={W}:{H}", "-pix_fmt", "yuv420p",
                          "-f", "rawvideo", "-"], stdout=subprocess.PIPE, check=True).stdout
    film = np.frombuffer(raw, np.uint8).reshape(-1, W * H * 3 // 2)


def encode(frames):
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "main", "-bf", "0", "-g", "25", "-pix_fmt", "yuv420p",
         "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-"],
        input=bytes(frames), stdout=subprocess.PIPE, check=True).stdout


def film_piece(x):
    """The film's pictures for this slice of sound: its first picture while she is silent, and
    the film from its beginning at the first sound of a line."""
    global at
    per = len(x) / FRAMES
    frames = bytearray()
    for k in range(FRAMES):
        part = x[int(k * per):int((k + 1) * per)]
        if at < 0 and len(part) and float(np.abs(part).max()) > 0.02:
            at = 0
        frames += film[max(0, at)].tobytes()
        if at >= 0:
            at += 1
            if at >= len(film):
                at = -1          # the line is over: the next one starts the film again
    return encode(frames)


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
    return encode(frames)


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
                    "width": W, "height": H, "work_seconds": DELAY, **({"square": SQUARE} if FILM else {}), **stats,
                    "own_look": bool(IDLE), "idle_frames": IDLE_FRAMES, "badge": BADGE,
                    "openai_voices": TTS_FILE == "real" and bool(voices.openai_key()),
                    "eleven_voices": TTS_FILE == "real" and bool(voices.eleven_key())}
            return self.answer(200, json.dumps(body).encode(), "application/json")
        if self.path.startswith("/live/token") and LIVE:
            return self.answer(200, b'{"token": "test"}', "application/json")
        if self.path.startswith("/live") and LIVE:
            return self.answer(200, open(LIVE, encoding="utf-8").read().replace("__TOKEN__", "test").encode(), "text/html; charset=utf-8")
        if self.path.startswith("/idle.mp4") and IDLE:
            return self.answer(200, open(IDLE, "rb").read(), "video/mp4")
        if self.path.startswith("/still.jpg") and STILL:
            return self.answer(200, open(STILL, "rb").read(), "image/jpeg")
        if self.path.startswith("/voice.wav"):
            return self.answer(200, open(voice, "rb").read(), "audio/wav")
        self.answer(404, b"{}", "application/json")

    def do_POST(self):
        if self.path.startswith("/tts") and TTS_FILE == "real":
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            text, name, rate = str(body.get("text", "")).strip(), str(body.get("voice", "")), str(body.get("rate", "+0%"))
            if not text or not voices.known(name) or not voices.RATE.fullmatch(rate):
                return self.answer(400, b'{"error": "text, voice and rate"}', "application/json")
            try:
                if voices.engine(name) in ("eleven", "openai"):
                    return self.answer(200, voices.speech(text, name, rate), "audio/wav")
                return self.answer(200, asyncio.run(voices.edge_speech(text, name, rate)), "audio/mpeg")
            except Exception as ex:  # noqa: BLE001
                return self.answer(502, json.dumps({"error": f"her voice could not be made: {ex}"}).encode(), "application/json")
        if self.path.startswith("/tts") and TTS_FILE:
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            return self.answer(200, open(TTS_FILE, "rb").read(), "audio/mpeg" if TTS_FILE.endswith(".mp3") else "audio/wav")
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
        if film is not None and seq == 0:
            globals()["at"] = -1
        data = film_piece(x) if film is not None else piece(x)
        time.sleep(max(0.0, DELAY - (time.time() - began)))
        self.answer(200, data, "video/mp4")

    def log_message(self, *a):
        pass


Server = http.server.HTTPServer if FILM else http.server.ThreadingHTTPServer   # a film is handed out in order
Server(("127.0.0.1", PORT), Handler).serve_forever()
