#!/usr/bin/env python
"""One-time preparation of a base clip for the lip-sync server.

For every frame of the clip this caches what MuseTalk 1.5 needs at speaking time:
the face box, the VAE latents of the face crop (masked half + reference), the blend
mask, and the untouched picture itself as YUV 4:2:0 planes. Run on the GPU box:

    /workspace/avatar-gpu/venv/bin/python /workspace/avatar-gpu/prepare.py --clip talk

Input : /workspace/avatar-gpu/clips/<clip>.mp4   (every frame is used; the frames are
        treated as 25 fps whatever the file says, so a 24 fps clip plays 4 % faster)
Output: /workspace/avatar-gpu/avatars/<clip>/    (meta.json, base.yuv, latents.npy,
        alpha.npy, theta.npy, boxes.npy, debug/*.jpg)
"""
import argparse
import json
import os
import subprocess
import sys
import time

for _k in ("HUGGINGFACE_HUB_CACHE", "HF_HUB_CACHE", "TRANSFORMERS_CACHE"):   # the box image's cache folder is read-only
    os.environ.pop(_k, None)
os.environ["HF_HOME"] = "/tmp/hf-home"

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from scipy.ndimage import gaussian_filter1d  # noqa: E402

ROOT = os.environ.get("AVATAR_ROOT", "/workspace/avatar-gpu")
MT = os.path.join(ROOT, "src", "MuseTalk")
FFMPEG = os.path.join(ROOT, "bin", "ffmpeg")
FFPROBE = os.path.join(ROOT, "bin", "ffprobe")
FPS = 25

# BT.709, limited range. The source clips carry no colour tags; at this size browsers
# and players read untagged H.264 as BT.709, and the first frame matches the original
# still best with it, so that is what every conversion here and in server.py uses.
KR, KB = 0.2126, 0.0722
KG = 1.0 - KR - KB


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def probe(path):
    out = subprocess.check_output([
        FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames,pix_fmt,color_space,color_range",
        "-of", "json", path])
    return json.loads(out)["streams"][0]


def decode_yuv(path, size=None):
    """All frames as raw yuv420p, exactly as decoded (optionally resized)."""
    info = probe(path)
    w, h = int(info["width"]), int(info["height"])
    cmd = [FFMPEG, "-v", "error", "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough"]
    if size and size != (w, h):
        w, h = size
        cmd += ["-vf", f"scale={w}:{h}:flags=lanczos+accurate_rnd"]
    if w % 2 or h % 2:
        raise SystemExit(f"width and height must be even, got {w}x{h}")
    cmd += ["-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]
    raw = subprocess.check_output(cmd)
    fs = w * h * 3 // 2
    if len(raw) % fs:
        raise SystemExit("decoded size is not a whole number of frames")
    return np.frombuffer(raw, np.uint8).reshape(-1, fs), w, h, info


def yuv_to_rgb(yuv, w, h, dev):
    n = yuv.shape[0]
    out = np.empty((n, h, w, 3), np.uint8)
    q = w * h // 4
    for i in range(0, n, 32):
        t = torch.from_numpy(yuv[i:i + 32]).to(dev)
        b = t.shape[0]
        y = (t[:, :w * h].reshape(b, 1, h, w).float() - 16.0) / 219.0
        u = (t[:, w * h:w * h + q].reshape(b, 1, h // 2, w // 2).float() - 128.0) / 224.0
        v = (t[:, w * h + q:].reshape(b, 1, h // 2, w // 2).float() - 128.0) / 224.0
        u = F.interpolate(u, size=(h, w), mode="bilinear", align_corners=False)
        v = F.interpolate(v, size=(h, w), mode="bilinear", align_corners=False)
        r = y + 2.0 * (1.0 - KR) * v
        bl = y + 2.0 * (1.0 - KB) * u
        g = (y - KR * r - KB * bl) / KG
        rgb = torch.cat([r, g, bl], 1).clamp_(0, 1).mul_(255.0).round_().byte()
        out[i:i + 32] = rgb.permute(0, 2, 3, 1).cpu().numpy()
    return out


def face_landmarks(frames_rgb):
    """68 face landmarks per frame from DWPose (the detector MuseTalk itself uses), via ONNX Runtime."""
    from rtmlib import RTMPose
    pose = RTMPose(onnx_model=os.path.join(ROOT, "models", "dwpose", "dw-ll_ucoco_384.onnx"),
                   model_input_size=(288, 384), backend="onnxruntime", device="cpu")
    lms, conf = [], []
    for i, f in enumerate(frames_rgb):
        kp, sc = pose(np.ascontiguousarray(f[:, :, ::-1]))
        lms.append(kp[0][23:91])
        conf.append(float(sc[0][23:91].mean()))
        if i % 60 == 0:
            log(f"  landmarks {i}/{len(frames_rgb)}  confidence {conf[-1]:.2f}")
    return np.stack(lms).astype(np.float64), np.array(conf)


def boxes_from_landmarks(lm, w, h, extra_margin, sigma, neutral_jaw=False):
    """Face box exactly as MuseTalk 1.5 builds it (landmark 29 in the vertical middle, chin
    plus a margin at the bottom), then lightly smoothed over time so its size does not jitter.

    neutral_jaw: for a base clip in which she is already talking. The box bottom follows the chin,
    so an open jaw in the base makes the box taller and the model then draws an open mouth whatever
    the audio says. With this option the part of the chin's travel that goes with the lips opening
    (fitted over the whole clip) is taken out, as if her jaw were closed in every frame."""
    li = lm.astype(np.int32)
    half_y = li[:, 29, 1]
    y_max = li[:, :, 1].max(1).astype(np.float64)
    x_min = li[:, :, 0].min(1)
    x_max = li[:, :, 0].max(1)
    if neutral_jaw:
        nose = np.linalg.norm(lm[:, 27] - lm[:, 30], axis=1)            # rigid length scale
        gap = np.linalg.norm(lm[:, 62] - lm[:, 66], axis=1)             # inner-lip opening
        dist = lm[:, :, 1].max(1) - lm[:, 29, 1]
        a = np.stack([np.ones(len(lm)), gap / nose], 1)
        coef, *_ = np.linalg.lstsq(a, dist / nose, rcond=None)
        drop = np.clip(coef[1], 0.0, None) * (gap - np.percentile(gap, 2)).clip(0)
        log(f"neutral jaw: chin travels {coef[1]:.2f} px per px of lip opening; "
            f"lip opening {gap.min():.1f}..{gap.max():.1f} px; box bottom raised by up to {drop.max():.1f} px")
        y_max = y_max - drop
    y1 = np.maximum(0, half_y - (y_max - half_y))
    b = np.stack([x_min, y1, x_max, y_max + extra_margin], 1).astype(np.float64)
    if sigma > 0:
        b = gaussian_filter1d(b, sigma, axis=0, mode="nearest")
    b = np.rint(b).astype(np.int64)
    b[:, 0] = np.clip(b[:, 0], 0, w - 2)
    b[:, 1] = np.clip(b[:, 1], 0, h - 2)
    b[:, 2] = np.clip(b[:, 2], b[:, 0] + 2, w)
    b[:, 3] = np.clip(b[:, 3], b[:, 1] + 2, h)
    return b


@torch.inference_mode()
def encode_latents(frames_rgb, boxes, dev):
    from diffusers import AutoencoderKL
    vae = AutoencoderKL.from_pretrained(os.path.join(ROOT, "models", "sd-vae"), use_safetensors=False).to(dev).eval()
    sf = vae.config.scaling_factor
    out = []
    for i in range(0, len(frames_rgb), 16):
        crops = []
        for f, (x1, y1, x2, y2) in zip(frames_rgb[i:i + 16], boxes[i:i + 16]):
            crops.append(cv2.resize(f[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4))
        x = torch.from_numpy(np.stack(crops)).to(dev).permute(0, 3, 1, 2).float() / 255.0
        masked = x.clone()
        masked[:, :, 128:, :] = 0.0                      # lower half of the face hidden
        x, masked = (x - 0.5) / 0.5, (masked - 0.5) / 0.5
        lat_m = vae.encode(masked).latent_dist.mode() * sf
        lat_r = vae.encode(x).latent_dist.mode() * sf
        out.append(torch.cat([lat_m, lat_r], 1).half().cpu())
    del vae
    torch.cuda.empty_cache()
    return torch.cat(out).numpy()


def blend_masks(frames_rgb, boxes, w, h, feather):
    """MuseTalk's own blend mask (face parsing, 'jaw' mode, blurred), cut to the face box and
    faded to zero at the box edges so no edge of the redrawn rectangle can ever show."""
    sys.path.insert(0, MT)
    cwd = os.getcwd()
    os.chdir(MT)                                           # MuseTalk loads ./models/... relatively
    from musetalk.utils.blending import get_image_prepare_material
    from musetalk.utils.face_parsing import FaceParsing
    # the two face-parsing weight files are old-style pickles (from pytorch.org and the
    # BiSeNet authors); torch 2.6 refuses those unless weights_only is switched off
    orig_load = torch.load
    torch.load = lambda *a, **k: orig_load(*a, **{**k, "weights_only": False})
    try:
        fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
    finally:
        torch.load = orig_load
        os.chdir(cwd)
    alphas = np.zeros((len(frames_rgb), h, w), np.uint8)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    for i, (f, box) in enumerate(zip(frames_rgb, boxes)):
        x1, y1, x2, y2 = [int(v) for v in box]
        mask, (xs, ys, xe, ye) = get_image_prepare_material(
            np.ascontiguousarray(f[:, :, ::-1]), [x1, y1, x2, y2], fp=fp, mode="jaw")
        a = np.zeros((h, w), np.float32)
        ix0, iy0, ix1, iy1 = max(xs, 0), max(ys, 0), min(xe, w), min(ye, h)
        a[iy0:iy1, ix0:ix1] = mask[iy0 - ys:iy1 - ys, ix0 - xs:ix1 - xs].astype(np.float32) / 255.0
        ramp = np.minimum(np.minimum(xx + 0.5 - x1, x2 - xx - 0.5), y2 - yy - 0.5) / float(feather)
        ramp[yy < y1] = 0.0
        a *= np.clip(ramp, 0.0, 1.0)
        alphas[i] = np.rint(a * 255.0).astype(np.uint8)
        if i % 60 == 0:
            log(f"  masks {i}/{len(frames_rgb)}")
    return alphas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="talk")
    ap.add_argument("--video", default=None, help="default: clips/<clip>.mp4")
    ap.add_argument("--size", default=None, help="WxH to resize to (default: keep the clip's size)")
    ap.add_argument("--extra-margin", type=int, default=10, help="pixels added under the chin (MuseTalk 1.5 default)")
    ap.add_argument("--smooth", type=float, default=1.5, help="temporal smoothing of the face box, in frames (0 = off)")
    ap.add_argument("--feather", type=int, default=8, help="width in pixels of the fade at the face box edges")
    ap.add_argument("--neutral-jaw", action="store_true",
                    help="base clip shows her talking: build the face box as if her jaw were closed (see boxes_from_landmarks)")
    args = ap.parse_args()

    video = args.video or os.path.join(ROOT, "clips", f"{args.clip}.mp4")
    out_dir = os.path.join(ROOT, "avatars", args.clip)
    os.makedirs(os.path.join(out_dir, "debug"), exist_ok=True)
    dev = torch.device("cuda")
    size = tuple(int(v) for v in args.size.lower().split("x")) if args.size else None

    log("decoding", video)
    yuv, w, h, info = decode_yuv(video, size)
    n = yuv.shape[0]
    log(f"{n} frames {w}x{h}, source rate {info.get('r_frame_rate')}, used as {FPS} fps")
    rgb = yuv_to_rgb(yuv, w, h, dev)

    log("face landmarks (DWPose)")
    lm, conf = face_landmarks(rgb)
    log(f"landmark confidence min {conf.min():.2f} mean {conf.mean():.2f}")
    boxes = boxes_from_landmarks(lm, w, h, args.extra_margin, args.smooth, args.neutral_jaw)
    bw, bh = boxes[:, 2] - boxes[:, 0], boxes[:, 3] - boxes[:, 1]
    log(f"face box width {bw.min()}..{bw.max()}  height {bh.min()}..{bh.max()}")

    log("VAE latents")
    latents = encode_latents(rgb, boxes, dev)

    log("blend masks (face parsing)")
    alpha = blend_masks(rgb, boxes, w, h, args.feather)

    # one fixed window that contains every frame's face box; only this part of the picture is ever changed
    pad = 4
    wx0 = max(0, (int(boxes[:, 0].min()) - pad) // 2 * 2)
    wy0 = max(0, (int(boxes[:, 1].min()) - pad) // 2 * 2)
    wx1 = min(w, (int(boxes[:, 2].max()) + pad + 1) // 2 * 2)
    wy1 = min(h, (int(boxes[:, 3].max()) + pad + 1) // 2 * 2)
    ww, wh = wx1 - wx0, wy1 - wy0
    outside = alpha.copy()
    outside[:, wy0:wy1, wx0:wx1] = 0
    assert outside.max() == 0, "mask reaches outside the window"
    alpha_win = np.ascontiguousarray(alpha[:, wy0:wy1, wx0:wx1])

    # affine maps (for grid_sample) that place the generated 256x256 face onto its box inside the window
    theta = np.zeros((n, 2, 3), np.float32)
    x1, y1, x2, y2 = [boxes[:, k].astype(np.float64) for k in range(4)]
    theta[:, 0, 0] = ww / (x2 - x1)
    theta[:, 0, 2] = (2.0 * (wx0 - x1) + ww) / (x2 - x1) - 1.0
    theta[:, 1, 1] = wh / (y2 - y1)
    theta[:, 1, 2] = (2.0 * (wy0 - y1) + wh) / (y2 - y1) - 1.0

    log("writing", out_dir)
    yuv.tofile(os.path.join(out_dir, "base.yuv"))
    np.save(os.path.join(out_dir, "latents.npy"), latents)
    np.save(os.path.join(out_dir, "alpha.npy"), alpha_win)
    np.save(os.path.join(out_dir, "theta.npy"), theta)
    np.save(os.path.join(out_dir, "boxes.npy"), boxes)
    np.save(os.path.join(out_dir, "landmarks.npy"), lm.astype(np.float32))
    meta = {
        "name": args.clip, "frames": int(n), "fps": FPS, "width": int(w), "height": int(h),
        "cycle": int(2 * n - 2) if n > 1 else 1,
        "window": [int(wx0), int(wy0), int(wx1), int(wy1)],
        "source": os.path.basename(video), "source_rate": info.get("r_frame_rate"),
        "colour": "bt709 limited range",
        "extra_margin": args.extra_margin, "smooth": args.smooth, "feather": args.feather,
        "neutral_jaw": bool(args.neutral_jaw),
        "prepared_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)

    # pictures to check the result by eye: box, landmarks, mask in green, window in blue
    for i in sorted(set([0, n // 5, 2 * n // 5, 3 * n // 5, 4 * n // 5, n - 1])):
        img = rgb[i][:, :, ::-1].copy()
        a = alpha[i].astype(np.float32)[:, :, None] / 255.0
        img = (img * (1 - 0.5 * a) + np.array([0, 255, 0], np.float32) * 0.5 * a).astype(np.uint8)
        bx = [int(v) for v in boxes[i]]
        cv2.rectangle(img, (bx[0], bx[1]), (bx[2], bx[3]), (0, 0, 255), 1)
        cv2.rectangle(img, (wx0, wy0), (wx1 - 1, wy1 - 1), (255, 0, 0), 1)
        for (px, py) in lm[i]:
            cv2.circle(img, (int(px), int(py)), 1, (0, 255, 255), -1)
        cv2.imwrite(os.path.join(out_dir, "debug", f"frame{i:04d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    log("done:", json.dumps(meta))


if __name__ == "__main__":
    main()
