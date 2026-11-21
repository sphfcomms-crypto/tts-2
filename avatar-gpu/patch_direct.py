"""One-off edit of server.py: lets a browser talk to this server directly.

The app's own server reaches the user through a slow relay, so video sent
through it stutters. With this edit the browser fetches the video from this
server's public tunnel instead:

  - a request may carry `t=<expires>.<signature>` in its address instead of
    the x-avatar-key header. The app's server makes these tokens (the
    signature is HMAC-SHA256 of the expiry time under the shared key), so
    the key itself never reaches a browser. A token only opens POST /speak.
  - POST /speak?keep=1 renders the piece, keeps it for two minutes and
    answers with a small JSON naming it; GET /piece/<id> hands it out. The
    id is long and random, so it is its own permission.
  - answers to browsers carry the headers that let a page on another
    address read them.

Usage: python patch_direct.py <path to server.py>
"""
import sys

p = sys.argv[1]
s = open(p, encoding="utf-8").read()
if "def token_ok" in s:
    print("already patched")
    raise SystemExit


def swap(old, new):
    global s
    assert old in s, old[:60]
    s = s.replace(old, new, 1)


swap('''import hmac
import io
''', '''import hashlib
import hmac
import io
''')
swap('''import time
from fractions import Fraction
''', '''import time
import uuid
from fractions import Fraction
''')

swap('''class KeyGate:
    """Every request must carry x-avatar-key; anything else is answered 401 before it reaches a route."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            given = b""
            for k, v in scope["headers"]:
                if k == b"x-avatar-key":
                    given = v
            if not hmac.compare_digest(given, KEY):
                body = b'{"ok":false,"error":"unauthorized"}'
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.inner(scope, receive, send)
''', '''CORS = [(b"access-control-allow-origin", b"*"),
        (b"access-control-expose-headers", b"X-Next-Start, X-Frames, X-Duration, Server-Timing"),
        (b"access-control-allow-headers", b"content-type"),
        (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
        (b"access-control-max-age", b"600")]
TOKEN_MAX_SECONDS = 2 * 3600


def token_ok(query):
    """t=<expires>.<hex hmac-sha256 of the expiry under the key>, made by the app's server."""
    for part in query.split(b"&"):
        if part.startswith(b"t="):
            expires, _, sig = part[2:].partition(b".")
            if not expires.isdigit():
                return False
            left = int(expires) - time.time()
            want = hmac.new(KEY, expires, hashlib.sha256).hexdigest().encode()
            return 0 < left < TOKEN_MAX_SECONDS and hmac.compare_digest(sig, want)
    return False


class KeyGate:
    """Lets a request through when it carries x-avatar-key (the app's server), or a signed token in
    its address for POST /speak (a browser), or asks for a kept piece by its secret id. Anything else
    is answered 401 before it reaches a route. Answers to browsers get the cross-origin headers."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        given = b""
        for k, v in scope["headers"]:
            if k == b"x-avatar-key":
                given = v
        if hmac.compare_digest(given, KEY):
            return await self.inner(scope, receive, send)

        method, path = scope["method"], scope["path"]

        async def answer(status, body=b""):
            await send({"type": "http.response.start", "status": status,
                        "headers": CORS + [(b"content-type", b"application/json"),
                                           (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})

        if method == "OPTIONS":
            return await answer(204)
        allowed = (method == "GET" and path.startswith("/piece/")) or \\
                  (method == "POST" and path == "/speak" and token_ok(scope.get("query_string", b"")))
        if not allowed:
            return await answer(401, b'{"ok":false,"error":"unauthorized"}')

        async def send_cors(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": list(message.get("headers", [])) + CORS}
            await send(message)

        await self.inner(scope, receive, send_cors)
''')

swap('''def _err(status, msg, **kw):
    return JSONResponse({"ok": False, "error": msg, **kw}, status_code=status)
''', '''def _err(status, msg, **kw):
    return JSONResponse({"ok": False, "error": msg, **kw}, status_code=status)


# Pieces kept for a browser to fetch: id -> (time to forget it, the MP4).
KEPT = {}
KEEP_SECONDS = 120


def keep(data):
    now = time.time()
    for old in [k for k, (until, _) in KEPT.items() if until < now]:
        KEPT.pop(old, None)
    piece_id = uuid.uuid4().hex + uuid.uuid4().hex
    KEPT[piece_id] = (now + KEEP_SECONDS, data)
    return piece_id


@app.get("/piece/{piece_id}")
def piece(piece_id: str):
    found = KEPT.get(piece_id)
    if not found or found[0] < time.time():
        return _err(404, "no such piece (they are kept for two minutes)")
    return Response(found[1], media_type="video/mp4", headers={"Cache-Control": "no-store"})
''')

swap('''async def speak(request: Request, clip: str = "talk", start: int = 0, lead_ms: int = 0, tail_ms: int = 0, audio: int = 1):''',
     '''async def speak(request: Request, clip: str = "talk", start: int = 0, lead_ms: int = 0, tail_ms: int = 0, audio: int = 1,
                keep_piece: int = Query(0, alias="keep")):''')
swap('''from fastapi import FastAPI, Request  # noqa: E402''', '''from fastapi import FastAPI, Query, Request  # noqa: E402''')
swap('''    if job.n_frames <= WHOLE_BELOW:                    # short piece: answer in one go, with timings''',
     '''    if keep_piece or job.n_frames <= WHOLE_BELOW:      # short piece, or one to keep: finish it first''')
swap('''        ms = job.stats["ms"]
        headers["Server-Timing"] = ", ".join(f"{k};dur={v}" for k, v in ms.items())
        return Response(b"".join(parts), media_type="video/mp4", headers=headers)''',
     '''        ms = job.stats["ms"]
        headers["Server-Timing"] = ", ".join(f"{k};dur={v}" for k, v in ms.items())
        if keep_piece:                                 # the browser fetches it itself: GET /piece/<id>
            data = b"".join(parts)
            return JSONResponse({"ok": True, "id": keep(data), "bytes": len(data), "frames": job.n_frames,
                                 "next": (job.start + job.n_frames) % c.cycle}, headers=headers)
        return Response(b"".join(parts), media_type="video/mp4", headers=headers)''')

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("patched", p)
