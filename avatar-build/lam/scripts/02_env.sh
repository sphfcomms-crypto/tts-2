#!/usr/bin/env bash
# User-space toolchain for LAM on an RTX 50-series card: micromamba + Python 3.10 + CUDA 12.8 compiler.
# Nothing outside ~/lam is touched (no sudo, no apt, no shell start-up files).
set -eu
LAM_HOME="$HOME/lam"
export MAMBA_ROOT_PREFIX="$LAM_HOME/mamba"
mkdir -p "$LAM_HOME/bin" "$MAMBA_ROOT_PREFIX/home"
cd "$LAM_HOME"

if [ ! -x "$LAM_HOME/bin/micromamba" ]; then
  echo "[$(date +%H:%M:%S)] fetching micromamba"
  curl -Ls --fail https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C "$LAM_HOME" bin/micromamba
fi
"$LAM_HOME/bin/micromamba" --version

if [ ! -x "$LAM_HOME/env/bin/python" ]; then
  echo "[$(date +%H:%M:%S)] creating env"
  # --no-rc / explicit channels: do not read or write any user config.
  # HOME is redirected for this one command because micromamba otherwise leaves bookkeeping
  # stubs in the real home (~/.mamba, ~/.conda/environments.txt, ~/.cache/conda).
  HOME="$MAMBA_ROOT_PREFIX/home" "$LAM_HOME/bin/micromamba" create -y --no-rc -p "$LAM_HOME/env" \
      --override-channels -c nvidia/label/cuda-12.8.1 -c conda-forge \
      python=3.10 pip cuda-toolkit=12.8 ffmpeg zip unzip ninja cmake
fi
echo "[$(date +%H:%M:%S)] env ready"
"$LAM_HOME/env/bin/python" --version
"$LAM_HOME/env/bin/nvcc" --version | tail -2
echo "ENV DONE"
