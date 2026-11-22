#!/usr/bin/env python
"""Makes the room behind her one and the same picture in every clip, with nothing in it moving.

    python lock_background.py OUT_DIR name [name ...]

For each unit it takes closed/<name>.mp4 when there is one (the GPU box's closed-mouth drawing of
the clip, already 960x720) and src/<name>.mp4 otherwise, and writes OUT_DIR/<name>.mp4, the file
the browser plays (960x720, 25 fps, H.264, no B-frames, a keyframe every 25 frames, no sound).

Every generated clip has the same room, but not the same pixels: the colour drifts by a level or
two from clip to clip and the picture carries grain that moves. Here one still picture of the room
(the "plate": the middle value of every pixel over the clip listen_still) is put in place of
everything outside the zone she moves in, in every frame of every clip. Inside the zone the clip
itself shows, shifted in colour, frame by frame, so that its room matches the plate; the edge of
the zone is a soft blend between the two. The zone is fixed: a region round her and the middle of
the chair, widened to wherever she reaches in any clip (ZONE_FROM lists the clips looked at).

Frame k of the output is frame k of the input, so the lip sync's frames still match.

It also writes OUT_DIR/../room.webp: the plate with her zone cut out of it (transparent), which the
page lays over the video. Video coding leaves a level of flicker even in a still picture; under
that overlay the room is not video at all.
"""
import glob
import os
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 960, 720
KBPS = 1600
GRAPH = (f"setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,"
         f"scale={W}:{H}:flags=lanczos+accurate_rnd")


def source(name):
    closed = os.path.join(HERE, "closed", name + ".mp4")
    return closed if os.path.exists(closed) else os.path.join(HERE, "src", name + ".mp4")


def read(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", GRAPH, "-pix_fmt", "rgb24",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)


def write(frames, path):
    common = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", "25", "-i", "-",
              "-an", "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
              "-b:v", f"{KBPS}k", "-maxrate", f"{KBPS * 3 // 2}k", "-bufsize", f"{KBPS * 2}k",
              "-g", "25", "-keyint_min", "25", "-sc_threshold", "0", "-bf", "0",
              "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
    log = path + ".log"
    data = frames.tobytes()
    subprocess.run(["ffmpeg", "-v", "error", "-y", *common, "-pass", "1", "-passlogfile", log, "-f", "null", "-"],
                   input=data, check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", *common, "-pass", "2", "-passlogfile", log,
                    "-movflags", "+faststart", path], input=data, check=True)
    for leftover in glob.glob(log + "*"):
        os.remove(leftover)


def main():
    out_dir, names = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)
    plate = np.median(read(os.path.join(HERE, "src", "listen_still.mp4")).astype(np.float32), axis=0)

    # The zone she moves in. To begin with: her head, body and lap, and the chair round them.
    zone = np.zeros((H, W), np.uint8)
    cv2.ellipse(zone, (480, 190), (150, 175), 0, 0, 360, 255, -1)        # head, hair, shoulders
    cv2.rectangle(zone, (250, 300), (715, H), 255, -1)                    # body, arms, lap
    # ... widened to wherever any clip differs clearly from the plate (a hand out to the side).
    every = sorted(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(HERE, "src", "*.mp4")))
    reach = np.zeros((H, W), bool)
    for name in every:
        frames = read(source(name))[::3].astype(np.float32)
        diff = np.abs(frames - plate).max(axis=3)
        reach |= (cv2.GaussianBlur(diff.max(axis=0), (0, 0), 2) > 22)
    reach = cv2.morphologyEx(reach.astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    zone = cv2.bitwise_or(zone, cv2.dilate(reach, np.ones((31, 31), np.uint8)))
    alpha = cv2.GaussianBlur(zone.astype(np.float32) / 255, (0, 0), 9)[..., None]
    outside = alpha[..., 0] < 0.02          # the room for certain: used to measure the colour drift
    print(f"zone: {zone.mean() / 255:.0%} of the picture is her zone, the rest is the still room")
    cv2.imwrite(os.path.join(out_dir, "_plate.jpg"), cv2.cvtColor(plate.astype(np.uint8), cv2.COLOR_RGB2BGR))
    cv2.imwrite(os.path.join(out_dir, "_zone.jpg"), (alpha[..., 0] * 255).astype(np.uint8))
    # The room as one picture, clear where her zone is: the page lays it over the video, so that
    # outside her zone the very same pixels show whatever the video underneath is doing.
    room = np.dstack([cv2.cvtColor(plate.astype(np.uint8), cv2.COLOR_RGB2BGR),
                      ((1 - alpha[..., 0]) * 255 + 0.5).astype(np.uint8)])
    cv2.imwrite(os.path.join(out_dir, "..", "room.webp"), room, [cv2.IMWRITE_WEBP_QUALITY, 92])

    for name in names:
        frames = read(source(name)).astype(np.float32)
        out = np.empty(frames.shape, np.uint8)
        drift = []
        for i, frame in enumerate(frames):
            shift = np.median((frame - plate)[outside], axis=0)      # this frame's colour drift
            drift.append(np.abs(shift).max())
            out[i] = np.clip(alpha * (frame - shift) + (1 - alpha) * plate + 0.5, 0, 255).astype(np.uint8)
        write(out, os.path.join(out_dir, name + ".mp4"))
        print(f"{name}: {len(frames)} frames from {os.path.relpath(source(name), HERE)}; "
              f"colour drift taken out: up to {max(drift):.1f} levels")


if __name__ == "__main__":
    main()
