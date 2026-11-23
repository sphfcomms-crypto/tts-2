#!/usr/bin/env python3
"""Authenticated loopback worker for the site's existing /health and /speak relay."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import logging
import os
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs, urlsplit

from phones import PhoneModel, PHONES
from renderer import Atlas, FPS, render

MAX_BODY = 200_000


class Engine:
    def __init__(self, data, masters, threads=2, workers=2):
        self.threads = threads
        self.slots = threading.BoundedSemaphore(workers)
        self.model = PhoneModel(data / "models", threads=threads)
        self.clips = {}
        self.started = time.monotonic()
        self.requests = 0
        self.lock = threading.Lock()
        for meta in sorted((data / "atlas").glob("*/meta.json")):
            try:
                clip = Atlas(meta.parent, masters, data / "cache", PHONES)
            except Exception:
                logging.exception("could not verify source unit %s", meta.parent.name)
                continue
            self.clips[clip.name] = clip
        if not self.clips:
            raise ValueError("no complete matching clip and atlas pair")

    def health(self):
        return {"ok": True, "model": "CPU phoneme atlas", "renderer": "cpu",
                "encoder": "libx264 25 fps, silent", "clips": [c.info() for c in self.clips.values()],
                "requests": self.requests, "uptime_seconds": round(time.monotonic() - self.started)}


class Handler(BaseHTTPRequestHandler):
    server_version = "AvatarCPU"

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def reply(self, status, data, kind="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, message):
        self.reply(status, json.dumps({"ok": False, "error": message}).encode())

    def allowed(self):
        value = self.headers.get("x-avatar-key", "").encode()
        if not hmac.compare_digest(value, self.server.key):
            self.error(401, "unauthorized")
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        if urlsplit(self.path).path != "/health":
            return self.error(404, "unknown route")
        self.reply(200, json.dumps(self.server.engine.health()).encode())

    def do_POST(self):
        if not self.allowed():
            return
        url = urlsplit(self.path)
        if url.path != "/speak":
            return self.error(404, "unknown route")
        engine = self.server.engine
        q = parse_qs(url.query)
        clip = engine.clips.get(q.get("clip", ["talk"])[0])
        if clip is None:
            return self.error(404, "unknown clip")
        try:
            if q.get("audio", ["0"])[0] != "0":
                raise ValueError("the CPU worker delivers video-only pieces")
            start = int(q.get("start", [0])[0])
            lead = int(q.get("lead_ms", [0])[0])
            tail = int(q.get("tail_ms", [0])[0])
            size = int(self.headers.get("content-length", "0"))
            if start < 0 or not 0 <= lead <= 1000 or not 0 <= tail <= 1000:
                raise ValueError("invalid frame or context duration")
            if not 44 <= size <= MAX_BODY:
                return self.error(413, "expected a bounded WAV body")
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("truncated body")
        except (ValueError, OSError) as ex:
            return self.error(400, str(ex))
        if not engine.slots.acquire(timeout=.7):
            return self.error(503, "renderer busy")
        try:
            data, frames, times = render(clip, engine.model, body, start, lead, tail, engine.threads)
        except ValueError as ex:
            return self.error(400, str(ex))
        except Exception:
            logging.exception("CPU render failed for %s", clip.name)
            return self.error(503, "CPU render unavailable")
        finally:
            engine.slots.release()
        with engine.lock:
            engine.requests += 1
        start %= clip.cycle
        self.reply(200, data, "video/mp4", {
            "X-Start": str(start), "X-Frames": str(frames), "X-Cycle": str(clip.cycle),
            "X-Next-Start": str((start + frames) % clip.cycle), "X-Duration": f"{frames / FPS:.3f}",
            "X-Avatar-Renderer": "cpu",
            "Server-Timing": ", ".join(f"{k};dur={v * 1000:.1f}" for k, v in times.items()),
        })

    def log_message(self, fmt, *args):
        # Access logs need status, never the private key or a query string.
        logging.debug(fmt, *args)


def main():
    logging.basicConfig(level=logging.INFO)
    root = Path(os.environ.get("AVATAR_CPU_DATA", "/opt/tts/performance-data"))
    master = Path(os.environ.get("AVATAR_CPU_CLIPS", root / "clips"))
    keyfile = os.environ.get("AVATAR_CPU_KEY_FILE")
    key = Path(keyfile).read_bytes().strip() if keyfile else os.environ.get("AVATAR_GPU_KEY", "").encode()
    if not key:
        raise SystemExit("configure the existing avatar relay key")
    worker = Engine(root, master, threads=int(os.environ.get("AVATAR_CPU_THREADS", "2")),
                    workers=int(os.environ.get("AVATAR_CPU_WORKERS", "2")))
    http = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("AVATAR_CPU_PORT", "8191"))), Handler)
    http.engine, http.key = worker, key
    logging.info("ready on loopback with %d verified performance units", len(worker.clips))
    http.serve_forever()


if __name__ == "__main__":
    main()
