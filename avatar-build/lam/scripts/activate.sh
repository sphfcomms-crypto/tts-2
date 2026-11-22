# Source this file (do not run it): it puts the LAM environment on PATH for the current shell only.
# Everything lives under ~/lam; no shell start-up file is touched.
export LAM_HOME="$HOME/lam"
export PATH="$LAM_HOME/env/bin:$PATH"
# CUDA 12.8 toolkit from the nvidia conda channel. nvcc must be called as env/bin/nvcc (its
# nvcc.profile sits next to it; the symlink under targets/ cannot find cicc), while the CUDA
# headers live under targets/x86_64-linux/include, so point the host compiler at them via CPATH.
export CUDA_HOME="$LAM_HOME/env"
export CUDA_PATH="$CUDA_HOME"
export CPATH="$LAM_HOME/env/targets/x86_64-linux/include${CPATH:+:$CPATH}"
export LIBRARY_PATH="$LAM_HOME/env/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
# keep caches inside ~/lam and ignore anything in ~/.local or user pip config
export PYTHONNOUSERSITE=1
export PIP_CONFIG_FILE=/dev/null
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_CACHE_DIR="$LAM_HOME/cache/pip"
export HF_HOME="$LAM_HOME/cache/huggingface"
export TORCH_HOME="$LAM_HOME/cache/torch"
export TORCH_EXTENSIONS_DIR="$LAM_HOME/cache/torch_extensions"
export MPLCONFIGDIR="$LAM_HOME/cache/matplotlib"
export XDG_CACHE_HOME="$LAM_HOME/cache/xdg"
export NUMBA_CACHE_DIR="$LAM_HOME/cache/numba"
# the NVIDIA driver's kernel cache (default ~/.nv), Blender/PulseAudio config (default ~/.config)
# and compiler temp files (default /tmp) also stay inside ~/lam
export CUDA_CACHE_PATH="$LAM_HOME/cache/nv"
export XDG_CONFIG_HOME="$LAM_HOME/cache/xdg-config"
export TMPDIR="$LAM_HOME/tmp"
mkdir -p "$TMPDIR" "$XDG_CONFIG_HOME"
# never reach out to the Hugging Face hub at run time: every weight is a local file
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
# LAM decorates the DINOv2 encoder with @torch.compile; the JIT needs several GB of RAM and
# minutes of compile time for no gain on a one-shot run, so run the plain eager code instead.
export TORCHDYNAMO_DISABLE=1
# LAM was written for torch 2.3, where torch.load unpickled whole objects by default. Its own
# tracking models (vgg_heads_l.trcd is a TorchScript archive, 68_keypoints_model.pkl a pickled
# checkpoint) need that behaviour back on torch >= 2.6. Only LAM's own files are ever loaded.
export TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1
# build settings for the compiled extensions (7 GB of RAM: keep parallel compile jobs low)
export FORCE_CUDA=1
export MAX_JOBS=3
mkdir -p "$LAM_HOME/cache"
