#!/usr/bin/env python
"""Test client for the lip-sync server. Runs on the PC with the standard library only.

    python test_client.py https://xxxx.trycloudflare.com [--out DIR] [--samples DIR] [health samples join live]

The key is read from AVATAR_GPU_KEY in the environment or in ..\\.env; it is never printed.
What it does:
  health   GET /health
  samples  short.wav and long.wav through /speak (saved as short.mp4, long.mp4), with timings
  join     long.wav cut into three pieces, sent one after the other with X-Next-Start (piece1..3.mp4)
  live     0.4 s chunks with 200 ms lead-in: one at a time, ten on one connection, four at once
"""
import argparse
import http.client
import io
import json
import os
import socket
import ssl
import statistics
import sys
import threading
import time
import urllib.parse
import wave

HERE = os.path.dirname(os.path.abspath(__file__))

# A tunnel name resolves to several Cloudflare addresses, and from some networks one of them does
# not answer. Python's http.client then waits for the system's connect timeout (about 21 s on
# Windows) before it tries the next one. Browsers, curl and Node 20+ fall back within a fraction
# of a second; this does the same for the test: addresses that do not connect in 1.5 s go last.
_getaddrinfo = socket.getaddrinfo
_good = {}


def _reachable_first(host, port, *a, **k):
    found = _getaddrinfo(host, port, *a, **k)
    key = (host, port)
    if key not in _good:
        ok = []
        for info in found:
            s = socket.socket(info[0], socket.SOCK_STREAM)
            s.settimeout(1.5)
            try:
                s.connect(info[4])
                ok.append(info[4][0])
            except OSError:
                print(f"note: {host} address {info[4][0]} does not answer from here", flush=True)
            finally:
                s.close()
        _good[key] = ok
    return sorted(found, key=lambda info: info[4][0] not in _good[key])


socket.getaddrinfo = _reachable_first


def load_key():
    k = os.environ.get("AVATAR_GPU_KEY", "")
    if not k:
        with open(os.path.join(HERE, "..", ".env"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("AVATAR_GPU_KEY="):
                    k = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not k:
        sys.exit("AVATAR_GPU_KEY not found")
    return k


class Client:
    """One keep-alive HTTPS connection."""

    def __init__(self, base, key):
        u = urllib.parse.urlparse(base)
        self.host, self.key = u.netloc, key
        self.conn = None
        self.https = u.scheme == "https"

    def _connect(self):
        if self.https:
            self.conn = http.client.HTTPSConnection(self.host, timeout=120, context=ssl.create_default_context())
        else:
            self.conn = http.client.HTTPConnection(self.host, timeout=120)
        self.conn.connect()

    def request(self, method, path, body=None, key=True):
        if self.conn is None:
            self._connect()
        headers = {"Content-Type": "audio/wav"} if body is not None else {}
        if key:
            headers["x-avatar-key"] = self.key
        t0 = time.perf_counter()
        try:
            self.conn.request(method, path, body=body, headers=headers)
            r = self.conn.getresponse()
        except (http.client.HTTPException, OSError):
            self._connect()                      # connection was closed in the meantime: once more
            t0 = time.perf_counter()
            self.conn.request(method, path, body=body, headers=headers)
            r = self.conn.getresponse()
        t_headers = time.perf_counter() - t0
        first = r.read(1)
        t_first = time.perf_counter() - t0
        data = first + r.read()
        t_total = time.perf_counter() - t0
        return {"status": r.status, "headers": {k.lower(): v for k, v in r.getheaders()}, "body": data,
                "t_headers": t_headers, "t_first_byte": t_first, "t_total": t_total}


def read_wav(path):
    with wave.open(path, "rb") as w:
        return w.getparams(), w.readframes(w.getnframes())


def wav_bytes(params, pcm):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        w.writeframes(pcm)
    return b.getvalue()


def cut(params, pcm, t0, t1):
    bpf = params.nchannels * params.sampwidth
    a, b = int(round(t0 * params.framerate)) * bpf, int(round(t1 * params.framerate)) * bpf
    return wav_bytes(params, pcm[max(a, 0):b])


def seconds(params, pcm):
    return len(pcm) / (params.nchannels * params.sampwidth) / params.framerate


def show(tag, r, audio_s=None):
    h = r["headers"]
    line = (f"{tag}: http {r['status']}  headers {r['t_headers'] * 1e3:.0f} ms  first byte {r['t_first_byte'] * 1e3:.0f} ms  "
            f"total {r['t_total'] * 1e3:.0f} ms  {len(r['body'])} bytes")
    if audio_s:
        line += f"  = {r['t_total'] / audio_s:.3f} s per s of speech"
    line += f"  start {h.get('x-start')} frames {h.get('x-frames')} next {h.get('x-next-start')}"
    if "server-timing" in h:
        line += "\n    server: " + h["server-timing"]
    print(line, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("what", nargs="*", default=["health", "samples", "join", "live"])
    ap.add_argument("--out", default=os.path.join(HERE, "..", "avatar-build", "video", "tests"))
    ap.add_argument("--samples", default=os.path.join(HERE, "..", "avatar-build", "video", "samples"))
    ap.add_argument("--clip", default="talk")
    args = ap.parse_args()
    key = load_key()
    base = args.url.rstrip("/")
    os.makedirs(args.out, exist_ok=True)
    c = Client(base, key)
    speak = f"/speak?clip={args.clip}"

    def save(name, r):
        with open(os.path.join(args.out, name), "wb") as f:
            f.write(r["body"])

    def health():
        r = c.request("GET", "/health")
        return json.loads(r["body"]) if r["status"] == 200 else {"status": r["status"]}

    if "health" in args.what:
        r = c.request("GET", "/health", key=False)
        print("without key:", r["status"], r["body"][:80])
        print("health:", json.dumps(health()))

    sp, spcm = read_wav(os.path.join(args.samples, "short.wav"))
    lp, lpcm = read_wav(os.path.join(args.samples, "long.wav"))

    if "samples" in args.what:
        c.request("POST", speak + "&start=0", wav_bytes(sp, spcm))            # warm the connection
        for name, p, pcm in (("short", sp, spcm), ("long", lp, lpcm)):
            dur = seconds(p, pcm)
            for i in range(3):
                r = c.request("POST", speak + "&start=0", wav_bytes(p, pcm))
                show(f"{name}.wav ({dur:.2f} s) run {i + 1}", r, dur)
                s = health().get("speed") or {}
                print("    server:", json.dumps({k: s.get(k) for k in ("processing_seconds", "seconds_per_second_of_speech",
                                                                         "frames_per_second", "first_byte_ms", "first_fragment_ms", "ms")}))
            save(f"{name}.mp4", r)

    if "join" in args.what:
        dur = seconds(lp, lpcm)
        cuts = [0.0, 2.2, 6.0, dur]                # the cuts fall into pauses of long.wav
        start = 0
        for i in range(3):
            r = c.request("POST", f"{speak}&start={start}", cut(lp, lpcm, cuts[i], cuts[i + 1]))
            show(f"piece {i + 1} ({cuts[i]:.1f}-{cuts[i + 1]:.1f} s) start={start}", r, cuts[i + 1] - cuts[i])
            save(f"piece{i + 1}.mp4", r)
            start = int(r["headers"]["x-next-start"])

    if "live" in args.what:
        chunk, lead = 0.4, 0.2

        def live_body(k):
            t0 = k * chunk
            ld = lead if t0 >= lead else t0
            return cut(lp, lpcm, t0 - ld, t0 + chunk), int(round(ld * 1000))

        body, ld = live_body(3)
        ts = []
        for i in range(8):
            r = c.request("POST", f"{speak}&start=30&lead_ms={ld}", body)
            ts.append(r["t_total"])
            if i in (0, 7):
                show(f"one 0.4 s chunk, lead {ld} ms, run {i + 1}", r, chunk)
        print(f"one chunk, 8 runs: median {statistics.median(ts) * 1e3:.0f} ms, min {min(ts) * 1e3:.0f} ms, max {max(ts) * 1e3:.0f} ms")
        save("live-one.mp4", r)

        t0 = time.perf_counter()
        each = []
        for k in range(10):
            body, ld = live_body(k)
            r = c.request("POST", f"{speak}&start={k * 10}&lead_ms={ld}", body)
            each.append(r["t_total"])
            ok = r["status"] == 200 and r["headers"].get("x-start") == str(k * 10) and r["headers"].get("x-frames") == "10"
            save(f"live-{k:02d}.mp4", r)
            if not ok:
                show(f"  chunk {k} NOT as expected", r)
        total = time.perf_counter() - t0
        print(f"ten chunks back to back on one connection: {total * 1e3:.0f} ms for 4.0 s of speech "
              f"({total / 4.0:.3f} s per s); each {' '.join(f'{t * 1e3:.0f}' for t in each)} ms")

        results = [None] * 4

        def worker(i):
            cc = Client(base, key)
            cc.request("GET", "/health")                                  # open the connection first
            body, ld = live_body(i + 10)
            results[i] = cc.request("POST", f"{speak}&start={1000 + i * 10}&lead_ms={ld}", body)

        cy = (health()["clips"][0]["cycle"] if args.clip not in [x["name"] for x in health()["clips"]]
              else [x for x in health()["clips"] if x["name"] == args.clip][0]["cycle"])
        th = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        t0 = time.perf_counter()
        for t in th:
            t.start()
        for t in th:
            t.join()
        print(f"four chunks at once: all back after {(time.perf_counter() - t0) * 1e3:.0f} ms (includes opening 4 connections)")
        for i, r in enumerate(results):
            want = (1000 + i * 10) % cy
            ok = r["status"] == 200 and r["headers"].get("x-start") == str(want) and r["headers"].get("x-next-start") == str((want + 10) % cy)
            show(f"  concurrent {i} (start {1000 + i * 10} -> {want}) {'ok' if ok else 'WRONG'}", r)
            save(f"live-concurrent-{i}.mp4", r)


if __name__ == "__main__":
    main()
