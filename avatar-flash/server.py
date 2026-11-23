#!/usr/bin/env python
"""Whole-face live server: her voice in, video of her whole head and shoulders out, as it arrives.

Model   SoulX-FlashHead (Pro, 1.3 B parameters, Apache-2.0 code): a streaming video model that
        draws a talking portrait from one picture and the sound. Everything in the square around
        her head is drawn new for every picture (lips, teeth, jaw, cheeks, eyes, brows, head
        movement), which is what an offline model such as Seedance does and what a lip-only
        model cannot. The square is laid back into her full picture, so the room, her hands and
        the armchair are the still photograph.
API     GET  /health
        POST /say?sid=<session>&seq=<n>[&t=<token>]    body: WAV, one slice of her voice
        Every request needs the header x-avatar-key or, from a browser, a signed token (the same
        scheme as avatar-gpu/server.py).
Run     bash start.sh   (listens on 127.0.0.1:8100)

One /say carries exactly one slice of sound (`slice_frames` pictures long, 1.12 s by default) and
is answered with that many pictures as one silent fragmented MP4. Slices of a session must come in
order: the model continues her movement from the pictures it drew last. `seq=0` starts her from
the rest pose.
"""
import asyncio
import hashlib
import hmac
import io
import json
import os
import struct
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

ROOT = os.environ.get("FLASH_ROOT", "/workspace/tts-2-lab")
REPO = os.path.join(ROOT, "SoulX-FlashHead")
os.chdir(REPO)                       # the model's own code opens its settings file relatively
sys.path.insert(0, REPO)

import av  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from PIL import Image  # noqa: E402

HOST = os.environ.get("FLASH_HOST", "127.0.0.1")
PORT = int(os.environ.get("FLASH_PORT", "8100"))
# pro: sharp, her real face (Wan VAE). lite: several times faster but soft and pale (LTX VAE).
MODEL = os.environ.get("FLASH_MODEL", "pro")
# Pictures per model pass. pro: 33, 29, 25, 21 or 17 (5 of them repeat the pass before);
# lite: 33, 25 or 17 (9 repeat).
FRAMES = int(os.environ.get("FLASH_FRAMES", "33"))
# Denoising steps per pass. The model was made for 4. With 2 or 3 it is faster but her lips turn
# red and the picture gains contrast.
STEPS = int(os.environ.get("FLASH_STEPS", "4"))
# The size the model draws its square at (a multiple of 16). It was made for 512. On one L40S pro
# with 4 steps draws 19 pictures a second at 512 and 32 at 416; a call needs 25. The square is shown
# at 300 pixels in a 960x720 frame, and at that size 416 and 512 look the same.
SIZE = int(os.environ.get("FLASH_SIZE", "416" if MODEL == "pro" else "512"))
# pro only: turn the model's latents into pictures with the small TAEHV decoder instead of the full
# Wan VAE decoder (0.07 s against 1.26 s for one pass on an L40S).
TAE = os.environ.get("FLASH_TAE", "1") == "1" and MODEL != "lite"
# Pictures of sound the model may hear beyond the last picture it draws. Lips are shaped by the
# sound that follows, and without any of it they close late. Costs that much more delay.
LOOK = int(os.environ.get("FLASH_LOOK", "0"))
PICTURE = os.environ.get("FLASH_PICTURE", os.path.join(ROOT, "inputs", "start.jpg"))
# The square of the picture the model draws: left, top, size in the picture's own pixels.
BOX = [int(v) for v in os.environ.get("FLASH_BOX", "520,0,520").split(",")]
OUT_W, OUT_H = [int(v) for v in os.environ.get("FLASH_OUT", "960x720").split("x")]
FEATHER = float(os.environ.get("FLASH_FEATHER", "0.09"))       # fade at the square's sides, as a share of its size
FEATHER_BOTTOM = float(os.environ.get("FLASH_FEATHER_BOTTOM", "0.14"))
SEED = int(os.environ.get("FLASH_SEED", "42"))
# Her voice is multiplied by this before the model hears it (what is played is not touched). The
# app's voice is quiet (about -30 LUFS); the model was made with speech at an ordinary level.
GAIN = float(os.environ.get("FLASH_GAIN", "1"))
# A hiss far below hearing that is mixed into what the model hears (never into what is played).
# With exact digital silence the model's sound features lose their scale and it leaves her lips
# parted: measured 0.065 of the distance between her eyes, against 0.002 with this floor.
FLOOR = float(os.environ.get("FLASH_NOISE_FLOOR", "0.0005"))
MAX_SESSIONS = int(os.environ.get("FLASH_MAX_SESSIONS", "3"))
SESSION_IDLE = float(os.environ.get("FLASH_SESSION_IDLE", "45"))
KEY_FILE = os.environ.get("FLASH_KEY_FILE", os.path.join(ROOT, "key.txt"))

FPS = 25
RATE = 16000
PER_FRAME = RATE // FPS
X264_PRESET = os.environ.get("FLASH_X264_PRESET", "faster")
X264_CRF = os.environ.get("FLASH_X264_CRF", "20")
KBPS = int(os.environ.get("FLASH_KBPS", "1600"))
KR, KB = 0.2126, 0.0722                  # BT.709, limited range: the same as her other clips
KG = 1.0 - KR - KB


def log(**kw):
    kw["t"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    print(json.dumps(kw), flush=True)


def load_key():
    k = os.environ.get("AVATAR_GPU_KEY", "")
    if not k:
        with open(KEY_FILE) as f:
            k = f.read()
    k = k.strip()
    if not k:
        raise SystemExit("no key: put it in key.txt (mode 600) or AVATAR_GPU_KEY")
    return k.encode()


# ----------------------------------------------------------------------------- audio in

def _wav_fallback(data):
    """Minimal RIFF reader: 16-bit and 8-bit PCM, float, and the telephone's mu-law."""
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a WAV file")
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = pos + 8
        if cid == b"fmt ":
            fmt = struct.unpack("<HHIIHH", data[body:body + 16])
        elif cid == b"data":
            end = len(data) if size in (0, 0xFFFFFFFF) or body + size > len(data) else body + size
            pcm = data[body:end]
            break
        pos = body + size + (size & 1)
    if fmt is None or pcm is None:
        raise ValueError("WAV without fmt/data chunk")
    tag, ch, rate, _, _, bits = fmt
    if tag == 1 and bits == 16:
        x = np.frombuffer(pcm[:len(pcm) // 2 * 2], "<i2").astype(np.float32) / 32768.0
    elif tag == 7 and bits == 8:
        u = (~np.frombuffer(pcm, np.uint8)).astype(np.int32)
        mag = (((u & 15) * 8 + 132) << ((u >> 4) & 7)) - 132
        x = (np.where(u & 128, -mag, mag) / 32768.0).astype(np.float32)
    elif tag == 1 and bits == 8:
        x = (np.frombuffer(pcm, np.uint8).astype(np.float32) - 128.0) / 128.0
    elif tag == 3 and bits == 32:
        x = np.frombuffer(pcm[:len(pcm) // 4 * 4], "<f4").astype(np.float32)
    else:
        raise ValueError(f"unsupported WAV encoding (format {tag}, {bits} bit)")
    x = x[:len(x) // ch * ch].reshape(-1, ch).mean(1)
    return x, rate


def read_audio(data):
    """-> mono float32 samples at 16 kHz."""
    try:
        x, rate = _wav_fallback(data)
    except Exception:
        x, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        x = x.mean(1)
    x = np.ascontiguousarray(x, np.float32)
    if rate != RATE and len(x):
        import soxr
        x = soxr.resample(x, rate, RATE, quality="HQ").astype(np.float32)
    return x


# ----------------------------------------------------------------------------- the model

class Session:
    def __init__(self, cached_seconds, ref_motion, rest=None):
        # What she "heard" before the call began is the same quiet room, not digital silence.
        self.hiss = np.random.default_rng(7)
        before = (self.hiss.standard_normal(RATE * cached_seconds) * FLOOR).astype(np.float32)
        self.sound = deque(before.tolist() if rest is None else rest[1], maxlen=RATE * cached_seconds)
        self.motion = (ref_motion if rest is None else rest[0]).clone()
        self.next = 0
        self.used = time.time()
        self.turn = asyncio.Condition()


class Engine:
    def __init__(self):
        t0 = time.perf_counter()
        import flash_head.inference as inference
        import flash_head.src.pipeline.flash_head_pipeline as pipeline_module
        # Compiling the model needs a C compiler on the box. Without one it runs as it is (measured
        # on an L40S: 0.26 s for 0.96 s of her, uncompiled).
        compiled = os.environ.get("FLASH_COMPILE", "0") == "1"
        pipeline_module.COMPILE_MODEL = pipeline_module.COMPILE_VAE = compiled
        inference.infer_params["frame_num"] = FRAMES
        self.inference = inference
        self.pipe = inference.get_pipeline(
            world_size=1, ckpt_dir=os.path.join(ROOT, "models", "SoulX-FlashHead-1_3B"),
            wav2vec_dir=os.path.join(ROOT, "models", "wav2vec2-base-960h"), model_type=MODEL)
        inference.infer_params["sample_steps"] = STEPS
        inference.infer_params["height"] = inference.infer_params["width"] = SIZE
        self.dev = self.pipe.device
        self.pipe.rank = 1                    # the model's own code prints seven timing lines per slice at rank 0
        self.colour = None
        if TAE:
            self.fast_decoder()

        # Her full picture at the size that is sent, and the square of it the model draws.
        full = Image.open(PICTURE).convert("RGB")
        x0, y0, size = BOX
        square = full.crop((x0, y0, x0 + size, y0 + size)).resize((SIZE, SIZE), Image.LANCZOS)
        os.makedirs(os.path.join(ROOT, "run"), exist_ok=True)
        cond = os.path.join(ROOT, "run", "rest-square.png")
        square.save(cond)
        inference.get_base_data(self.pipe, cond_image_path_or_dir=cond, base_seed=SEED, use_face_crop=False)
        p = inference.get_infer_params()
        self.cached = p["cached_audio_duration"]
        self.motion_frames = p["motion_frames_num"]
        self.slice = FRAMES - self.motion_frames
        self.end = self.cached * FPS
        self.ref_motion = self.pipe.ref_img_latent[:, :1].clone()

        sx, sy = OUT_W / full.width, OUT_H / full.height
        self.ox, self.oy = round(x0 * sx), round(y0 * sy)
        self.osize = round(size * sx)
        if abs(x0 * sx - self.ox) > 0.01 or abs(size * sx - self.osize) > 0.01 or abs(sx - sy) > 1e-4:
            log(event="warning", message="the square does not land on whole pixels of the output; her head may sit a fraction of a pixel off")
        base = np.asarray(full.resize((OUT_W, OUT_H), Image.LANCZOS), np.float32)
        self.base = torch.from_numpy(base).to(self.dev)                       # (H, W, 3), 0..255
        self.under = self.base[self.oy:self.oy + self.osize, self.ox:self.ox + self.osize].clone()
        n = self.osize
        pos = torch.arange(n, device=self.dev, dtype=torch.float32) + 0.5
        side = torch.ones(n, device=self.dev)
        if x0 > 0:
            side = torch.minimum(side, pos / (FEATHER * n))
        if x0 + size < full.width:
            side = torch.minimum(side, (n - pos) / (FEATHER * n))
        down = torch.ones(n, device=self.dev)
        if y0 > 0:
            down = torch.minimum(down, pos / (FEATHER * n))
        if y0 + size < full.height:
            down = torch.minimum(down, (n - pos) / (FEATHER_BOTTOM * n))
        a = (side.clamp(0, 1)[None, :] * down.clamp(0, 1)[:, None])
        self.alpha = (a * a * (3 - 2 * a))[None, :, :, None]                   # smooth fade, (1, n, n, 1)

        self.five = (torch.arange(5) - 2)[None]
        self.sessions = {}
        self.gpu = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
        self.last = None
        self.work = 0.0                  # seconds of work for one slice, as lately measured
        self.count = 0
        self.started = time.time()
        self.load_seconds = time.perf_counter() - t0
        self.warm_up()
        log(event="ready", model=MODEL, steps=STEPS, size=SIZE, small_decoder=TAE, frames=FRAMES, slice_frames=self.slice, look_frames=LOOK,
            out=[OUT_W, OUT_H], square=[self.ox, self.oy, self.osize], load_seconds=round(self.load_seconds, 1),
            total_seconds=round(time.perf_counter() - t0, 1))

    # -- the small decoder -------------------------------------------------------------------------------
    def fast_decoder(self):
        """Use TAEHV (taew2_1) to turn latents into pictures. Its colours differ a little from the
        full decoder's (more contrast, redder lips), so warm_up() fits one 3x4 colour matrix that
        takes its pictures to the full decoder's, and every picture goes through that."""
        sys.path.insert(0, os.path.join(ROOT, "models", "taehv"))
        from taehv import TAEHV
        tae = TAEHV(checkpoint_path=os.path.join(ROOT, "models", "taehv", "taew2_1.pth")).to(self.dev, torch.float16).eval()
        self.full_decode = self.pipe.vae.decode
        self.latent = None

        def decode(z):                                                         # (16, T, h, w) -> (1, 3, 4T-3, H, W), -1..1
            self.latent = z
            x = tae.decode_video(z.permute(1, 0, 2, 3)[None].to(torch.float16), parallel=True, show_progress_bar=False)
            x = x.permute(0, 2, 1, 3, 4).float()                               # 0..1
            if self.colour is not None:
                m, c = self.colour
                x = (torch.einsum("ij,bjthw->bithw", m, x) + c[None, :, None, None, None]).clamp_(0, 1)
            return (x * 2 - 1).to(self.pipe.param_dtype)

        self.tae_decode = decode
        self.pipe.vae.decode = decode

    @torch.no_grad()
    def fit_colour(self):
        """Least squares: full decoder's RGB = M . small decoder's RGB + c, over the pictures of one pass."""
        z = self.latent
        want = ((self.full_decode(z).float() + 1) / 2).clamp(0, 1)[0]          # (3, T, H, W)
        self.colour = None
        got = ((self.tae_decode(z).float() + 1) / 2)[0]
        n = min(want.shape[1], got.shape[1])
        a = got[:, :n, ::4, ::4].reshape(3, -1).T
        b = want[:, :n, ::4, ::4].reshape(3, -1).T
        a1 = torch.cat([a, torch.ones_like(a[:, :1])], 1)
        sol = torch.linalg.lstsq(a1, b).solution                               # (4, 3)
        self.colour = (sol[:3].T.contiguous(), sol[3].contiguous())
        before = float((a - b).abs().mean() * 255)
        after = float((a1 @ sol - b).abs().mean() * 255)
        log(event="colour_fit", mean_difference_before=round(before, 2), after=round(after, 2),
            matrix=[[round(float(v), 3) for v in row] for row in sol[:3].T], offset=[round(float(v), 3) for v in sol[3]])

    # -- one slice: sound -> pictures -> her full picture -> MP4 ----------------------------------------
    @torch.no_grad()
    def draw(self, session, samples):
        tm = {}
        t = time.perf_counter()
        if FLOOR > 0:
            samples = samples + (session.hiss.standard_normal(len(samples)) * FLOOR).astype(np.float32)
        session.sound.extend(samples.tolist())
        emb = self.pipe.preprocess_audio(np.array(session.sound), sr=RATE, fps=FPS)
        last = self.end - LOOK
        idx = (torch.arange(last - FRAMES, last)[:, None] + self.five).clamp(0, self.end - 1)
        emb = emb[idx][None].contiguous().to(self.dev)
        torch.cuda.synchronize()
        tm["sound"] = time.perf_counter() - t

        t = time.perf_counter()
        self.pipe.latent_motion_frames = session.motion
        video = self.pipe.generate(emb)                                        # (3, FRAMES, SIZE, SIZE), -1..1
        session.motion = self.pipe.latent_motion_frames
        torch.cuda.synchronize()
        tm["model"] = time.perf_counter() - t

        t = time.perf_counter()
        new = video[:, self.motion_frames:].permute(1, 0, 2, 3)                # (slice, 3, SIZE, SIZE)
        new = ((new + 1) * 127.5).clamp_(0, 255)
        if self.osize != new.shape[-1]:
            new = F.interpolate(new, size=(self.osize, self.osize), mode="bilinear", antialias=True, align_corners=False)
        new = new.permute(0, 2, 3, 1)                                          # (slice, n, n, 3)
        frames = self.base[None].repeat(new.shape[0], 1, 1, 1)
        frames[:, self.oy:self.oy + self.osize, self.ox:self.ox + self.osize] = self.under + (new - self.under) * self.alpha
        rgb = frames.permute(0, 3, 1, 2) / 255.0                               # (slice, 3, H, W), 0..1
        r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
        luma = KR * r + KG * g + KB * b
        y = (16.0 + 219.0 * luma).round_().clamp_(0, 255).to(torch.uint8)
        cb = F.avg_pool2d((128.0 + 112.0 * (b - luma) / (1.0 - KB))[:, None], 2)[:, 0].round_().clamp_(0, 255).to(torch.uint8)
        cr = F.avg_pool2d((128.0 + 112.0 * (r - luma) / (1.0 - KR))[:, None], 2)[:, 0].round_().clamp_(0, 255).to(torch.uint8)
        k = y.shape[0]
        planar = torch.cat([y.reshape(k, -1), cb.reshape(k, -1), cr.reshape(k, -1)], 1).cpu().numpy()
        tm["compose"] = time.perf_counter() - t

        t = time.perf_counter()
        data = encode(planar)
        tm["encode"] = time.perf_counter() - t
        return data, tm

    def warm_up(self):
        """Run the whole path a few times so the first real slice is already fast, and keep where
        that leaves her. Started from the still picture alone, the model opens her mouth for the
        first two seconds (measured: lips 0.08 apart, against 0.003 once she has settled). So she
        is let settle here, in silence, once, and every call begins from that."""
        self.rest = None
        session = Session(self.cached, self.ref_motion)
        for i in range(max(1, round(4.0 * FPS / self.slice))):
            t0 = time.perf_counter()
            self.draw(session, np.zeros(self.slice * PER_FRAME, np.float32))
            torch.cuda.synchronize()
            # What one slice costs here: the page holds her voice back by that much from the
            # first slice of a call on, instead of finding it out from slices that came late.
            self.work = time.perf_counter() - t0
            if TAE and i == 1:
                self.fit_colour()
        self.rest = (session.motion.clone(), list(session.sound))

    def session(self, sid, fresh):
        now = time.time()
        for old in [k for k, s in self.sessions.items() if now - s.used > SESSION_IDLE]:
            self.sessions.pop(old, None)
        s = self.sessions.get(sid)
        if s is None or fresh:
            if s is None and len(self.sessions) >= MAX_SESSIONS:
                return None
            s = Session(self.cached, self.ref_motion, self.rest)
            self.sessions[sid] = s
        return s


def encode(planar):
    """Pictures (planar YUV 4:2:0, one row each) -> one silent fragmented MP4 starting at time 0."""
    out = io.BytesIO()
    c = av.open(out, mode="w", format="mp4", options={
        "movflags": "frag_keyframe+empty_moov+default_base_moof+skip_trailer", "frag_duration": "2000000"})
    v = c.add_stream("libx264", rate=FPS, options={
        "preset": X264_PRESET, "crf": X264_CRF, "maxrate": f"{int(KBPS * 1.4)}k", "bufsize": f"{KBPS * 2}k",
        "x264-params": ("keyint=25:min-keyint=25:scenecut=0:bframes=0:colorprim=bt709:transfer=bt709:"
                        "colormatrix=bt709:rc-lookahead=4:sync-lookahead=0:sliced-threads=1")})
    v.width, v.height, v.pix_fmt = OUT_W, OUT_H, "yuv420p"
    v.codec_context.time_base = Fraction(1, FPS)
    for i, row in enumerate(planar):
        f = av.VideoFrame.from_ndarray(row.reshape(OUT_H * 3 // 2, OUT_W), format="yuv420p")
        f.pts = i
        f.time_base = Fraction(1, FPS)
        for p in v.encode(f):
            c.mux(p)
    for p in v.encode(None):
        c.mux(p)
    c.close()
    return out.getvalue()


# ----------------------------------------------------------------------------- HTTP

KEY = load_key()
ENGINE = None
LAST_USED = time.time()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

CORS = [(b"access-control-allow-origin", b"*"),
        (b"access-control-expose-headers", b"X-Frames, X-Seq, X-Lookahead-Frames, Server-Timing"),
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
    """Lets a request through with the key header (the app's server) or, for POST /say, a signed
    token in its address (a browser). Answers to browsers get the cross-origin headers."""

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

        async def answer(status, body=b""):
            await send({"type": "http.response.start", "status": status,
                        "headers": CORS + [(b"content-type", b"application/json"),
                                           (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})

        if scope["method"] == "OPTIONS":
            return await answer(204)
        if not (scope["method"] == "POST" and scope["path"] == "/say" and token_ok(scope.get("query_string", b""))):
            return await answer(401, b'{"ok":false,"error":"unauthorized"}')

        async def send_cors(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": list(message.get("headers", [])) + CORS}
            await send(message)

        await self.inner(scope, receive, send_cors)


app.add_middleware(KeyGate)


@app.on_event("startup")
def _startup():
    global ENGINE, LAST_USED
    ENGINE = Engine()
    LAST_USED = time.time()


@app.get("/health")
def health():
    e = ENGINE
    return {"ok": True, "model": f"SoulX-FlashHead {MODEL}, {STEPS} steps" + (", TAEHV" if TAE else ""), "fps": FPS, "slice_frames": e.slice, "look_frames": LOOK,
            "width": OUT_W, "height": OUT_H, "work_seconds": round(e.work, 3), "speed": e.last, "requests": e.count, "sessions": len(e.sessions),
            "uptime_seconds": round(time.time() - e.started), "idle_seconds": round(time.time() - LAST_USED)}


def _err(status, msg):
    return JSONResponse({"ok": False, "error": msg}, status_code=status)


@app.post("/say")
async def say(request: Request, sid: str = "", seq: int = 0):
    global LAST_USED
    LAST_USED = time.time()
    e = ENGINE
    if not 1 <= len(sid) <= 64 or not sid.replace("-", "").replace("_", "").isalnum() or seq < 0:
        return _err(400, "sid must be 1 to 64 letters and digits, seq a whole number from 0")
    body = await request.body()
    t_recv = time.perf_counter()
    try:
        x = read_audio(body)
    except Exception as ex:  # noqa: BLE001
        return _err(400, f"the body must be a WAV file: {ex}")
    want = e.slice * PER_FRAME
    if abs(len(x) - want) > PER_FRAME // 2 + 1:
        return _err(400, f"one slice is {e.slice} pictures: {want} samples at 16 kHz, got {len(x)}")
    x = np.pad(x, (0, max(0, want - len(x))))[:want]
    if GAIN != 1:
        x = np.clip(x * GAIN, -1.0, 1.0)

    s = e.session(sid, fresh=seq == 0)
    if s is None:
        return _err(503, "she is in as many calls as this box can draw at once")
    async with s.turn:
        if seq < s.next:
            return _err(409, f"slice {seq} is already drawn; the next one is {s.next}")
        # Slices are sent a slice apart, but two can overtake each other on the way here.
        try:
            await asyncio.wait_for(s.turn.wait_for(lambda: seq <= s.next), timeout=1.5)
        except asyncio.TimeoutError:
            log(event="gap", sid=sid[:8], expected=s.next, got=seq)
        s.used = time.time()
        waited = time.perf_counter() - t_recv
        try:
            data, tm = await asyncio.get_running_loop().run_in_executor(e.gpu, e.draw, s, x)
        except Exception as ex:  # noqa: BLE001
            log(event="draw_error", error=repr(ex))
            e.sessions.pop(sid, None)
            return _err(500, "drawing failed")
        s.next = seq + 1
        s.turn.notify_all()
    total = time.perf_counter() - t_recv
    ms = {k: round(1e3 * v, 1) for k, v in tm.items()}
    ms["wait"] = round(1e3 * waited, 1)
    ms["total"] = round(1e3 * total, 1)
    e.last = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "frames": e.slice, "bytes": len(data), "ms": ms,
              "seconds_per_second_of_speech": round(total / (e.slice / FPS), 3)}
    e.work = 0.8 * e.work + 0.2 * (total - waited) if e.work else total - waited
    e.count += 1
    if seq % 10 == 0:
        log(event="say", sid=sid[:8], seq=seq, **e.last)
    return Response(data, media_type="video/mp4", headers={
        "X-Frames": str(e.slice), "X-Seq": str(seq), "X-Lookahead-Frames": str(LOOK), "Cache-Control": "no-store",
        "Server-Timing": ", ".join(f"{k};dur={v}" for k, v in ms.items())})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning", access_log=False, timeout_keep_alive=75)
