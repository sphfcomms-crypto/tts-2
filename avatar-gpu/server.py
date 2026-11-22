#!/usr/bin/env python
"""Real-time lip-sync server: speech audio in, video of the avatar speaking it out.

Model   MuseTalk 1.5 (one UNet step per frame in the latent space of the SD VAE, driven by
        whisper-tiny audio features). The mouth region of a prepared base clip is redrawn and
        blended back into the untouched frame; everything is kept warm on one GPU.
API     GET  /health
        POST /speak?clip=talk&start=<int>[&lead_ms=<int>][&tail_ms=<int>][&audio=0]   body: WAV
        Every request needs the header x-avatar-key (see key.txt); anything else gets 401.
Run     /workspace/avatar-gpu/start.sh   (listens on 127.0.0.1:8000)
"""
import asyncio
import hashlib
import hmac
import io
import json
import math
import os
import queue
import struct
import sys
import threading
import time
import uuid
from fractions import Fraction

# all models are local files; keep the Hugging Face libraries away from the network and from the
# box image's own (read-only) cache folder
for _k in ("HUGGINGFACE_HUB_CACHE", "HF_HUB_CACHE", "TRANSFORMERS_CACHE"):
    os.environ.pop(_k, None)
os.environ["HF_HOME"] = "/tmp/hf-home"
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import av  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import soxr  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from fastapi import FastAPI, Query, Request  # noqa: E402
from fastapi.responses import JSONResponse, Response, StreamingResponse  # noqa: E402

ROOT = os.environ.get("AVATAR_ROOT", "/workspace/avatar-gpu")
MODELS = os.path.join(ROOT, "models")
HOST = os.environ.get("AVATAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("AVATAR_PORT", "8000"))

MODEL_NAME = "MuseTalk 1.5 (fp16)"
FPS = 25
AUDIO_RATE = 48000                       # AAC-LC output rate
SPF = AUDIO_RATE // FPS                  # audio samples per video frame (1920)
AAC_FRAME = 1024
MAX_SECONDS = float(os.environ.get("AVATAR_MAX_SECONDS", "120"))
FIRST_BATCH = int(os.environ.get("AVATAR_FIRST_BATCH", "16"))   # enough for the encoder to release the first fragment
BATCH = int(os.environ.get("AVATAR_BATCH", "24"))
WHOLE_BELOW = int(os.environ.get("AVATAR_WHOLE_BELOW", "15"))   # pieces up to this many frames are answered in one go
GRAPH_SIZES = (5, 10, 16, 24)                                   # UNet batch sizes recorded as CUDA graphs (10 = a 0.4 s live chunk)
SHARPEN = float(os.environ.get("AVATAR_SHARPEN", "0.5"))        # light unsharp mask on the redrawn face (0 = off)
_ref = os.environ.get("AVATAR_MEL_REF", "0.6")
MEL_REF = float(_ref) if _ref not in ("", "off") else None       # see Engine.log_mel
SILENCE_RMS = float(os.environ.get("AVATAR_SILENCE_RMS", "0.003"))     # see silence_gate; 0 switches it off
SILENCE_MIN_FRAMES = int(os.environ.get("AVATAR_SILENCE_MIN_FRAMES", "5"))

# H.264: x264, High profile, no B-frames (the first frame of every piece sits at time 0), a
# keyframe at the start and every 25 frames, constant quality capped at a bit rate.
X264_PRESET = os.environ.get("AVATAR_X264_PRESET", "faster")
X264_CRF = os.environ.get("AVATAR_X264_CRF", "16")
X264_EXTRA = os.environ.get("AVATAR_X264_EXTRA", "rc-lookahead=4:sync-lookahead=0:sliced-threads=1")
KBPS_AT_960x720 = float(os.environ.get("AVATAR_KBPS", "2500"))
FRAG_US = os.environ.get("AVATAR_FRAG_US", "400000")
AAC_BITRATE = 96000

KR, KB = 0.2126, 0.0722                  # BT.709
KG = 1.0 - KR - KB


def log(**kw):
    kw["t"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    print(json.dumps(kw), flush=True)


def load_key():
    k = os.environ.get("AVATAR_GPU_KEY", "")
    if not k:
        with open(os.path.join(ROOT, "key.txt")) as f:
            k = f.read()
    k = k.strip()
    if not k:
        raise SystemExit("no key: put it in key.txt (mode 600) or AVATAR_GPU_KEY")
    return k.encode()


# ----------------------------------------------------------------------------- audio in

def _wav_fallback(data):
    """Minimal RIFF reader for PCM WAVs whose header sizes are wrong (streamed WAVs)."""
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
    elif tag == 1 and bits == 8:
        x = (np.frombuffer(pcm, np.uint8).astype(np.float32) - 128.0) / 128.0
    elif tag == 1 and bits == 32:
        x = np.frombuffer(pcm[:len(pcm) // 4 * 4], "<i4").astype(np.float32) / 2147483648.0
    elif tag == 3 and bits == 32:
        x = np.frombuffer(pcm[:len(pcm) // 4 * 4], "<f4").astype(np.float32)
    else:
        raise ValueError(f"unsupported WAV encoding (format {tag}, {bits} bit)")
    x = x[:len(x) // ch * ch].reshape(-1, ch).mean(1)
    return x, rate


def read_audio(data):
    """-> mono float32 samples, sample rate."""
    try:
        x, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        x = x.mean(1)
        if len(x) == 0:
            raise ValueError("empty")
    except Exception:
        x, rate = _wav_fallback(data)
    return np.ascontiguousarray(x, np.float32), int(rate)


def resample(x, rate, to):
    if rate == to or len(x) == 0:
        return x
    return soxr.resample(x, rate, to, quality="HQ").astype(np.float32)


def silence_gate(wav16, lead16, n_frames):
    """How firmly the mouth should be held closed in each output frame: 0 = leave it to the model,
    1 = closed. wav16 is the 16 kHz audio including lead-in and tail context; output frame i
    covers the samples from lead16 + 640*i.

    A frame is silent when its RMS is below SILENCE_RMS. Only pauses of at least SILENCE_MIN_FRAMES
    count (the short gaps inside words are the model's business). The mouth closes over the first
    two frames of a pause and starts to open two frames before the voice comes back; a pause that
    runs into the edge of the audio is taken to go on beyond it.
    """
    if SILENCE_RMS <= 0:
        return None
    before = lead16 // 640                                   # whole context frames in front
    x = wav16[lead16 - before * 640:]
    total = max(before + n_frames, -(-len(x) // 640))
    x = np.pad(x, (0, total * 640 - len(x)))
    silent = np.sqrt((x.reshape(total, 640) ** 2).mean(1)) < SILENCE_RMS
    g = np.zeros(total, np.float32)
    i = 0
    while i < total:
        if not silent[i]:
            i += 1
            continue
        j = i
        while j + 1 < total and silent[j + 1]:
            j += 1
        open_left, open_right = i == 0, j == total - 1       # pause continues beyond what we were given
        if open_left or open_right or j - i + 1 >= SILENCE_MIN_FRAMES:
            g[i:j + 1] = 1.0
            if not open_left:
                g[i] = 0.0
                if i + 1 <= j:
                    g[i + 1] = 0.5
            if not open_right:
                g[j] = 0.0
                if j - 1 >= i:
                    g[j - 1] = min(g[j - 1], 0.5)
        i = j + 1
    g = g[before:before + n_frames]
    return g if g.any() else None


# ----------------------------------------------------------------------------- clips

class Clip:
    def __init__(self, folder, dev):
        with open(os.path.join(folder, "meta.json")) as f:
            m = json.load(f)
        self.meta = m
        self.name, self.n, self.w, self.h = m["name"], m["frames"], m["width"], m["height"]
        self.cycle = m["cycle"]
        self.wx0, self.wy0, self.wx1, self.wy1 = m["window"]
        self.ww, self.wh = self.wx1 - self.wx0, self.wy1 - self.wy0
        w, h, n = self.w, self.h, self.n
        q = w * h // 4
        # The untouched frames stay in main memory (planar YUV 4:2:0, one row per frame). Only the
        # window around the face lives on the GPU, and only that window is ever sent back from it.
        self.base = np.fromfile(os.path.join(folder, "base.yuv"), np.uint8).reshape(n, w * h + 2 * q)
        x0, y0, x1, y1 = self.wx0, self.wy0, self.wx1, self.wy1
        self.Y = torch.from_numpy(np.ascontiguousarray(
            self.base[:, :w * h].reshape(n, h, w)[:, y0:y1, x0:x1])).to(dev)
        self.U = torch.from_numpy(np.ascontiguousarray(
            self.base[:, w * h:w * h + q].reshape(n, h // 2, w // 2)[:, y0 // 2:y1 // 2, x0 // 2:x1 // 2])).to(dev)
        self.V = torch.from_numpy(np.ascontiguousarray(
            self.base[:, w * h + q:].reshape(n, h // 2, w // 2)[:, y0 // 2:y1 // 2, x0 // 2:x1 // 2])).to(dev)
        self.latents = torch.from_numpy(np.load(os.path.join(folder, "latents.npy"))).to(dev, torch.float16)
        self.alpha = torch.from_numpy(np.load(os.path.join(folder, "alpha.npy"))).to(dev)
        self.theta = torch.from_numpy(np.load(os.path.join(folder, "theta.npy"))).to(dev, torch.float32)
        self.kbps = int(round(KBPS_AT_960x720 * (w * h) / (960 * 720) / 50.0) * 50)

    def frame_at(self, pos):
        """Position in the forwards-then-backwards cycle -> frame number of the clip."""
        p = pos % self.cycle
        return p if p < self.n else self.cycle - p

    def compose(self, frame_id, win):
        """Untouched frame with the redrawn window pasted in -> array (h*3/2, w) for the encoder."""
        w, h, q = self.w, self.h, self.w * self.h // 4
        n1 = self.ww * self.wh
        f = self.base[frame_id].copy()
        f[:w * h].reshape(h, w)[self.wy0:self.wy1, self.wx0:self.wx1] = win[:n1].reshape(self.wh, self.ww)
        f[w * h:w * h + q].reshape(h // 2, w // 2)[self.wy0 // 2:self.wy1 // 2, self.wx0 // 2:self.wx1 // 2] = \
            win[n1:n1 + n1 // 4].reshape(self.wh // 2, self.ww // 2)
        f[w * h + q:].reshape(h // 2, w // 2)[self.wy0 // 2:self.wy1 // 2, self.wx0 // 2:self.wx1 // 2] = \
            win[n1 + n1 // 4:].reshape(self.wh // 2, self.ww // 2)
        return f.reshape(h * 3 // 2, w)

    def info(self):
        return {"name": self.name, "frames": self.n, "fps": FPS, "width": self.w, "height": self.h,
                "cycle": self.cycle, "video_kbps_cap": self.kbps}


# ----------------------------------------------------------------------------- MP4 out

class _Sink:
    """File-like object PyAV writes the fragmented MP4 into; passes the bytes on as they come."""

    def __init__(self, emit):
        self.emit = emit
        self.size = 0
        self.t_first = None
        self.t_first_fragment = None

    def write(self, b):
        b = bytes(b)
        now = time.perf_counter()
        if self.t_first is None:
            self.t_first = now
        if self.t_first_fragment is None and b"moof" in b:
            self.t_first_fragment = now
        self.size += len(b)
        self.emit(b)
        return len(b)


class Mp4Writer:
    """One fragmented MP4 (init segment + fragments), written piece by piece.

    Video: every frame gets pts = its index at 1/25 s, starting at exactly 0.
    Audio: AAC-LC 48 kHz mono, first packet at time 0 and total length equal to the video's.
    """

    def __init__(self, clip, emit, pcm):
        self.sink = _Sink(emit)
        self.c = av.open(self.sink, mode="w", format="mp4", options={
            "movflags": "frag_keyframe+empty_moov+default_base_moof+skip_trailer",
            "frag_duration": FRAG_US,
        })
        cap = clip.kbps
        v = self.c.add_stream("libx264", rate=FPS, options={
            "preset": X264_PRESET, "crf": X264_CRF,          # 8-bit 4:2:0 input -> High profile
            "maxrate": f"{int(cap * 1.4)}k", "bufsize": f"{int(cap * 2)}k",
            "x264-params": ("keyint=25:min-keyint=25:scenecut=0:bframes=0:"
                            "colorprim=bt709:transfer=bt709:colormatrix=bt709:" + X264_EXTRA),
        })
        v.width, v.height, v.pix_fmt = clip.w, clip.h, "yuv420p"
        v.codec_context.time_base = Fraction(1, FPS)
        self.v = v
        self.clip = clip
        self.vi = 0
        self.apkts = []
        self.ai = 0
        a = None
        if pcm is not None:
            a = self.c.add_stream("aac", rate=AUDIO_RATE)
            a.bit_rate = AAC_BITRATE
            a.layout = "mono"
        self.c.start_encoding()                                 # writes ftyp + moov now
        if a is not None:
            # The AAC encoder puts one priming frame (1024 samples) in front of the sound. Feeding
            # it 1024 samples less than the video lasts and moving every packet 1024 samples later
            # gives: first packet at time 0, audio exactly as long as the video, no edit list.
            frame = av.AudioFrame.from_ndarray(pcm[None, :], format="s16", layout="mono")
            frame.sample_rate = AUDIO_RATE
            frame.pts = 0
            frame.time_base = Fraction(1, AUDIO_RATE)
            for src in (frame, None):
                for p in a.encode(src):
                    p.pts += AAC_FRAME
                    p.dts += AAC_FRAME
                    self.apkts.append(p)

    def _audio_until(self, samples):
        while self.ai < len(self.apkts) and self.apkts[self.ai].pts < samples:
            self.c.mux(self.apkts[self.ai])
            self.ai += 1

    def video(self, frame_ids, windows):
        """frame_ids: frames of the clip; windows: their redrawn face windows from Engine.render."""
        for fid, win in zip(frame_ids, windows):
            vf = av.VideoFrame.from_ndarray(self.clip.compose(fid, win), format="yuv420p")
            vf.pts = self.vi
            vf.time_base = Fraction(1, FPS)
            self.vi += 1
            for p in self.v.encode(vf):
                self.c.mux(p)
        self._audio_until(self.vi * SPF)

    def close(self):
        for p in self.v.encode(None):
            self.c.mux(p)
        self._audio_until(1 << 62)
        self.c.close()


# ----------------------------------------------------------------------------- the model

class Job:
    def __init__(self, **kw):
        self.__dict__.update(kw)
        self.frames_q = queue.Queue(maxsize=4)
        self.tm = {}


class Engine:
    def __init__(self, warm=True):
        t0 = time.perf_counter()
        from diffusers import AutoencoderKL, UNet2DConditionModel
        from safetensors.torch import load_file
        from transformers import WhisperFeatureExtractor, WhisperModel

        self.dev = torch.device("cuda")
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

        with open(os.path.join(MODELS, "musetalkV15", "musetalk.json")) as f:
            cfg = json.load(f)
        unet = UNet2DConditionModel(**cfg).half()
        unet.load_state_dict(load_file(os.path.join(MODELS, "musetalkV15", "unet_fp16.safetensors")))
        self.unet = unet.to(self.dev).to(memory_format=torch.channels_last).eval()

        vae = AutoencoderKL.from_pretrained(os.path.join(MODELS, "sd-vae"), torch_dtype=torch.float16,
                                            use_safetensors=False)
        self.vae = vae.to(self.dev).eval()               # plain NCHW measured a little faster here
        self.sf = float(vae.config.scaling_factor)

        whisper = WhisperModel.from_pretrained(os.path.join(MODELS, "whisper"), torch_dtype=torch.float16)
        self.whisper = whisper.encoder.to(self.dev).eval()
        self.fe = WhisperFeatureExtractor.from_pretrained(os.path.join(MODELS, "whisper"))
        self.mel_filters = torch.from_numpy(np.asarray(self.fe.mel_filters, np.float32).T.copy()).to(self.dev)   # (80, 201)
        self.window = torch.hann_window(400, device=self.dev)

        # sinusoidal position code MuseTalk adds to the 50 audio tokens of a frame
        pe = torch.zeros(50, 384)
        position = torch.arange(0, 50, dtype=torch.float).unsqueeze(1)
        div = torch.exp(torch.arange(0, 384, 2).float() * (-math.log(10000.0) / 384))
        pe[:, 0::2] = torch.sin(position * div)
        pe[:, 1::2] = torch.cos(position * div)
        self.pe = pe.unsqueeze(0).to(self.dev, torch.float16)
        self.t0 = torch.tensor([0], device=self.dev)

        # audio features that make the model draw a closed, relaxed mouth (calibrate_silence.py)
        self.closed = None
        path = os.path.join(MODELS, "closed_mouth.npy")
        if os.path.isfile(path) and not os.environ.get("AVATAR_NO_CLOSED_MOUTH"):
            self.closed = torch.from_numpy(np.load(path)).to(self.dev, torch.float16)[None]

        self.clips = {}
        root = os.path.join(ROOT, "avatars")
        for name in sorted(os.listdir(root)):
            if os.path.isfile(os.path.join(root, name, "meta.json")):
                self.clips[name] = Clip(os.path.join(root, name), self.dev)
        if not self.clips:
            raise SystemExit("no prepared clip in avatars/: run prepare.py first")

        self.jobs = queue.Queue()
        self.last = None
        self.count = 0
        self.started = time.time()
        threading.Thread(target=self._gpu_loop, daemon=True, name="gpu").start()
        self.capture_unet_graphs()
        self.load_seconds = time.perf_counter() - t0
        if warm:
            self.warm_up()
        log(event="ready", closed_mouth_in_pauses=self.closed is not None, unet_cuda_graphs=sorted(self.graphs), load_seconds=round(self.load_seconds, 1), clips=[c.info() for c in self.clips.values()],
            total_seconds=round(time.perf_counter() - t0, 1))

    # -- audio features (same maths as MuseTalk's AudioProcessor, plus an optional lead-in) -------------
    @torch.inference_mode()
    def log_mel(self, wav16, mel_ref=MEL_REF):
        """Whisper's log-mel input for up to 30 s of 16 kHz audio, computed on the GPU.

        Whisper scales the picture by the loudest point of the 30 s window it is given. A request
        that holds only a pause (or very quiet sound) would therefore be blown up to full scale,
        which the lip model has never seen and answers with a random open mouth. mel_ref is the
        peak of normal speech from the app's voice: the window is scaled as if speech of that
        level were also in it, so a pause looks like a pause inside a sentence.
        """
        x = torch.from_numpy(np.ascontiguousarray(wav16, np.float32)).to(self.dev)
        x = F.pad(x, (0, 30 * 16000 - x.numel()))
        spec = torch.stft(x, 400, 160, window=self.window, return_complex=True)
        mel = self.mel_filters @ (spec[..., :-1].abs() ** 2)
        logmel = mel.clamp_(min=1e-10).log10_()
        top = logmel.max()
        if mel_ref is not None:
            top = top.clamp(min=mel_ref)
        logmel = torch.maximum(logmel, top - 8.0)
        return ((logmel + 4.0) / 4.0)[None].to(torch.float16), float(top)

    @torch.inference_mode()
    def audio_features(self, wav16, lead_steps, n_frames, mel_ref=MEL_REF):
        """wav16: mono 16 kHz. lead_steps: 20 ms steps of context in front of the first frame."""
        feats = []
        for i in range(0, len(wav16), 30 * 16000):
            mel, _ = self.log_mel(wav16[i:i + 30 * 16000], mel_ref)
            hs = self.whisper(mel, output_hidden_states=True).hidden_states
            feats.append(torch.stack(hs, dim=2)[0])                      # (1500, 5, 384)
        f = torch.cat(feats, 0)[:len(wav16) // 320]                      # drop what is only padding
        need = lead_steps + 2 * n_frames + 8
        z = f.new_zeros
        f = torch.cat([z(4, 5, 384), f, z(max(0, need - 4 - f.shape[0]) + 12, 5, 384)], 0)
        idx = lead_steps + 2 * torch.arange(n_frames, device=self.dev)[:, None] + torch.arange(10, device=self.dev)[None]
        return f[idx].reshape(n_frames, 50, 384)                         # 10 steps x 5 layers per frame

    # -- the UNet step ---------------------------------------------------------------------------------
    def capture_unet_graphs(self):
        """Record the UNet forward pass as CUDA graphs for a few fixed batch sizes.

        One forward pass is about 1,500 small GPU calls; started one by one from Python they cost
        some 30 ms per batch here, however small the batch. A recorded graph replays them in one
        go. Batches are padded up to the next recorded size (the padding rows are thrown away).
        """
        self.graphs = {}
        if os.environ.get("AVATAR_CUDA_GRAPH", "1") == "0":
            return
        try:
            for size in GRAPH_SIZES:
                lat = torch.zeros(size, 8, 32, 32, device=self.dev, dtype=torch.float16).contiguous(memory_format=torch.channels_last)
                cond = torch.zeros(size, 50, 384, device=self.dev, dtype=torch.float16)
                with torch.inference_mode():
                    for _ in range(2):
                        ref = self.unet(lat, self.t0, encoder_hidden_states=cond, return_dict=False)[0]
                    torch.cuda.synchronize()
                    graph = torch.cuda.CUDAGraph()
                    with torch.cuda.graph(graph):
                        out = self.unet(lat, self.t0, encoder_hidden_states=cond, return_dict=False)[0]
                    graph.replay()
                    torch.cuda.synchronize()
                    if not torch.allclose(out.float(), ref.float(), atol=2e-2):
                        raise RuntimeError("graph output differs from the normal forward pass")
                self.graphs[size] = (graph, lat, cond, out)
        except Exception as e:  # noqa: BLE001
            log(event="cuda_graph_off", error=repr(e)[:300])
            self.graphs = {}

    def unet_step(self, lat, cond):
        b = lat.shape[0]
        size = next((s for s in GRAPH_SIZES if s >= b and s in self.graphs), None)
        if size is None:
            lat = lat.contiguous(memory_format=torch.channels_last)
            return self.unet(lat, self.t0, encoder_hidden_states=cond, return_dict=False)[0]
        graph, g_lat, g_cond, g_out = self.graphs[size]
        g_lat[:b].copy_(lat)
        g_cond[:b].copy_(cond)
        graph.replay()
        return g_out[:b]                 # valid until the next replay; the caller uses it right away

    # -- one batch of frames ---------------------------------------------------------------------------
    @torch.inference_mode()
    def render(self, clip, frame_ids, feats, tm):
        sync = torch.cuda.synchronize
        t0 = time.perf_counter()
        idx = torch.as_tensor(frame_ids, device=self.dev)
        b = idx.numel()
        pred = self.unet_step(clip.latents[idx], feats + self.pe)
        sync()
        t1 = time.perf_counter()
        img = self.vae.decode((pred / self.sf).contiguous(), return_dict=False)[0]
        img = (img.float() * 0.5 + 0.5).clamp_(0, 1)                     # (b, 3, 256, 256) RGB
        sync()
        t2 = time.perf_counter()

        # place the generated face on its box inside the fixed window, at the frame's own resolution
        grid = F.affine_grid(clip.theta[idx], (b, 3, clip.wh, clip.ww), align_corners=False)
        face = F.grid_sample(img, grid, mode="bicubic", padding_mode="border", align_corners=False)
        if SHARPEN > 0:
            blur = F.avg_pool2d(F.pad(face, (1, 1, 1, 1), mode="replicate"), 3, stride=1)
            face = face + SHARPEN * (face - blur)
        face = face.clamp_(0, 1)
        r, g, bl = face[:, 0], face[:, 1], face[:, 2]
        luma = KR * r + KG * g + KB * bl
        y_new = 16.0 + 219.0 * luma
        cb = F.avg_pool2d((128.0 + 112.0 * (bl - luma) / (1.0 - KB))[:, None], 2)[:, 0]
        cr = F.avg_pool2d((128.0 + 112.0 * (r - luma) / (1.0 - KR))[:, None], 2)[:, 0]
        a = clip.alpha[idx].float() * (1.0 / 255.0)
        a2 = F.avg_pool2d(a[:, None], 2)[:, 0]

        # blend in YUV: where the mask is 0 the picture stays bit-exact
        yf, uf, vf = clip.Y[idx].float(), clip.U[idx].float(), clip.V[idx].float()
        y = (yf + (y_new - yf) * a).round_().clamp_(0, 255).to(torch.uint8)
        u = (uf + (cb - uf) * a2).round_().clamp_(0, 255).to(torch.uint8)
        v = (vf + (cr - vf) * a2).round_().clamp_(0, 255).to(torch.uint8)
        out = torch.cat([y.reshape(b, -1), u.reshape(b, -1), v.reshape(b, -1)], 1)
        sync()
        t3 = time.perf_counter()
        arr = out.cpu().numpy()                                      # (b, window as planar YUV 4:2:0)
        t4 = time.perf_counter()
        tm["unet"] = tm.get("unet", 0.0) + (t1 - t0)
        tm["vae"] = tm.get("vae", 0.0) + (t2 - t1)
        tm["blend"] = tm.get("blend", 0.0) + (t3 - t2)
        tm["copy"] = tm.get("copy", 0.0) + (t4 - t3)
        return arr

    def _gpu_loop(self):
        """All GPU work happens here, one job after the other."""
        while True:
            job = self.jobs.get()
            try:
                job.tm["queue"] = time.perf_counter() - job.t_recv
                t = time.perf_counter()
                feats = self.audio_features(job.wav16, job.lead_steps, job.n_frames)
                if self.closed is not None and job.gate is not None:
                    g = torch.from_numpy(job.gate).to(self.dev, torch.float16)[:, None, None]
                    feats = feats + (self.closed - feats) * g
                torch.cuda.synchronize()
                job.tm["feat"] = time.perf_counter() - t
                done = 0
                while done < job.n_frames:
                    bs = min(FIRST_BATCH if done == 0 else BATCH, job.n_frames - done)
                    ids = [job.clip.frame_at(job.start + done + k) for k in range(bs)]
                    job.frames_q.put((ids, self.render(job.clip, ids, feats[done:done + bs], job.tm)))
                    done += bs
                job.tm["gpu_done"] = time.perf_counter() - job.t_recv
                job.frames_q.put(None)
            except Exception as e:  # noqa: BLE001
                log(event="gpu_error", error=repr(e))
                job.frames_q.put(e)

    # -- one request: GPU thread renders, this thread encodes and hands the bytes on ----------------------
    def run(self, job):
        ok = False
        try:
            self.jobs.put(job)
            t = time.perf_counter()
            writer = Mp4Writer(job.clip, job.emit, job.pcm48)     # sends the MP4 header straight away
            t_enc = time.perf_counter() - t
            while True:
                item = job.frames_q.get()
                if isinstance(item, Exception):
                    raise item
                t = time.perf_counter()
                if item is None:
                    writer.close()
                    t_enc += time.perf_counter() - t
                    break
                writer.video(*item)
                t_enc += time.perf_counter() - t
            now = time.perf_counter()
            tm = job.tm
            total = now - job.t_recv
            stats = {
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "clip": job.clip.name, "frames": job.n_frames, "audio_seconds": round(job.seconds, 3),
                "processing_seconds": round(total, 4),
                "seconds_per_second_of_speech": round(total / job.seconds, 4),
                "frames_per_second": round(job.n_frames / total, 1),
                "first_byte_ms": round(1e3 * (writer.sink.t_first - job.t_recv), 1),
                "first_fragment_ms": round(1e3 * ((writer.sink.t_first_fragment or now) - job.t_recv), 1),
                "ms": {k: round(1e3 * tm.get(k, 0.0), 1) for k in ("parse", "queue", "feat", "unet", "vae", "blend", "copy")},
                "bytes": writer.sink.size,
            }
            stats["ms"]["encode"] = round(1e3 * t_enc, 1)
            stats["ms"]["total"] = round(1e3 * total, 1)
            job.stats = stats
            self.last = stats
            self.count += 1
            if not job.warm:
                log(event="speak", start=job.start, lead_ms=job.lead_ms, **stats)
            ok = True
        except Exception as e:  # noqa: BLE001
            log(event="speak_error", error=repr(e))
            job.emit(e)
        finally:
            if ok:
                job.emit(None)

    def make_job(self, clip, start, x, rate, lead_ms, tail_ms, with_audio, emit, t_recv, warm=False):
        """Cut the request audio into context and the part to render. Raises ValueError on bad input."""
        lead = int(round(lead_ms * rate / 1000.0))
        tail = int(round(tail_ms * rate / 1000.0))
        main = len(x) - lead - tail
        if main <= 0:
            raise ValueError("no audio left after lead_ms/tail_ms")
        seconds = main / rate
        if seconds > MAX_SECONDS:
            raise OverflowError(f"audio longer than {MAX_SECONDS:.0f} s")
        n_frames = (main * FPS + rate - 1) // rate                      # ceil(seconds * 25)
        wav16 = resample(x, rate, 16000)
        lead16 = int(round(lead_ms * 16.0))
        wav16 = wav16[lead16 % 320:]                                     # whole 20 ms steps of lead-in
        pcm48 = None
        if with_audio:
            y = resample(x[lead:lead + main], rate, AUDIO_RATE)
            want = n_frames * SPF - AAC_FRAME                            # see Mp4Writer
            y = np.pad(y, (0, max(0, want - len(y))))[:want]
            pcm48 = np.clip(np.rint(y * 32767.0), -32768, 32767).astype(np.int16)
        lead16 = lead16 // 320 * 320
        return Job(clip=clip, start=start % clip.cycle, wav16=wav16, lead_steps=lead16 // 320, n_frames=int(n_frames),
                   gate=silence_gate(wav16, lead16, int(n_frames)), seconds=seconds, pcm48=pcm48, emit=emit,
                   t_recv=t_recv, lead_ms=lead_ms, warm=warm, stats=None)

    def warm_up(self):
        """Run the whole path a few times so the first real request is already fast."""
        clip = next(iter(self.clips.values()))
        rng = np.random.default_rng(0)
        for seconds in (0.4, 0.2, 3.0, 0.4, 0.4, 0.4):
            x = (rng.standard_normal(int(seconds * 24000)) * 0.05).astype(np.float32)
            job = self.make_job(clip, 0, x, 24000, 0, 0, True, lambda b: None, time.perf_counter(), warm=True)
            self.run(job)
            if job.stats is None:
                raise SystemExit("warm-up failed, see the error above")
        torch.cuda.synchronize()
        self.last = None
        self.count = 0

    def gpu_memory(self):
        free, total = torch.cuda.mem_get_info()
        return {"used_mb_all_processes": round((total - free) / 2**20), "total_mb": round(total / 2**20),
                "torch_allocated_mb": round(torch.cuda.memory_allocated() / 2**20),
                "torch_reserved_mb": round(torch.cuda.memory_reserved() / 2**20)}


# ----------------------------------------------------------------------------- HTTP

KEY = load_key()
ENGINE = None
# When someone last made her speak. The box bills by the hour whether she speaks or not, so
# /health reports how long she has been silent ("idle_seconds") and keeper.sh stops everything
# after AVATAR_IDLE_MINUTES of that; the box then pauses by itself and billing ends.
LAST_USED = time.time()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


CORS = [(b"access-control-allow-origin", b"*"),
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
    its address for POST /speak (a browser), or asks for a kept piece by its secret id, or for one
    of her body-language clips (the same files the app serves to anyone). Anything else
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
        allowed = (method == "GET" and (path.startswith("/piece/") or path.startswith("/clip/"))) or \
                  (method == "POST" and path == "/speak" and token_ok(scope.get("query_string", b"")))
        if not allowed:
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
    LAST_USED = time.time()          # the idle clock starts when she is ready, not while loading


@app.get("/health")
def health():
    e = ENGINE
    return {"ok": True, "model": MODEL_NAME, "encoder": f"libx264 {X264_PRESET} crf {X264_CRF}, aac-lc 48 kHz mono",
            "clips": [c.info() for c in e.clips.values()], "speed": e.last, "requests": e.count,
            "gpu_memory": e.gpu_memory(), "uptime_seconds": round(time.time() - e.started),
            "idle_seconds": round(time.time() - LAST_USED)}


def _err(status, msg, **kw):
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


# Her body-language clips as the browser plays them (web/units/<name>.mp4, copied from the app by
# start.sh). The app's own line was measured slower than the clips play; this one is not.
WEB_CLIPS = os.path.join(ROOT, "web", "units")


@app.get("/clip/{name}.mp4")
def clip_file(name: str):
    path = os.path.join(WEB_CLIPS, name + ".mp4")
    if not name.replace("_", "").isalnum() or not os.path.isfile(path):
        return _err(404, "no such clip")
    with open(path, "rb") as f:
        return Response(f.read(), media_type="video/mp4", headers={"Cache-Control": "public, max-age=3600"})


@app.post("/speak")
async def speak(request: Request, clip: str = "talk", start: int = 0, lead_ms: int = 0, tail_ms: int = 0, audio: int = 1,
                keep_piece: int = Query(0, alias="keep")):
    global LAST_USED
    LAST_USED = time.time()
    e = ENGINE
    c = e.clips.get(clip)
    if c is None:
        return _err(404, f"unknown clip '{clip}'", clips=sorted(e.clips))
    if start < 0 or lead_ms < 0 or tail_ms < 0:
        return _err(400, "start, lead_ms and tail_ms must not be negative")
    body = await request.body()
    t_recv = time.perf_counter()
    loop = asyncio.get_running_loop()
    q = asyncio.Queue()

    def emit(item):
        loop.call_soon_threadsafe(q.put_nowait, item)

    try:
        x, rate = read_audio(body)
        job = e.make_job(c, start, x, rate, lead_ms, tail_ms, bool(audio), emit, t_recv)
    except OverflowError as ex:
        return _err(413, str(ex))
    except Exception as ex:  # noqa: BLE001
        return _err(400, "the body must be a WAV file with audio after the lead", detail=str(ex))
    job.tm["parse"] = time.perf_counter() - t_recv
    headers = {
        "X-Next-Start": str((job.start + job.n_frames) % c.cycle),
        "X-Start": str(job.start), "X-Frames": str(job.n_frames), "X-Cycle": str(c.cycle),
        "X-Duration": f"{job.n_frames / FPS:.3f}", "Cache-Control": "no-store",
    }
    threading.Thread(target=e.run, args=(job,), daemon=True).start()

    if keep_piece or job.n_frames <= WHOLE_BELOW:      # short piece, or one to keep: finish it first
        parts = []
        while True:
            item = await q.get()
            if item is None:
                break
            if isinstance(item, Exception):
                return _err(500, "render failed", detail=repr(item))
            parts.append(item)
        ms = job.stats["ms"]
        headers["Server-Timing"] = ", ".join(f"{k};dur={v}" for k, v in ms.items())
        if keep_piece:                                 # the browser fetches it itself: GET /piece/<id>
            data = b"".join(parts)
            return JSONResponse({"ok": True, "id": keep(data), "bytes": len(data), "frames": job.n_frames,
                                 "next": (job.start + job.n_frames) % c.cycle}, headers=headers)
        return Response(b"".join(parts), media_type="video/mp4", headers=headers)

    first = await q.get()                              # longer piece: send it while it is being made
    if isinstance(first, Exception):
        return _err(500, "render failed", detail=repr(first))

    async def stream():
        item = first
        while item is not None and not isinstance(item, Exception):
            yield item
            item = await q.get()

    return StreamingResponse(stream(), media_type="video/mp4", headers=headers)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning", access_log=False, timeout_keep_alive=75)
