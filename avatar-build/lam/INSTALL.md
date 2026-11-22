# LAM (Large Avatar Model) on this PC's RTX 5070, inside WSL

Installed 2026-11-22 in WSL2 `Ubuntu-22.04`, entirely under `~/lam` (`/home/rafay/lam`).
No sudo, no apt, no change to `.wslconfig`, `.bashrc` or any system setting. To remove it: `rm -rf ~/lam`.

It turns one head-and-shoulders picture into an animatable Gaussian-splat head and exports the ZIP
that `gaussian-splat-renderer-for-lam` (LAM_WebRender) loads in the browser.

## Use it

```bash
# inside WSL
~/lam/make_avatar.sh <image> <out.zip> [--out_dir DIR] [--motion NAME] [--max_frames N]

# from Windows (Git Bash / PowerShell)
wsl -d Ubuntu-22.04 -e bash -lc '~/lam/make_avatar.sh /mnt/c/Users/SPHF/openai-fm/avatar-build/video/call-still.png /mnt/c/Users/SPHF/openai-fm/public/avatar/head/avatar.zip --out_dir /mnt/c/Users/SPHF/openai-fm/avatar-build/lam/out'
```

- `<out.zip>` holds one folder (named after the ZIP) with `skin.glb`, `offset.ply`, `animation.glb`, `vertex_order.json`.
- `--out_dir` receives the model's own preview: `preview.mp4` (512x512, 30 fps, no audio), `contact-sheet.jpg`
  (8 frames), `frames/`, `input-cropped.png` (the 512x512 image the model was given), `input-tracked-1024.png`,
  `input-vs-render.jpg`, `run-report.json` (timings and memory). Default: `~/lam/work/<name>/out`.
- `--motion` picks the driving motion for the preview only (a folder of `~/lam/LAM/assets/sample_motion/export`,
  default `Look_In_My_Eyes`, first 300 frames). It does not change the exported avatar.
- Windows paths (`C:\...`) are accepted for both arguments.
- When starting it from a `wsl ... -lc` one-liner in the background, use `setsid nohup ... &` and let the
  shell live a second or two (`sleep 2`): a plain `nohup ... &` gets SIGHUP when `wsl.exe` returns.

Measured on this PC (RTX 5070 12 GB, WSL limited to 7.4 GB RAM), 300-frame preview:

| | |
|---|---|
| Whole run with ZIP export | 70 to 105 s (the FBX + Blender export alone is 38 to 68 s of that) |
| Whole run without export (`--no_zip`) | 25 to 32 s |
| of which: load tracking models 5-7 s, face tracking 11-27 s, load LAM-20K 4-10 s, LAM inference + 300 frames 4 s | |
| RAM, peak of the process (RSS) | 5.1 to 5.4 GB; about 3.0 GB steady. Part of the peak is the memory-mapped weight file, which the kernel can drop |
| RAM still available on the system at the worst moment | 3.9 GB of 7.4 GB, swap practically unused (0 to 17 MB) |
| Same, loading the model the app's way (`--plain_load`) | RSS peak 5.3 to 6.8 GB, about 2.2 GB still available, up to 0.4 GB swapped in one run |
| GPU memory, PyTorch peak | 5.4 GB with a 300-frame preview, 3.4 GB with a 76-frame one |
| GPU memory, whole card peak | 7.3 GB (includes about 1.3 GB the Windows desktop already held) |

## Versions that ended up installed

| | |
|---|---|
| GPU / driver | NVIDIA GeForce RTX 5070, driver 621.14, seen from WSL2 |
| Python | 3.10.22 (conda-forge, in `~/lam/env`) |
| CUDA compiler | cuda-toolkit 12.8.1 (nvcc 12.8.93) from the `nvidia/label/cuda-12.8.1` conda channel |
| Host compiler | Ubuntu's own gcc/g++ 11.4.0 |
| PyTorch | torch 2.7.1+cu128, torchvision 0.22.1+cu128 (cuDNN 9.7.1.26) |
| Built from source | pytorch3d 0.7.9 @ `ddfc551`, diff-gaussian-rasterization (ashawkey) @ `8829d14` with glm @ `5c46b9c`, nvdiffrast 0.3.3 (ShenhanQian, branch `backface-culling`) @ `2271858` |
| Key Python packages | numpy 1.23.0, scipy 1.13.1, transformers 4.41.2, diffusers 0.31.0, accelerate 1.2.1, huggingface_hub 0.23.2, safetensors 0.8.0, tyro 1.0.17, opencv-python-headless 4.11.0.86, scikit-image 0.20.0, trimesh 4.4.9, moviepy 1.0.3, chumpy 0.70, tensorboard 2.21.0, patool 4.0.1, fbx 2020.3.4 |
| LAM | github.com/aigc3d/LAM @ `3395736` (2026-06-10), weights `3DAIGC/LAM-20K` (`model.safetensors`, 2.36 GB), assets `3DAIGC/LAM-assets` |
| Blender | 4.0.2 Linux x64 (the version LAM's export guide names), runs with the libraries Ubuntu already has |
| Other tools in the env | micromamba 2.10.0, ffmpeg 9.0.2, zip 3.0, ninja 1.13.2, cmake 4.5.1 |

Exact lists: `scripts/pip-freeze.txt` and `scripts/conda-env.yml`.

## Install, in order

All scripts are in `avatar-build\lam\scripts\` (copies run from `~/lam/scripts/`). Each one is safe to run again.

```bash
wsl -d Ubuntu-22.04          # everything below is typed inside WSL

# 0. folders, LAM itself, the scripts
mkdir -p ~/lam/scripts ~/lam/logs && cd ~/lam
git clone --depth 1 https://github.com/aigc3d/LAM.git
git clone --depth 1 https://github.com/aigc3d/LAM_WebRender.git      # only for its sample ZIP, to compare layouts
W=/mnt/c/Users/SPHF/openai-fm/avatar-build/lam
cp $W/scripts/* ~/lam/scripts/ && cp $W/make_avatar.sh ~/lam/ && chmod +x ~/lam/make_avatar.sh
sed -i 's/\r$//' ~/lam/scripts/* ~/lam/make_avatar.sh                  # in case Windows added CR line ends

# 1. downloads (3.9 GB): weights, assets, Blender, FBX wheel, export template
bash ~/lam/scripts/01_download.sh
bash ~/lam/scripts/01b_unpack.sh

# 2. micromamba + Python 3.10 + CUDA 12.8 toolkit + ffmpeg/zip/ninja/cmake  (2 GB download, 14 GB on disk)
bash ~/lam/scripts/02_env.sh

# 3. torch 2.7.1+cu128, the Python requirements, chumpy, the FBX wheel   (about 4 GB download)
bash ~/lam/scripts/03_pip.sh

# 4. build pytorch3d, diff-gaussian-rasterization, nvdiffrast, FaceBoxes NMS; then a GPU smoke test
bash ~/lam/scripts/04_build.sh          # pytorch3d takes about 4 minutes with MAX_JOBS=3

# 5. make an avatar
~/lam/make_avatar.sh /mnt/c/Users/SPHF/openai-fm/avatar-build/video/call-still.png ~/lam/runs/test/avatar.zip
```

Steps 1 to 4 took about 17 minutes here, most of it download time. `~/lam` is about 25 GB afterwards
(env 14 GB, micromamba package cache up to 8 GB partly shared with it, repo + weights 3.5 GB, Blender 1.3 GB).
Optional space back (not done): `rm -r ~/lam/downloads ~/lam/cache/pip` (3 GB) and
`MAMBA_ROOT_PREFIX=~/lam/mamba ~/lam/bin/micromamba clean --all --yes --no-rc`.

What each script does:

| script | what |
|---|---|
| `activate.sh` | sourced by all others: puts `~/lam/env/bin` on PATH for that shell only, sets `CUDA_HOME`, keeps every cache and temp file under `~/lam`, and sets the three switches described below |
| `01_download.sh` | `curl` from huggingface.co/3DAIGC (`LAM-20K/model.safetensors`, `config.json`; `LAM-assets/LAM_assets.tar`, `thirdparty_models.tar`), download.blender.org (`blender-4.0.2-linux-x64.tar.xz`) and the two files LAM's `tools/AVATAR_EXPORT_GUIDE.md` names on Alibaba OSS (`fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl`, `sample_oac.tar`) |
| `01b_unpack.sh` | untars assets and `model_zoo/` into the repo, `sample_oac` into `assets/`, Blender into `~/lam/blender` |
| `02_env.sh` | fetches micromamba from micro.mamba.pm into `~/lam/bin`, creates `~/lam/env` with `python=3.10 pip cuda-toolkit=12.8 ffmpeg zip unzip ninja cmake` from `nvidia/label/cuda-12.8.1` + `conda-forge` |
| `03_pip.sh` | `pip install torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128`, then `requirements-5070.txt`, `pip install --no-build-isolation chumpy==0.70`, the FBX wheel |
| `04_build.sh` | clones the three extension repos into `~/lam/src` and `pip install --no-build-isolation --no-deps` each; runs LAM's FaceBoxes `build.py build_ext --inplace`; runs `check_build.py` |
| `lam_avatar.py` | the actual avatar build (what `make_avatar.sh` calls) |
| `compare_runs.py` | compares two runs, or an exported ZIP against LAM_WebRender's `p2-1.zip` |
| `make_variants.py`, `run_variants.sh` | the two input variations that were tried |

## What had to change from LAM's own instructions, and why

LAM's `scripts/install/install_cu121.sh` is: torch 2.3.0+cu121, xformers 0.0.26, `pip install -r requirements.txt`, FaceBoxes `make.sh`.

1. **torch 2.3.0+cu121 -> torch 2.7.1+cu128.** An RTX 50-series card (sm_120) needs a CUDA 12.8 build of PyTorch.
2. **CUDA compiler without root.** There are no wheels of pytorch3d / diff-gaussian-rasterization / nvdiffrast
   for torch 2.7 + cu128, so they are compiled here. The compiler comes from micromamba (`cuda-toolkit=12.8`);
   Ubuntu's gcc 11.4 is the host compiler. Two things needed care:
   - `CUDA_HOME` must be `~/lam/env` (so `nvcc` is `env/bin/nvcc`, next to its `nvcc.profile`). With
     `CUDA_HOME=env/targets/x86_64-linux` the build dies with `sh: 1: cicc: not found`. The CUDA headers are only
     under `targets/x86_64-linux/include`, so that folder is added through `CPATH`.
   - 7 GB of RAM: `MAX_JOBS=3` for the pytorch3d build.
   - pip no longer runs old-style `setup.py` projects outside an isolated build env, where `torch` is missing:
     all three (and chumpy) are installed with `--no-build-isolation`.
3. **requirements trimmed to what the single-image pipeline imports** (`requirements-5070.txt`):
   - dropped `tensorflow==2.12.0`, `face-detection-tflite`, `jaxlib` (only used for iris landmarks, which
     `app_lam.py` switches off), `xformers` (LAM's DINOv2 falls back to plain attention), `simple-knn`
     (never imported), `gradio` (the model is run from a script), `rembg`;
   - added `tensorboard` (the VHAP tracker imports `torch.utils.tensorboard`; LAM got it through tensorflow),
     `seaborn`, `iopath`, `patool`, `imageio-ffmpeg`;
   - `scipy==1.13.1` pinned: LAM's landmark code imports `scipy.integrate.simps`, removed in scipy 1.14;
   - `diffusers==0.31.0`, `accelerate==1.2.1` pinned so they accept LAM's `huggingface_hub==0.23.2`;
   - `numpy==1.23.0`, `transformers==4.41.2` and the other pins are LAM's own and work with torch 2.7.1.
4. **Three run-time switches** (set in `activate.sh`):
   - `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1`: since torch 2.6 `torch.load` refuses pickled objects by default; LAM's
     own tracking models (`vgg_heads_l.trcd`, `68_keypoints_model.pkl`) need the old behaviour.
   - `TORCHDYNAMO_DISABLE=1`: LAM decorates the DINOv2 encoder with `@torch.compile`; the JIT would cost minutes
     and several GB of RAM for a one-shot run. Same maths, plain eager execution.
   - `HF_HUB_OFFLINE=1`: nothing is fetched at run time.
5. **The Gradio page is not used.** `app_lam.py`'s per-image function (`core_fn`) is a closure inside the UI
   builder, so `lam_avatar.py` calls what it calls, in the same order with the same arguments:
   `FlameTrackingSingleImage.preprocess / optimize / export`, `preprocess_image`, `prepare_motion_seqs`,
   `ModelLAM.infer_single_view`, `flame_model.save_shaped_mesh`, `cano_gs_lst[0].save_ply`,
   `tools.generateARKITGLBWithBlender.generate_glb`, then `zip`. Differences, all for the 7 GB of RAM:
   - tracking models are freed before LAM-20K is loaded;
   - the network is built weightless (`accelerate.init_empty_weights`) and the checkpoint is read straight
     onto the GPU, which cut peak RAM by about 2.4 GB (`--plain_load` does it exactly as the app). Checked:
     the four exported files are byte-identical either way, preview frames differ by at most 1/255;
   - LAM's DINOv2 wrapper would first download Meta's pretrained ViT-L (1.1 GB, from dl.fbaipublicfiles.com)
     and then overwrite it with the LAM checkpoint. It is built without that download; the script checks that
     the checkpoint covers every encoder weight (835 of 836 model tensors come from the checkpoint; the one
     left, `renderer.flame_model.J_regressor_up`, is computed from the FLAME files);
   - the preview renders the first `--max_frames` (300) frames of the motion, and has no audio.
6. **Two bugs in LAM's export path that the script works around:**
   - Blender resolves `--python tools/convertFBX2GLB.py` against `$PWD`, not the process's working directory.
     `lam_avatar.py` sets `PWD` to the repo; otherwise Blender cannot find the helper scripts.
   - Blender exits 0 even when a helper script fails, so `app_lam.py` can hand back a ZIP with only
     `offset.ply` and `animation.glb`. `lam_avatar.py` checks that all four files exist and prints Blender's
     output if not.

## Honest notes on this install

- The scripts were run step by step and fixed along the way (the `CUDA_HOME` fix, `tensorboard`, `scipy`), so
  the final versions of `01`-`04` have each been run successfully, but not once more from an empty `~/lam`.
  `tensorboard` was installed by hand (`pip install tensorboard`) and then added to `requirements-5070.txt`.
- `02_env.sh` now runs micromamba with `HOME` pointed inside `~/lam/mamba/home`, because the first run left
  small bookkeeping stubs in the real home (`~/.mamba`, `~/.conda/environments.txt`, `~/.cache/conda`); those
  stubs were deleted, and the redirect was tested on a throwaway env.
- Early runs (before `activate.sh` set `CUDA_CACHE_PATH`) let the NVIDIA driver add about 120 small kernel-cache
  files to the already existing `~/.nv/ComputeCache`. They are harmless and were left alone, since they cannot be
  told apart from entries of other CUDA programs. Runs now write that cache to `~/lam/cache/nv`.
- `python app_lam.py` (the Gradio page) will not start in this env: gradio is not installed.

## Layout of ~/lam

```
~/lam/make_avatar.sh     the command
~/lam/scripts/           install + run scripts (same files as avatar-build\lam\scripts)
~/lam/LAM/               the repo, with model_zoo/ (weights, tracking models, FLAME) and assets/
~/lam/LAM_WebRender/     reference renderer repo (sample avatar asset/arkit/p2-1.zip)
~/lam/env/               Python 3.10 + CUDA 12.8 toolkit + all packages
~/lam/bin/micromamba, ~/lam/mamba/   micromamba and its package cache
~/lam/blender/           Blender 4.0.2
~/lam/src/               pytorch3d, diff-gaussian-rasterization, nvdiffrast sources
~/lam/downloads/         the original tarballs / wheel
~/lam/cache/, ~/lam/tmp/ pip, torch-extension, NVIDIA kernel caches; temp files
~/lam/work/              scratch per run (tracking output, export folder)
~/lam/runs/, ~/lam/inputs/, ~/lam/logs/   test runs, input variations, logs of the install and runs
```
