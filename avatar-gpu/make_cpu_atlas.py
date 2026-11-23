"""Bake live MuseTalk's anatomically attached Urdu mouth poses for its CPU renderer.

The GPU reads the exact prepared camera and render configuration used online.
Each atlas class is conditioned on a real, time-aligned phone in a recording.
The CPU needs only the resulting small, source-frame-specific YUV420 patches.
"""

import argparse
import hashlib
import fcntl
import json
from pathlib import Path
import time

import cv2
import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch

PHONES = ["REST", "MBP", "FV", "A", "E", "I", "O", "U", "S", "neutral"]
LIP_IDS = [61, 291, 0, 17, 13, 14, 82, 87, 312, 317, 78, 308]


def wait_for_gpu(hold):
    while hold is not None and hold.exists():
        time.sleep(0.3)


def sha256(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


class FaceMesh:
    """Predict mouth geometry on the actual final composed face for each pose."""

    def __init__(self, path):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self.net = ort.InferenceSession(
            str(path), sess_options=opts, providers=["CPUExecutionProvider"]
        )

    def __call__(self, clip, frame, window, face_box):
        image = clip.compose(frame, window)
        # Crop all three original YUV planes before colour conversion.
        x0, y0, x1, y1 = face_box
        side = int(np.ceil(max(x1 - x0, y1 - y0) * 1.29 / 2)) * 2
        x = max(0, min(clip.w - side, int((x0 + x1 - side) / 4) * 2))
        y = max(0, min(clip.h - side, int((y0 + y1 - side) / 4) * 2))
        crop = crop_yuv(image.reshape(1, -1), clip.w, clip.h, (x, y, side, side))[0]
        rgb = cv2.cvtColor(crop.reshape(side * 3 // 2, side), cv2.COLOR_YUV2RGB_I420)
        tensor = cv2.resize(rgb, (256, 256)).astype(np.float32)[None] / 255
        pts = self.net.run(["Identity"], {"input": tensor})[0].reshape(-1, 3)[:, :2]
        pts = pts * (side / 256.0) + np.array([x, y])
        q = pts[LIP_IDS].astype(np.float32)
        axis = q[1] - q[0]
        normal = np.array([-axis[1], axis[0]]) / max(np.linalg.norm(axis), 1)
        face_width = np.linalg.norm(pts[454] - pts[234])
        gap = np.mean([(q[b] - q[a]) @ normal for a, b in [(4, 5), (6, 7), (8, 9)]]) / face_width
        mouth_width = np.linalg.norm(axis) / face_width
        return q, (float(gap), float(mouth_width))


def crop_yuv(packed, width, height, roi):
    """Crop without resampling luma or chroma in any plane."""
    x, y, w, h = roi
    ybytes = width * height
    uvbytes = ybytes // 4
    n = len(packed)
    return np.concatenate(
        [
            packed[:, :ybytes].reshape(n, height, width)[:, y : y + h, x : x + w].reshape(n, -1),
            packed[:, ybytes : ybytes + uvbytes]
            .reshape(n, height // 2, width // 2)[:, y // 2 : (y + h) // 2, x // 2 : (x + w) // 2]
            .reshape(n, -1),
            packed[:, ybytes + uvbytes :]
            .reshape(n, height // 2, width // 2)[:, y // 2 : (y + h) // 2, x // 2 : (x + w) // 2]
            .reshape(n, -1),
        ],
        axis=1,
    )


def exact_roi(clip):
    # Pixels outside the union of all the actual jaw masks equal the canonical base.
    mask = np.any(clip.alpha.cpu().numpy() != 0, axis=0)
    yy, xx = np.where(mask)
    x0 = int(xx.min()) // 2 * 2
    y0 = int(yy.min()) // 2 * 2
    x1 = (int(xx.max()) // 2 + 1) * 2
    y1 = (int(yy.max()) // 2 + 1) * 2
    return (x0, y0, x1 - x0, y1 - y0)


def recordings(paths, server):
    out = {}
    for name, path in paths.items():
        if path.suffix == ".pcm":
            data = np.fromfile(path, dtype="<i2").astype("f4") / 32768
            rate = 24000
        else:
            data, rate = sf.read(path, dtype="float32")
        if data.ndim != 1:
            raise ValueError(f"Expected mono voice recording: {path}")
        out[name] = server.resample(data, rate, 16000)
    return out


def get_condition(eng, clip, source, point, phone):
    """Apply the exact live Whisper offset, acoustic rest and phone recognizer."""
    if phone == "REST":
        if eng.closed is None:
            raise ValueError("No calibrated production REST feature")
        return eng.closed[0], 1.0
    # The target is at the midpoint of the middle 40ms frame, with original
    # pre- and post-phonetic context in both the lead and the voiced window.
    context = 2560
    center = 15
    count = 31
    start = round(point["time"] * 16000) - context - (center * 640 + 320)
    length = 2 * context + count * 640
    padded = np.pad(source, (max(0, -start), max(0, start + length - len(source))))
    start = max(0, start)
    wave = padded[start : start + length]
    job = eng.make_job(
        clip, 0, wave, 16000, 160, 160, False, lambda _: None, time.perf_counter(), warm=True
    )
    cond = eng.audio_features(job.wav16, job.lead_steps, job.n_frames)[center]
    gate = eng.mouth_gate(job)
    rest = 0.0 if gate is None else float(gate[center])
    if rest and eng.closed is not None:
        cond = cond + (eng.closed[0] - cond) * rest
    return cond, rest


def selection_cost(phone, gap, width):
    # Only ranks exemplars of the SAME verified acoustic class. No pixels are altered.
    if phone == "REST" or phone == "MBP":
        return abs(gap)
    if phone == "A":
        return -gap
    if phone == "I":
        return abs(gap - 0.043) - 0.42 * width + 3 * max(0, 0.028 - gap)
    if phone == "E":
        return abs(gap - 0.067) - 0.35 * width + 3 * max(0, 0.036 - gap)
    if phone == "U":
        return abs(gap - 0.07) + 0.45 * width
    if phone == "O":
        return abs(gap - 0.115) + 0.30 * width + 2 * max(0, 0.052 - gap)
    if phone == "FV":
        return abs(gap - 0.033)
    if phone == "S":
        return abs(gap - 0.040) - 0.8 * width
    return abs(gap - 0.053)


def choose(eng, clip, mesh, boxes, candidates, recorded, hold):
    output = []
    rests = []
    chosen = {}
    frames = np.unique(np.rint(np.array([0.15, 0.37, 0.68]) * clip.n).astype(int)).tolist()
    for phone in PHONES:
        trials = []
        for point in candidates[phone]:
            wait_for_gpu(hold)
            cond, rest = get_condition(eng, clip, recorded[point["audio"]], point, phone)
            ft = cond.expand(len(frames), -1, -1)
            rr = torch.full((len(frames),), rest, device=eng.dev)
            pictures = eng.render(clip, frames, ft, {}, rr)
            metrics = [mesh(clip, i, img, boxes[i])[1] for i, img in zip(frames, pictures)]
            med_gap, med_width = np.median(metrics, axis=0)
            trials.append(
                (
                    selection_cost(phone, med_gap, med_width),
                    cond,
                    rest,
                    {
                        **point,
                        "screen_gap": round(float(med_gap), 4),
                        "screen_width": round(float(med_width), 4),
                        "live_rest_weight": round(rest, 3),
                    },
                )
            )
        best = min(trials, key=lambda row: row[0])
        output.append(best[1])
        rests.append(best[2])
        chosen[phone] = {"selected": best[3], "candidates": [v[3] for v in trials]}
    return torch.stack(output), torch.tensor(rests, device=eng.dev), chosen


def bake(
    eng, clip, prepared, name, output, features, rests, mesh, chosen, inputs, batch, sleep, hold
):
    target = output / name
    if (target / "meta.json").exists():
        old = json.loads((target / "meta.json").read_text())
        if (
            old["source_sha256"] != clip.meta["source_sha256"]
            or old["input_audio_sha256"] != inputs
            or old["conditioning"] != chosen
            or old["phones"] != PHONES
        ):
            raise ValueError(f"Atlas inputs changed for {name}; choose a new output directory")
        return
    temporary = output / ("." + name + ".building")
    temporary.mkdir(parents=True, exist_ok=True)
    if sha256(prepared.parent / (name + ".mp4")) != clip.meta["source_sha256"]:
        raise ValueError(f"Base frame source for {name} no longer matches prepared tensors")
    crop = exact_roi(clip)
    x, y, w, h = crop
    arr = np.lib.format.open_memmap(
        temporary / "patches.npy",
        mode="w+",
        dtype=np.uint8,
        shape=(clip.n, len(PHONES), w * h * 3 // 2),
    )
    lips = np.lib.format.open_memmap(
        temporary / "lips.npy",
        mode="w+",
        dtype=np.float32,
        shape=(clip.n, len(PHONES), len(LIP_IDS), 2),
    )
    boxes = np.load(prepared / "boxes.npy")
    # Keep the full final composed jaw pixels. Each output row was predicted at its own
    # source frame, with that frame's pose, lighting, blend mask and YUV background.
    for i in range(clip.n):
        for k in range(0, len(PHONES), batch):
            wait_for_gpu(hold)
            kj = min(k + batch, len(PHONES))
            rows = eng.render(clip, [i] * (kj - k), features[k:kj], {}, rests[k:kj])
            arr[i, k:kj] = crop_yuv(rows, clip.ww, clip.wh, crop)
            for j, pixels in enumerate(rows):
                lips[i, k + j] = mesh(clip, i, pixels, boxes[i])[0]
            if sleep:
                time.sleep(sleep)
    arr.flush()
    lips.flush()
    meta = {
        "name": name,
        "frames": clip.n,
        "width": clip.w,
        "height": clip.h,
        "fps": 25,
        "roi": [clip.wx0 + x, clip.wy0 + y, w, h],
        "phones": PHONES,
        "lip_landmarks": LIP_IDS,
        "source_sha256": clip.meta["source_sha256"],
        "color": "bt709 limited range",
        "patches_sha256": sha256(temporary / "patches.npy"),
        "lips_sha256": sha256(temporary / "lips.npy"),
        "conditioning": chosen,
        "input_audio_sha256": inputs,
    }
    (temporary / "meta.json").write_text(json.dumps(meta, indent=2))
    temporary.rename(target)
    print(
        f"READY {name} frames={clip.n} roi={meta['roi']} bytes={arr.nbytes} sha256={meta['patches_sha256']}",
        flush=True,
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--staged", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--exemplars", type=Path, required=True)
    ap.add_argument("--master", type=Path, required=True)
    ap.add_argument("--direct-speaker", type=Path)
    ap.add_argument("--mesh", type=Path, required=True)
    ap.add_argument("--batch", type=int, default=5)
    ap.add_argument(
        "--hold-file", type=Path, help="Pause between GPU batches while this file exists"
    )
    ap.add_argument("--hold-after-screen", action="store_true")
    ap.add_argument("--yield-ms", type=float, default=0)
    ap.add_argument("names", nargs="+")
    args = ap.parse_args()
    if not 1 <= args.batch <= 12:
        raise ValueError("batch must be 1 through 12")
    import server

    server.GRAPH_SIZES = tuple(s for s in server.GRAPH_SIZES if s <= max(5, args.batch))
    cv2.setNumThreads(1)
    args.output.mkdir(parents=True, exist_ok=True)
    # Do not let concurrent offline jobs overwrite a shared partially baked atlas.
    lock = (args.output / ".bake.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with torch.inference_mode():
        eng = server.Engine(warm=False)
        mesh = FaceMesh(args.mesh)
        paths = {"master": args.master}
        if args.direct_speaker:
            paths["direct_speaker"] = args.direct_speaker
        voices = recordings(paths, server)
        source_sha = {n: sha256(v) for n, v in paths.items()}
        exemplars = json.loads(args.exemplars.read_text())
        expected_pcm = exemplars.get("master_pcm_s16le_sha256")
        if expected_pcm:
            pcm, rate = sf.read(args.master, dtype="int16")
            actual_pcm = hashlib.sha256(pcm.astype("<i2", copy=False).tobytes()).hexdigest()
            if actual_pcm != expected_pcm or rate != exemplars["sample_rate"]:
                raise ValueError("The supplied master PCM does not match the phonetic timing sheet")
        points = exemplars["classes"]
        if set(PHONES) - points.keys():
            raise ValueError("Missing acoustic classes")
        first = args.names[0]
        clip = server.Clip(str(args.staged / first / "prepared"), eng.dev)
        ft, rests, chosen = choose(
            eng,
            clip,
            mesh,
            np.load(args.staged / first / "prepared/boxes.npy"),
            points,
            voices,
            args.hold_file,
        )
        (args.output / "screen.json").write_text(json.dumps(chosen, indent=2))
        print("CONDITIONS", json.dumps({k: v["selected"] for k, v in chosen.items()}), flush=True)
        if args.hold_after_screen and args.hold_file is not None:
            args.hold_file.touch()
        for name in args.names:
            prepared = args.staged / name / "prepared"
            clip = server.Clip(str(prepared), eng.dev)
            bake(
                eng,
                clip,
                prepared,
                name,
                args.output,
                ft,
                rests,
                mesh,
                chosen,
                source_sha,
                args.batch,
                args.yield_ms / 1000,
                args.hold_file,
            )


if __name__ == "__main__":
    main()
