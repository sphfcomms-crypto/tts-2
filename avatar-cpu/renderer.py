"""Render one silent H.264 piece on the same exact filmed frames as the GPU."""
from fractions import Fraction
import hashlib
import io
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time

import av
import cv2
import numpy as np
from scipy.signal import resample_poly

FPS = 25
cv2.setNumThreads(1)


def read_wav(body):
    """Decode both browser transports, including G.711 μ-law in a RIFF container."""
    if body[:4] != b"RIFF" or body[8:12] != b"WAVE":
        raise ValueError("expected RIFF WAV")
    fmt = pcm = None
    at = 12
    while at + 8 <= len(body):
        tag = body[at:at + 4]
        length = int.from_bytes(body[at + 4:at + 8], "little")
        at += 8
        if at + length > len(body):
            raise ValueError("truncated WAV")
        if tag == b"fmt ":
            fmt = body[at:at + length]
        elif tag == b"data":
            pcm = memoryview(body)[at:at + length]
        at += length + (length & 1)
    if not fmt or len(fmt) < 16 or not pcm:
        raise ValueError("missing WAV samples or format")
    tag, channels, rate, _, align, bits = struct.unpack_from("<HHIIHH", fmt)
    if tag == 65534 and len(fmt) >= 40:
        tag = int.from_bytes(fmt[24:26], "little")
    if not 8000 <= rate <= 192000 or not 1 <= channels <= 8 or align != channels * ((bits + 7) // 8):
        raise ValueError("unsupported rate or layout")
    if not align or len(pcm) % align:
        raise ValueError("incomplete PCM frame")
    if tag == 7 and bits == 8:
        u = (~np.frombuffer(pcm, np.uint8)).astype(np.int32)
        mag = (((u & 15) * 8 + 132) << ((u >> 4) & 7)) - 132
        x = (np.where(u & 128, -mag, mag) / 32768).astype(np.float32)
    elif tag == 1 and bits == 8:
        x = (np.frombuffer(pcm, np.uint8).astype(np.float32) - 128) / 128
    elif tag == 1 and bits in (16, 32):
        x = np.frombuffer(pcm, "<i2" if bits == 16 else "<i4").astype(np.float32) / (1 << (bits - 1))
    elif tag == 1 and bits == 24:
        b = np.frombuffer(pcm, np.uint8).reshape(-1, 3).astype(np.int32)
        signed = (b[:, 0] | b[:, 1] << 8 | b[:, 2] << 16) << 8 >> 8
        x = signed.astype(np.float32) / (1 << 23)
    elif tag == 3 and bits in (32, 64):
        x = np.frombuffer(pcm, "<f4" if bits == 32 else "<f8").astype(np.float32)
    else:
        raise ValueError("unsupported WAV sample encoding")
    if channels != 1:
        x = x.reshape(-1, channels).mean(1)
    if not np.isfinite(x).all():
        raise ValueError("invalid waveform")
    return np.asarray(x, dtype=np.float32), rate


def to_16k(x, rate):
    if rate == 16000:
        return x
    common = math.gcd(16000, rate)
    return resample_poly(x, 16000 // common, rate // common).astype(np.float32, copy=False)


def planes(packed, w, h):
    n, quarter = w * h, w * h // 4
    return (packed[:n].reshape(h, w), packed[n:n + quarter].reshape(h // 2, w // 2),
            packed[n + quarter:].reshape(h // 2, w // 2))


class Atlas:
    def __init__(self, folder, masters, cache, phones):
        meta = json.loads((folder / "meta.json").read_text())
        self.name = meta["name"]
        if self.name != folder.name or not all(c.isascii() and (c.isalnum() or c == "_") for c in self.name):
            raise ValueError("invalid unit id")
        self.n, self.w, self.h = (int(meta[k]) for k in ("frames", "width", "height"))
        self.cycle = max(1, 2 * self.n - 2)
        if int(meta["fps"]) != FPS or self.n < 1 or min(self.h, self.w) < 2 or self.w % 2 or self.h % 2:
            raise ValueError("incompatible source geometry")
        self.x, self.y, self.rw, self.rh = (int(v) for v in meta["roi"])
        if any(v % 2 for v in (self.x, self.y, self.rw, self.rh)) or min(self.x, self.y) < 0 or min(self.rw, self.rh) < 2 or self.x + self.rw > self.w or self.y + self.rh > self.h:
            raise ValueError("invalid 4:2:0 patch rectangle")
        stored = meta["phones"]
        if len(stored) != len(phones) or set(stored) != set(phones):
            raise ValueError("missing or duplicate acoustic targets")
        self.order = np.asarray([stored.index(phone) for phone in phones])
        for key, file in (("patches_sha256", "patches.npy"), ("lips_sha256", "lips.npy")):
            if key in meta:
                with (folder / file).open("rb") as f:
                    if hashlib.file_digest(f, "sha256").hexdigest() != meta[key]:
                        raise ValueError(f"invalid {file} checksum")
        self.patches = np.load(folder / "patches.npy", mmap_mode="r", allow_pickle=False)
        size = self.rw * self.rh * 3 // 2
        if self.patches.dtype != np.uint8 or self.patches.shape != (self.n, len(stored), size):
            raise ValueError("patch array does not match metadata")
        master = masters / (self.name + ".mp4")
        with master.open("rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        if digest != meta["source_sha256"]:
            raise ValueError("master video and atlas fingerprint differ")
        cache.mkdir(parents=True, exist_ok=True)
        target = cache / (digest + ".yuv")
        frame_size = self.w * self.h * 3 // 2
        expected = self.n * frame_size
        if not target.exists() or target.stat().st_size != expected:
            with tempfile.NamedTemporaryFile(dir=cache, delete=False) as tmp:
                staging = Path(tmp.name)
            try:
                subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "2", "-i", str(master),
                                "-map", "0:v:0", "-fps_mode", "passthrough", "-threads", "1", "-f", "rawvideo",
                                "-pix_fmt", "yuv420p", str(staging)], check=True, timeout=120)
                if staging.stat().st_size != expected:
                    raise ValueError("source frame count or geometry differs")
                os.replace(staging, target)
            finally:
                staging.unlink(missing_ok=True)
        self.base = np.memmap(target, mode="r", dtype=np.uint8, shape=(self.n, frame_size))
        self.lips = None
        landmark_file = folder / "lips.npy"
        if landmark_file.is_file():
            landmarks = np.load(landmark_file, mmap_mode="r", allow_pickle=False)
            if landmarks.shape != (self.n, len(stored), 12, 2):
                raise ValueError("invalid oral landmark dimensions")
            self.lips = landmarks
        yy, xx = np.indices((self.rh, self.rw), dtype=np.float32)
        self.grid = np.stack((xx, yy), axis=-1)
        step = 5
        self.small_grid = cv2.resize(self.grid, ((self.rw+step-1)//step, (self.rh+step-1)//step),
                                     interpolation=cv2.INTER_AREA)

    def info(self):
        return dict(name=self.name, width=self.w, height=self.h, frames=self.n, fps=FPS, cycle=self.cycle)

    def frame_index(self, pos):
        pos %= self.cycle
        return pos if pos < self.n else self.cycle - pos

    def mouth(self, source, weights):
        # Only neighbouring poses with a meaningful acoustic contribution
        # share a frame. Strong consonants and digital silence retain their
        # original calibrated texture, including their teeth and lip seal.
        strongest = np.argsort(weights)[-2:][::-1]
        a, b = self.order[strongest]
        patch = planes(self.patches[source, a], self.rw, self.rh)
        mix = weights[strongest[1]] / (weights[strongest].sum() + 1e-9)
        if mix > .095:
            other = planes(self.patches[source, b], self.rw, self.rh)
            geometry = self.lips[source, [a, b]] if self.lips is not None else None
            patch = self.morph(patch, other, mix, geometry)
        return patch

    def place(self, target, patch):
        for i, (dest, src) in enumerate(zip(target, patch)):
            scale = 1 if i == 0 else 2
            x, y, w, h = (v // scale for v in (self.x, self.y, self.rw, self.rh))
            dest[y:y + h, x:x + w] = src

    def draw(self, pos, weights):
        source = self.frame_index(pos)
        base = self.base[source].copy()
        self.place(planes(base, self.w, self.h), self.mouth(source, weights))
        return base.reshape(self.h * 3 // 2, self.w)

    def picture(self, pos, weights):
        source = self.frame_index(pos)
        frame = av.VideoFrame.from_ndarray(self.base[source].reshape(self.h * 3 // 2, self.w),
                                           format="yuv420p")
        writable = [np.frombuffer(p, np.uint8).reshape(p.height, p.line_size) for p in frame.planes]
        self.place(writable, self.mouth(source, weights))
        return frame

    def morph(self, a, b, mix, geometry):
        # Corresponding source frames have identical head pose but different
        # lip contours. Warp each contour toward the in-between shape first
        # so coarticulation does not superimpose two sets of teeth.
        if geometry is not None and np.isfinite(geometry).all():
            first, second = geometry.astype(np.float32) - np.array([self.x, self.y], np.float32)
            middle = first + mix * (second - first)
            # Inverse-distance interpolation through the measured contour of
            # each real pair, anchored to zero motion at the ROI boundary.
            edge = np.array([[0, 0], [self.rw-1, 0], [0, self.rh-1], [self.rw-1, self.rh-1],
                             [self.rw/2, 0], [self.rw/2, self.rh-1]], dtype=np.float32)
            points = np.concatenate((middle, edge))
            change = np.concatenate((first - second, np.zeros_like(edge)))
            delta = self.small_grid[:, :, None, :] - points
            dist2 = np.einsum("...i,...i->...", delta, delta) + .5
            influence = 1 / (dist2 * dist2)
            influence /= influence.sum(axis=-1, keepdims=True)
            shift = cv2.resize(influence @ change, (self.rw, self.rh), interpolation=cv2.INTER_CUBIC)
            map_a = self.grid + shift * float(mix)
            map_b = self.grid - shift * float(1 - mix)
        else:
            # If the landmark tracker misses a face, estimate displacement
            # from its two native same-frame luma patches.
            shape = (self.rw // 2, self.rh // 2)
            small_a = cv2.resize(a[0], shape, interpolation=cv2.INTER_AREA)
            small_b = cv2.resize(b[0], shape, interpolation=cv2.INTER_AREA)
            def displacement(first, second):
                flow = cv2.calcOpticalFlowFarneback(first, second, None, .5, 2, 11, 2, 5, 1.1, 0)
                return cv2.resize(flow, (self.rw, self.rh), interpolation=cv2.INTER_LINEAR) * 2
            map_a = self.grid - displacement(small_a, small_b) * float(mix)
            map_b = self.grid - displacement(small_b, small_a) * float(1 - mix)
        result = []
        for i in range(3):
            if i == 1:
                shape = (self.rw // 2, self.rh // 2)
                map_a = (cv2.resize(map_a, shape, interpolation=cv2.INTER_AREA) - .5) * .5
                map_b = (cv2.resize(map_b, shape, interpolation=cv2.INTER_AREA) - .5) * .5
            aa = cv2.remap(a[i], map_a, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            bb = cv2.remap(b[i], map_b, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            result.append(cv2.addWeighted(aa, 1 - float(mix), bb, float(mix), 0))
        return result


def render(atlas, model, body, start, lead_ms, tail_ms, threads=2):
    begin = time.monotonic()
    x, rate = read_wav(body)
    lead, tail = round(rate * lead_ms / 1000), round(rate * tail_ms / 1000)
    main = len(x) - lead - tail
    if main <= 0 or main > rate * 5:
        raise ValueError("expected up to five seconds after context")
    frames = (main * FPS + rate - 1) // rate
    sound = to_16k(x, rate)
    lead16 = round(lead * 16000 / rate)
    weights = model.weights(sound, lead16, frames)
    if weights.shape != (frames, len(atlas.order)) or not np.isfinite(weights).all() or np.any(weights < 0) or np.any(weights.sum(1) < 1e-6):
        raise RuntimeError("phone model returned invalid weights")
    after_phones = time.monotonic()
    storage = io.BytesIO()
    mix_seconds = 0.0
    with av.open(storage, "w", format="mp4", options={"movflags": "frag_keyframe+empty_moov+default_base_moof+skip_trailer",
                                                      "frag_duration": "400000"}) as out:
        video = out.add_stream("libx264", rate=FPS)
        video.width, video.height, video.pix_fmt = atlas.w, atlas.h, "yuv420p"
        video.codec_context.time_base = Fraction(1, FPS)
        video.codec_context.thread_count = threads
        # A new client chunk must start independently and fit the site's
        # relay bandwidth. Keep High-profile headers compatible with the GPU.
        video.options = {"preset": os.environ.get("AVATAR_CPU_PRESET", "ultrafast"), "crf": "20",
                         "maxrate": "1750k", "bufsize": "480k",
                         "x264-params": ("keyint=25:min-keyint=25:scenecut=0:bframes=0:rc-lookahead=0:"
                                         "sync-lookahead=0:sliced-threads=1:cabac=1:8x8dct=1:"
                                         "colorprim=bt709:transfer=bt709:colormatrix=bt709")}
        for i in range(frames):
            then = time.monotonic()
            frame = atlas.picture(start + i, weights[i])
            mix_seconds += time.monotonic() - then
            frame.pts, frame.time_base = i, Fraction(1, FPS)
            for packet in video.encode(frame):
                out.mux(packet)
        for packet in video.encode():
            out.mux(packet)
    elapsed = time.monotonic() - begin
    tm = {"phones": after_phones - begin, "compose": mix_seconds,
          "encode": elapsed - (after_phones - begin) - mix_seconds, "total": elapsed}
    return storage.getvalue(), frames, tm
