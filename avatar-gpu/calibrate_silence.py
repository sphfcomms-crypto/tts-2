#!/usr/bin/env python
"""Find the audio conditioning that makes the model draw a closed, relaxed mouth (run once).

MuseTalk draws parted lips with the teeth showing while the voice pauses (that is how people in
its training videos look between phrases). For a calm, closed mouth in every pause the server
swaps in, during silence, the audio features of a moment at which the model does close the lips.
This script finds that moment in a sample of the app's own voice: it renders every 1/25 s of the
sample on a few frames of a prepared clip, measures the open area between the lips with the
face-parsing network, and keeps the features of the most closed moment.

    /workspace/avatar-gpu/venv/bin/python calibrate_silence.py [--wav samples/long.wav] [--clip talk]

Output: /workspace/avatar-gpu/models/closed_mouth.npy  (50 x 384 values, read by server.py)
Without that file the server leaves pauses as the model draws them.
"""
import argparse
import os
import sys

import numpy as np
import torch
import torch.nn.functional as F

ROOT = os.environ.get("AVATAR_ROOT", "/workspace/avatar-gpu")
MT = os.path.join(ROOT, "src", "MuseTalk")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["AVATAR_NO_CLOSED_MOUTH"] = "1"          # measure the model itself, not an earlier calibration
import server  # noqa: E402


def load_parser():
    sys.path.insert(0, MT)
    cwd = os.getcwd()
    os.chdir(MT)
    from musetalk.utils.face_parsing import FaceParsing
    orig = torch.load
    torch.load = lambda *a, **k: orig(*a, **{**k, "weights_only": False})
    try:
        return FaceParsing().net
    finally:
        torch.load = orig
        os.chdir(cwd)


@torch.inference_mode()
def mouth_open_pixels(e, net, clip, frame, feats):
    mean = torch.tensor([0.485, 0.456, 0.406], device=e.dev).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], device=e.dev).view(1, 3, 1, 1)
    out = []
    for i in range(0, feats.shape[0], 32):
        f = feats[i:i + 32]
        lat = clip.latents[frame:frame + 1].expand(f.shape[0], -1, -1, -1)
        pred = e.unet(lat, e.t0, encoder_hidden_states=f + e.pe, return_dict=False)[0]
        img = (e.vae.decode(pred / e.sf, return_dict=False)[0].float() * 0.5 + 0.5).clamp(0, 1)
        img = F.interpolate(img, size=(512, 512), mode="bilinear", align_corners=False)
        parse = net((img - mean) / std)[0].argmax(1)
        out.append((parse == 11).flatten(1).sum(1))          # class 11 = inside of the mouth
    return torch.cat(out).float().cpu().numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", default=os.path.join(ROOT, "samples", "long.wav"))
    ap.add_argument("--clip", default="talk")
    args = ap.parse_args()

    e = server.Engine(warm=False)
    clip = e.clips[args.clip]
    net = load_parser()
    with open(args.wav, "rb") as f:
        x, rate = server.read_audio(f.read())
    n = (len(x) * server.FPS + rate - 1) // rate
    feats = e.audio_features(server.resample(x, rate, 16000), 0, n)
    frames = [0, clip.n // 3, 2 * clip.n // 3]
    score = np.mean([mouth_open_pixels(e, net, clip, fr, feats) for fr in frames], 0)
    best = int(np.argmin(score))
    print(f"{n} moments tested on frames {frames} of '{args.clip}'")
    print(f"open area between the lips (pixels): median {np.median(score):.0f}, max {score.max():.0f}, "
          f"most closed moment {best / server.FPS:.2f} s with {score[best]:.0f}")
    if score[best] > 0.05 * np.median(score) + 5:
        print("no moment with closed lips in this sample: nothing written")
        sys.exit(1)
    out = os.path.join(ROOT, "models", "closed_mouth.npy")
    np.save(out, feats[best].float().cpu().numpy().astype(np.float16))
    print("wrote", out)


if __name__ == "__main__":
    main()
