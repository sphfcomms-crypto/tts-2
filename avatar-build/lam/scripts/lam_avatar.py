#!/usr/bin/env python
"""Build one LAM Gaussian-head avatar from one image, without the Gradio page.

This is app_lam.py's launch_gradio_app() + demo_lam().core_fn() written as a plain script:
the same calls, in the same order, with the same arguments. core_fn is a closure inside the
Gradio UI builder, so it cannot be imported; everything it calls is called here directly.

Differences from the app, all to fit a PC with 7 GB of RAM (the exported files are byte-identical
to an app-style run, the preview frames differ by at most 1/255):
  * the face-tracking models are freed before the LAM model is loaded;
  * the LAM network is built without weights and the checkpoint is read straight onto the GPU,
    so the 2.4 GB of weights never sit in RAM (--plain_load does it the app's way);
  * DINOv2 is built without downloading Meta's pretrained file (the LAM checkpoint
    overwrites every encoder weight anyway; the script checks that none is missing);
  * the preview is limited to --max_frames frames of the driving motion, and has no audio track;
  * the export fails loudly if Blender did not produce skin.glb / vertex_order.json
    (the app silently ships an incomplete ZIP in that case).

usage: lam_avatar.py <image> <out.zip> [--out_dir DIR] [--motion NAME] [--max_frames N]
"""
import argparse
import gc
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HOME = Path.home()
LAM_HOME = Path(os.environ.get("LAM_HOME", HOME / "lam"))


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image", help="input picture (head and shoulders, facing the camera)")
    p.add_argument("out_zip", help="where to write the avatar ZIP for the WebGL renderer")
    p.add_argument("--out_dir", default=None, help="folder for the preview video, frames and cropped input")
    p.add_argument("--name", default=None, help="folder name inside the ZIP (default: the ZIP's file name)")
    p.add_argument("--motion", default="Look_In_My_Eyes",
                   help="driving motion for the preview: a folder name in assets/sample_motion/export")
    p.add_argument("--max_frames", type=int, default=300, help="preview length limit, in frames (30 fps)")
    p.add_argument("--blender_path", default=str(LAM_HOME / "blender/blender-4.0.2-linux-x64/blender"))
    p.add_argument("--repo", default=str(LAM_HOME / "LAM"))
    p.add_argument("--work", default=str(LAM_HOME / "work"), help="scratch folder (emptied at start)")
    p.add_argument("--no_zip", action="store_true", help="only render the preview, skip the ZIP export")
    p.add_argument("--plain_load", action="store_true",
                   help="build the model in RAM exactly like app_lam.py (needs about 2.4 GB more RAM)")
    return p.parse_args()


ARGS = parse_args()
ARGS.image = os.path.abspath(ARGS.image)
ARGS.out_zip = os.path.abspath(ARGS.out_zip)
if ARGS.out_dir:
    ARGS.out_dir = os.path.abspath(ARGS.out_dir)
ARGS.blender_path = os.path.abspath(os.path.expanduser(ARGS.blender_path))

# LAM uses paths relative to its repository root everywhere, and its tracker re-parses sys.argv.
os.chdir(ARGS.repo)
os.environ["PWD"] = ARGS.repo  # Blender resolves "--python tools/x.py" against $PWD, not the real cwd
sys.path.insert(0, ARGS.repo)
sys.argv = [sys.argv[0]]

# Same environment the app sets, plus the two torch >= 2.6 switches explained in activate.sh.
os.environ.update({
    "APP_ENABLED": "1",
    "APP_MODEL_NAME": "./model_zoo/lam_models/releases/lam/lam-20k/step_045500/",
    "APP_INFER": "./configs/inference/lam-20k-8gpu.yaml",
    "APP_TYPE": "infer.lam",
    "NUMBA_THREADING_LAYER": "omp",
})
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from omegaconf import OmegaConf  # noqa: E402
from PIL import Image  # noqa: E402


# ----------------------------------------------------------------------------- measuring
class Meter:
    """Tracks wall time per stage, this process's RAM, and GPU memory in use on the whole card."""

    def __init__(self):
        self.t0 = time.time()
        self.stages = []
        self.gpu_peak_mib = 0
        self.gpu_start_mib = self._gpu_used()
        self.ram_avail_min_mib = 1 << 30
        self._stop = False
        self._thr = threading.Thread(target=self._poll, daemon=True)
        self._thr.start()

    @staticmethod
    def _gpu_used():
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=10).stdout
            return int(out.strip().splitlines()[0])
        except Exception:
            return -1

    @staticmethod
    def _meminfo(key):
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith(key + ":"):
                    return int(line.split()[1]) // 1024
        return -1

    @staticmethod
    def _status(key):
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith(key + ":"):
                    return int(line.split()[1]) // 1024
        return -1

    def _poll(self):
        while not self._stop:
            self.gpu_peak_mib = max(self.gpu_peak_mib, self._gpu_used())
            self.ram_avail_min_mib = min(self.ram_avail_min_mib, self._meminfo("MemAvailable"))
            time.sleep(0.5)

    def stage(self, name, t_start):
        rec = {
            "stage": name,
            "seconds": round(time.time() - t_start, 1),
            "ram_rss_mib": self._status("VmRSS"),
            "ram_peak_mib": self._status("VmHWM"),
            "swap_mib": self._status("VmSwap"),
            "torch_gpu_peak_mib": int(torch.cuda.max_memory_allocated() // 2**20),
            "card_gpu_used_mib": self._gpu_used(),
        }
        self.stages.append(rec)
        print(f"[stage] {json.dumps(rec)}", flush=True)

    def summary(self):
        self._stop = True
        return {
            "total_seconds": round(time.time() - self.t0, 1),
            "ram_peak_mib": self._status("VmHWM"),
            "system_ram_total_mib": self._meminfo("MemTotal"),
            "system_ram_available_min_mib": self.ram_avail_min_mib,
            "gpu_used_before_start_mib": self.gpu_start_mib,
            "gpu_card_peak_mib": self.gpu_peak_mib,
            "gpu_torch_peak_mib": int(torch.cuda.max_memory_allocated() // 2**20),
            "stages": self.stages,
        }


# ----------------------------------------------------------------------------- app_lam.py pieces
def parse_configs():
    """app_lam.parse_configs() with the values launch_gradio_app() feeds it."""
    infer = os.environ["APP_INFER"]
    model_name = os.environ["APP_MODEL_NAME"]
    cfg = OmegaConf.create()
    cfg.blender_path = ARGS.blender_path
    cfg_train = OmegaConf.load(infer)
    cfg.source_size = cfg_train.dataset.source_image_res
    try:
        cfg.src_head_size = cfg_train.dataset.src_head_size
    except Exception:
        cfg.src_head_size = 112
    cfg.render_size = cfg_train.dataset.render_image.high
    cfg.merge_with(OmegaConf.load(infer))
    cfg.motion_video_read_fps = 30
    cfg.model_name = model_name
    return cfg


def build_model(cfg):
    """app_lam._build_model(), but the checkpoint goes file -> GPU (never a second copy in RAM)."""
    from safetensors.torch import load_file

    # LAM's DINOv2 wrapper downloads Meta's pretrained ViT-L (1.1 GB) just to have it overwritten
    # by the LAM checkpoint a moment later. Build the bare architecture instead.
    from lam.models.encoders import dinov2_fusion_wrapper as dfw
    orig_build = dfw.Dinov2FusionWrapper._build_dinov2
    dfw.Dinov2FusionWrapper._build_dinov2 = staticmethod(
        lambda model_name, modulation_dim=None, pretrained=True: orig_build(
            model_name, modulation_dim=modulation_dim, pretrained=False))

    from lam.models import ModelLAM
    resume = os.path.join(cfg.model_name, "model.safetensors")
    print("loading pretrained weight from:", resume, flush=True)
    ckpt = load_file(resume, device="cuda")

    model = None
    if not ARGS.plain_load:
        try:
            # Build the network with weightless ("meta") parameters, then hang each checkpoint
            # tensor, already on the GPU, onto it: the 2.4 GB of weights never exist in RAM.
            from accelerate import init_empty_weights
            from accelerate.utils import set_module_tensor_to_device
            with init_empty_weights(include_buffers=False):
                model = ModelLAM(**cfg.model)
            state_dict = model.state_dict()
            loaded = set()
            for k, v in ckpt.items():
                if k in state_dict:
                    if state_dict[k].shape == v.shape:
                        set_module_tensor_to_device(model, k, "cuda", value=v)
                        loaded.add(k)
                    else:
                        print(f"WARN] mismatching shape for param {k}: ckpt {v.shape} != model {state_dict[k].shape}, ignored.")
                else:
                    print(f"WARN] unexpected param {k}: {v.shape}")
            still_meta = [k for k, p in model.named_parameters() if p.is_meta]
            assert not still_meta, f"parameters without weights: {still_meta[:8]}"
            model.to("cuda")
            model.eval()
            print("model built weightless and filled from the checkpoint on the GPU")
        except Exception as e:
            print(f"weightless construction failed ({type(e).__name__}: {e}); building in RAM like the app")
            model = None
            gc.collect()

    if model is None:  # exactly app_lam._build_model()
        model = ModelLAM(**cfg.model)
        model.to("cuda")
        model.eval()
        state_dict = model.state_dict()
        loaded = set()
        for k, v in ckpt.items():
            if k in state_dict:
                if state_dict[k].shape == v.shape:
                    state_dict[k].copy_(v)
                    loaded.add(k)
                else:
                    print(f"WARN] mismatching shape for param {k}: ckpt {v.shape} != model {state_dict[k].shape}, ignored.")
            else:
                print(f"WARN] unexpected param {k}: {v.shape}")
    state_dict = model.state_dict()
    missing = [k for k in state_dict if k not in loaded]
    missing_encoder = [k for k in missing if k.startswith("encoder.")]
    print(f"checkpoint tensors: {len(ckpt)}, model tensors: {len(state_dict)}, loaded: {len(loaded)}, "
          f"not in checkpoint: {len(missing)} (encoder: {len(missing_encoder)})")
    if missing:
        print("  not in checkpoint:", missing[:12], "..." if len(missing) > 12 else "")
    assert not missing_encoder, "the checkpoint does not cover the image encoder; pretrained DINOv2 would be needed"
    del ckpt
    torch.cuda.empty_cache()
    return model


def write_video(frames, path, fps):
    import imageio
    with imageio.get_writer(path, fps=fps, codec="libx264", quality=8, macro_block_size=None) as w:
        for f in frames:
            w.append_data(f)


def contact_sheet(frames, path, n=8, cols=4, cell=512):
    idx = np.linspace(0, len(frames) - 1, n).round().astype(int)
    rows = (n + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), "white")
    for j, i in enumerate(idx):
        im = Image.fromarray(frames[i]).resize((cell, cell), Image.LANCZOS)
        sheet.paste(im, ((j % cols) * cell, (j // cols) * cell))
    sheet.save(path, quality=92)
    return [int(i) for i in idx]


# ----------------------------------------------------------------------------- main
def main():
    meter = Meter()
    cfg = parse_configs()

    name = ARGS.name or Path(ARGS.out_zip).stem
    work = Path(ARGS.work) / name
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    out_dir = Path(ARGS.out_dir) if ARGS.out_dir else work / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- core_fn: save the upload as raw.png -----------------------------------------------
    image_raw = str(work / "raw.png")
    with Image.open(ARGS.image).convert("RGB") as img:
        img.save(image_raw)
        print("input image:", ARGS.image, img.size)

    motion_dir = os.path.join("./assets/sample_motion/export", ARGS.motion, "flame_param")
    assert os.path.isdir(motion_dir), f"no such motion: {motion_dir}"

    # --- launch_gradio_app: tracker -------------------------------------------------------
    t = time.time()
    from tools.flame_tracking_single_image import FlameTrackingSingleImage
    flametracking = FlameTrackingSingleImage(
        output_dir=str(work / "tracking"),
        alignment_model_path="./model_zoo/flame_tracking_models/68_keypoints_model.pkl",
        vgghead_model_path="./model_zoo/flame_tracking_models/vgghead/vgg_heads_l.trcd",
        human_matting_path="./model_zoo/flame_tracking_models/matting/stylematte_synth.pt",
        facebox_model_path="./model_zoo/flame_tracking_models/FaceBoxesV2.pth",
        detect_iris_landmarks=False)
    meter.stage("load tracking models", t)

    # --- core_fn: segmentation + FLAME parameter estimation --------------------------------
    t = time.time()
    return_code = flametracking.preprocess(image_raw)
    assert return_code == 0, "flametracking preprocess failed!"
    return_code = flametracking.optimize()
    assert return_code == 0, "flametracking optimize failed!"
    return_code, output_dir = flametracking.export()
    assert return_code == 0, "flametracking export failed!"
    meter.stage("flame tracking (crop, matting, landmarks, fit)", t)

    image_path = os.path.join(output_dir, "images/00000_00.png")
    mask_path = os.path.join(output_dir, "fg_masks/00000_00.png")
    print("image_path:", image_path, "\nmask_path:", mask_path)

    # free the tracking models before the big model comes in
    del flametracking
    gc.collect()
    torch.cuda.empty_cache()

    # --- core_fn: reference image + motion ------------------------------------------------
    from lam.runners.infer.head_utils import prepare_motion_seqs, preprocess_image

    aspect_standard = 1.0 / 1.0
    source_size = cfg.source_size
    render_size = cfg.render_size
    render_fps = 30
    image, _, _, shape_param = preprocess_image(
        image_path, mask_path=mask_path, intr=None, pad_ratio=0, bg_color=1.,
        max_tgt_size=None, aspect_standard=aspect_standard, enlarge_ratio=[1.0, 1.0],
        render_tgt_size=source_size, multiply=14, need_mask=True, get_shape_param=True)

    vis_ref_img = (image[0].permute(1, 2, 0).cpu().detach().numpy() * 255).astype(np.uint8)
    Image.fromarray(vis_ref_img).save(out_dir / "input-cropped.png")
    shutil.copy(image_path, out_dir / "input-tracked-1024.png")
    shutil.copy(mask_path, out_dir / "input-mask-1024.png")

    src = image_path.split("/")[-3]
    driven = motion_dir.split("/")[-2]
    motion_seq = prepare_motion_seqs(
        motion_dir, None, save_root=str(work), fps=render_fps,
        bg_color=1., aspect_standard=aspect_standard, enlarge_ratio=[1.0, 1, 0],
        render_image_res=render_size, multiply=16,
        need_mask=cfg.get("motion_img_need_mask", False), vis_motion=cfg.get("vis_motion", False),
        shape_param=shape_param, test_sample=False, cross_id=False, src_driven=[src, driven])

    n_all = motion_seq["render_c2ws"].shape[1]
    n = min(n_all, ARGS.max_frames)
    if n < n_all:
        print(f"preview limited to the first {n} of {n_all} motion frames")
        for k in ("render_c2ws", "render_intrs", "render_bg_colors"):
            motion_seq[k] = motion_seq[k][:, :n]
        for k, v in list(motion_seq["flame_params"].items()):
            if torch.is_tensor(v) and v.dim() >= 2 and v.shape[1] == n_all and k != "betas":
                motion_seq["flame_params"][k] = v[:, :n]

    # --- launch_gradio_app: the LAM model --------------------------------------------------
    t = time.time()
    lam = build_model(cfg)
    meter.stage("load LAM-20K", t)

    # --- core_fn: inference -----------------------------------------------------------------
    t = time.time()
    motion_seq["flame_params"]["betas"] = shape_param.unsqueeze(0)
    device, dtype = "cuda", torch.float32
    print("start to inference...................", flush=True)
    with torch.no_grad():
        res = lam.infer_single_view(
            image.unsqueeze(0).to(device, dtype), None, None,
            render_c2ws=motion_seq["render_c2ws"].to(device),
            render_intrs=motion_seq["render_intrs"].to(device),
            render_bg_colors=motion_seq["render_bg_colors"].to(device),
            flame_params={k: v.to(device) for k, v in motion_seq["flame_params"].items()})
    torch.cuda.synchronize()
    n_gs = int(res["cano_gs_lst"][0].xyz.shape[0])
    meter.stage(f"LAM inference + {n} rendered frames ({n_gs} gaussians)", t)

    # --- core_fn: preview video (white background, same compositing as the app) --------------
    t = time.time()
    frames = []
    with torch.no_grad():
        for i in range(0, n, 16):
            rgb = res["comp_rgb"][i:i + 16]
            mask = res["comp_mask"][i:i + 16].clone()
            mask[mask < 0.5] = 0.0
            rgb = rgb * mask + (1 - mask) * 1
            frames.append((rgb.clamp(0, 1) * 255).to(torch.uint8).cpu().numpy())
    frames = np.concatenate(frames, axis=0)
    write_video(frames, str(out_dir / "preview.mp4"), render_fps)
    picked = contact_sheet(frames, str(out_dir / "contact-sheet.jpg"))
    (out_dir / "frames").mkdir(exist_ok=True)
    for i in picked:
        Image.fromarray(frames[i]).save(out_dir / "frames" / f"frame-{i:04d}.png")
    side = Image.new("RGB", (1024, 512), "white")
    side.paste(Image.fromarray(vis_ref_img).resize((512, 512), Image.LANCZOS), (0, 0))
    side.paste(Image.fromarray(frames[0]).resize((512, 512), Image.LANCZOS), (512, 0))
    side.save(out_dir / "input-vs-render.jpg", quality=92)
    meter.stage("write preview video + contact sheet", t)

    # --- core_fn: enable_oac_file branch (ZIP for the chatting avatar / WebGL renderer) ------
    zip_report = None
    if not ARGS.no_zip:
        t = time.time()
        import tools.generateARKITGLBWithBlender as glb_tool
        from tools.generateARKITGLBWithBlender import generate_glb
        import patoolib

        assert os.path.exists(cfg.blender_path), f"Blender not found: {cfg.blender_path}"

        # LAM's Blender helper scripts catch their own errors and Blender still exits 0, so the
        # app can "succeed" with files missing from the ZIP. Show what Blender printed instead.
        blender_log = []

        class _Sub:
            CalledProcessError = subprocess.CalledProcessError

            @staticmethod
            def run(cmd, **kw):
                r = subprocess.run(cmd, **kw)
                tail = "\n".join(((r.stdout or "") + "\n" + (r.stderr or "")).strip().splitlines()[-25:])
                blender_log.append(f"$ {' '.join(map(str, cmd))}\n{tail}")
                return r

        glb_tool.subprocess = _Sub
        oac_dir = str(work / "oac" / name)
        os.makedirs(oac_dir, exist_ok=True)
        saved_head_path = lam.renderer.flame_model.save_shaped_mesh(shape_param.unsqueeze(0).cuda(), fd=oac_dir)
        res["cano_gs_lst"][0].save_ply(os.path.join(oac_dir, "offset.ply"), rgb2sh=False, offset2xyz=True)
        generate_glb(
            input_mesh=Path(saved_head_path),
            template_fbx=Path("./assets/sample_oac/template_file.fbx"),
            output_glb=Path(os.path.join(oac_dir, "skin.glb")),
            blender_exec=Path(cfg.blender_path))
        shutil.copy(src="./assets/sample_oac/animation.glb", dst=os.path.join(oac_dir, "animation.glb"))
        os.remove(saved_head_path)
        expected = ["skin.glb", "offset.ply", "animation.glb", "vertex_order.json"]
        missing_files = [f for f in expected if not os.path.isfile(os.path.join(oac_dir, f))]
        if missing_files:
            print("\n\n".join(blender_log))
            raise RuntimeError(f"export incomplete, missing from the avatar folder: {missing_files}")

        os.makedirs(os.path.dirname(ARGS.out_zip), exist_ok=True)
        tmp_zip = str(work / "oac" / (name + ".zip"))
        if os.path.exists(tmp_zip):
            os.remove(tmp_zip)
        original_cwd = os.getcwd()
        os.chdir(os.path.dirname(oac_dir))
        try:
            patoolib.create_archive(archive=tmp_zip, filenames=[name], verbosity=-1, program="zip")
        finally:
            os.chdir(original_cwd)
        shutil.copy(tmp_zip, ARGS.out_zip)

        import zipfile
        with zipfile.ZipFile(ARGS.out_zip) as z:
            zip_report = [{"name": i.filename, "bytes": i.file_size} for i in z.infolist()]
        print("ZIP written:", ARGS.out_zip)
        for e in zip_report:
            print(f"   {e['bytes']:>10}  {e['name']}")
        meter.stage("export ZIP (FBX SDK + Blender)", t)

    report = meter.summary()
    report.update({
        "image": ARGS.image, "out_zip": None if ARGS.no_zip else ARGS.out_zip, "zip_contents": zip_report,
        "motion": ARGS.motion, "frames": int(n), "gaussians": n_gs,
        "torch": torch.__version__, "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0),
    })
    with open(out_dir / "run-report.json", "w") as f:
        json.dump(report, f, indent=2)
    print("[report]", json.dumps({k: v for k, v in report.items() if k != "stages"}))
    print("DONE")


if __name__ == "__main__":
    main()
